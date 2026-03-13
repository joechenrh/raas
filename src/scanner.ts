import path from 'node:path';
import type { Config } from './config.js';
import type { GitHubClient } from './github.js';
import { runCodexReview, type FollowupReviewMetadata } from './reviewer.js';
import type { Storage } from './db.js';
import { getTidbReviewGate, isTidbRepo } from './tidb-review-gate.js';

let activeReviews = 0;
let isScanning = false;
let isProcessingQueue = false;
let nextScanAt: string | null = null;
let scanIntervalSeconds: number | null = null;
const failureCount = new Map<string, number>();  // repo#number -> consecutive failures
const MAX_RETRIES_PER_SCAN = 3;
const NO_GO_CHANGES_STATUS = 'no-go-changes';
const NO_GO_CHANGES_MESSAGE = 'No .go file changes in PR';

function log(msg: string, data?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  if (data) {
    console.log(`[${ts}] [scanner] ${msg}`, JSON.stringify(data));
  } else {
    console.log(`[${ts}] [scanner] ${msg}`);
  }
}

function parseRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split('/');
  return { owner, repo };
}

function parseFollowupMetadata(raw: string | null): FollowupReviewMetadata | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as FollowupReviewMetadata;
  } catch {
    return undefined;
  }
}

async function hasGoChangesOrMarkSkipped(
  storage: Storage,
  github: GitHubClient,
  details: { prId: number; owner: string; repo: string; repoFullName: string; number: number },
): Promise<boolean> {
  const hasGoChanges = await github.hasGoChanges(details.owner, details.repo, details.number);
  if (!hasGoChanges) {
    storage.updatePRStatus(details.prId, NO_GO_CHANGES_STATUS);
    log(`Skipping review for ${details.repoFullName}#${details.number}: ${NO_GO_CHANGES_MESSAGE.toLowerCase()}`);
  }
  return hasGoChanges;
}

export async function scan(config: Config, storage: Storage, github: GitHubClient) {
  if (isScanning) {
    log('Scan already in progress, skipping');
    return;
  }
  isScanning = true;
  const scanId = storage.createScanLog();
  let prsFound = 0;
  let reviewsTriggered = 0;
  const errors: string[] = [];

  try {
    const monitoredUsers = new Set(config.monitor.users.map((u) => u.toLowerCase()));

    // Debug mode: build a set of "repo#number" for fast lookup
    const debugPRSet = new Set(
      config.debug.enabled ? config.debug.prs.map((p) => `${p.repo}#${p.number}`) : [],
    );
    if (config.debug.enabled) {
      log(`DEBUG MODE: only processing PRs: ${[...debugPRSet].join(', ')}`);
    }

    for (const repoFullName of config.monitor.repos) {
      const { owner, repo } = parseRepo(repoFullName);

      try {
        const openPRs = await github.listOpenPRs(owner, repo);

        for (const pr of openPRs) {
          const existing = storage.getPR(repoFullName, pr.number);
          const hasApprovedLabel = pr.labels.some((label) => label.toLowerCase() === 'approved');

          // Debug mode: skip PRs not in the debug list
          if (config.debug.enabled && !debugPRSet.has(`${repoFullName}#${pr.number}`)) {
            continue;
          }

          if (!existing) {
            // Skip PRs created before the configured cutoff time
            if (config.monitor.ignore_before && pr.created_at < config.monitor.ignore_before) {
              continue;
            }

            // Skip PRs not targeting master/main
            if (pr.base_branch !== 'master' && pr.base_branch !== 'main') {
              continue;
            }

            // Skip PRs with [DNM] prefix in title
            if (pr.title.startsWith('[DNM]')) {
              continue;
            }

            // Normal mode: filter by configured users (if any configured)
            if (!config.debug.enabled && monitoredUsers.size > 0 && !monitoredUsers.has(pr.author.toLowerCase())) {
              continue;
            }
          }

          // Track PRs with an explicit approved label, but do not trigger review work for them.
          if (hasApprovedLabel) {
            const tracked = storage.upsertPR({
              repo: repoFullName,
              number: pr.number,
              title: pr.title,
              author: pr.author,
              head_sha: pr.head_sha,
              state: pr.state,
            });
            storage.updatePRStatus(tracked.id, 'approved');
            continue;
          }

          prsFound++;

          if (!existing) {
            // New PR detected
            const inserted = storage.upsertPR({
              repo: repoFullName,
              number: pr.number,
              title: pr.title,
              author: pr.author,
              head_sha: pr.head_sha,
              state: pr.state,
            });
            const hasGoChanges = await hasGoChangesOrMarkSkipped(storage, github, {
              prId: inserted.id,
              owner,
              repo,
              repoFullName,
              number: pr.number,
            });
            if (!hasGoChanges) {
              continue;
            }

            if (isTidbRepo(repoFullName)) {
              const gate = await getTidbReviewGate(github, owner, repo, pr.number);
              if (gate.state === 'ready') {
                storage.updatePRStatus(inserted.id, 'pending');
                storage.createReviewRun(inserted.id, 'initial', `TiDB CI gate passed: ${gate.reason}`);
                reviewsTriggered++;
                log(`New TiDB PR ready for review: ${repoFullName}#${pr.number}`, { gate: gate.reason });
              } else if (gate.state === 'waiting-ci') {
                storage.updatePRStatus(inserted.id, 'waiting-ci');
                log(`New TiDB PR waiting for CI gate: ${repoFullName}#${pr.number}`, { gate: gate.reason });
              } else {
                storage.updatePRStatus(inserted.id, 'ci-fetch-error');
                log(`New TiDB PR could not fetch CI gate: ${repoFullName}#${pr.number}`, { gate: gate.reason });
              }
            } else {
              storage.createReviewRun(inserted.id, 'initial', 'New PR detected');
              reviewsTriggered++;
              log(`New PR: ${repoFullName}#${pr.number} "${pr.title}" by ${pr.author}`);
            }
          } else if (existing.head_sha !== pr.head_sha) {
            // New commits pushed
            const tracked = storage.upsertPR({
              repo: repoFullName,
              number: pr.number,
              title: pr.title,
              author: pr.author,
              head_sha: pr.head_sha,
              state: pr.state,
            });
            const hasGoChanges = await hasGoChangesOrMarkSkipped(storage, github, {
              prId: tracked.id,
              owner,
              repo,
              repoFullName,
              number: pr.number,
            });
            if (!hasGoChanges) {
              continue;
            }

            if (isTidbRepo(repoFullName)) {
              if (storage.hasPrimaryReviewRun(existing.id)) {
                log(`Skipping retrigger for TiDB PR after new commits: ${repoFullName}#${pr.number}`);
              } else {
                const gate = await getTidbReviewGate(github, owner, repo, pr.number);
                if (gate.state === 'ready') {
                  storage.updatePRStatus(existing.id, 'pending');
                  storage.createReviewRun(existing.id, 'initial', `TiDB CI gate passed after new commits: ${gate.reason}`);
                  reviewsTriggered++;
                  log(`TiDB PR passed CI gate after new commits: ${repoFullName}#${pr.number}`, { gate: gate.reason });
                } else if (gate.state === 'waiting-ci') {
                  storage.updatePRStatus(existing.id, 'waiting-ci');
                  log(`TiDB PR still waiting for CI gate after new commits: ${repoFullName}#${pr.number}`, { gate: gate.reason });
                } else {
                  storage.updatePRStatus(existing.id, 'ci-fetch-error');
                  log(`TiDB PR could not fetch CI gate after new commits: ${repoFullName}#${pr.number}`, { gate: gate.reason });
                }
              }
            } else if (existing.review_status !== 'reviewing') {
              storage.updatePRStatus(existing.id, 'pending');
              storage.createReviewRun(existing.id, 'recheck', 'New commits pushed');
              reviewsTriggered++;
              log(`New commits on: ${repoFullName}#${pr.number}`);
            }
          } else if (isTidbRepo(repoFullName) && (existing.review_status === 'waiting-ci' || existing.review_status === 'ci-fetch-error')) {
            const hasGoChanges = await hasGoChangesOrMarkSkipped(storage, github, {
              prId: existing.id,
              owner,
              repo,
              repoFullName,
              number: pr.number,
            });
            if (!hasGoChanges) {
              continue;
            }

            const gate = await getTidbReviewGate(github, owner, repo, pr.number);
            if (gate.state === 'ready') {
              storage.updatePRStatus(existing.id, 'pending');
              storage.createReviewRun(existing.id, 'initial', `TiDB CI gate passed: ${gate.reason}`);
              reviewsTriggered++;
              log(`TiDB PR passed CI gate: ${repoFullName}#${pr.number}`, { gate: gate.reason });
            } else if (gate.state === 'waiting-ci') {
              storage.updatePRStatus(existing.id, 'waiting-ci');
              log(`TiDB PR still waiting for CI gate: ${repoFullName}#${pr.number}`, { gate: gate.reason });
            } else {
              storage.updatePRStatus(existing.id, 'ci-fetch-error');
              log(`TiDB PR could not fetch CI gate: ${repoFullName}#${pr.number}`, { gate: gate.reason });
            }
          } else if (existing.review_status === 'failed' || existing.review_status === 'pending') {
            const hasGoChanges = await hasGoChangesOrMarkSkipped(storage, github, {
              prId: existing.id,
              owner,
              repo,
              repoFullName,
              number: pr.number,
            });
            if (!hasGoChanges) {
              continue;
            }

            if (isTidbRepo(repoFullName) && storage.hasPrimaryReviewRun(existing.id)) {
              log(`Skipping retry for TiDB PR: ${repoFullName}#${pr.number} (one-shot review policy)`);
              continue;
            }
            // Retry failed/pending reviews with exponential backoff
            const key = `${repoFullName}#${pr.number}`;
            const failures = failureCount.get(key) || 0;
            const backoffScans = Math.min(2 ** failures, 32); // 1, 2, 4, 8, 16, 32 scans between retries
            if (failures >= MAX_RETRIES_PER_SCAN && failures % backoffScans !== 0) {
              // Skip this retry cycle (backoff)
              continue;
            }
            storage.updatePRStatus(existing.id, 'pending');
            storage.createReviewRun(existing.id, 'recheck', existing.review_status === 'failed' ? 'Retrying after failure' : 'Retrying stuck pending');
            reviewsTriggered++;
            log(`Retrying ${existing.review_status} PR: ${repoFullName}#${pr.number} (attempt ${failures + 1})`);
          } else if (config.monitor.followup_enabled && existing.review_status === 'reviewed' && existing.unresolved_count > 0) {
            // Check for new replies on unresolved threads
            try {
              const sinceTime = existing.last_reviewed_at || existing.created_at;
              const followup = await github.getFollowupTargets(owner, repo, pr.number, sinceTime);
              if (followup.targets.length > 0) {
                storage.updatePRStatus(existing.id, 'pending');
                storage.createReviewRun(
                  existing.id,
                  'followup',
                  'Author replied to review comments',
                  JSON.stringify(followup),
                );
                reviewsTriggered++;
                log(`New replies on: ${repoFullName}#${pr.number}`, {
                  botUser: followup.botUser,
                  targets: followup.targets.map((target) => ({
                    parentCommentId: target.parentCommentId,
                    replyCommentId: target.replyCommentId,
                  })),
                });
              }
            } catch (err: any) {
              errors.push(`Reply check failed for ${repoFullName}#${pr.number}: ${err.message}`);
            }
          } else {
            // Update title/state if changed
            storage.upsertPR({
              repo: repoFullName,
              number: pr.number,
              title: pr.title,
              author: pr.author,
              head_sha: pr.head_sha,
              state: pr.state,
            });
          }
        }

        // Detect closed/merged PRs
        const trackedOpen = storage.getOpenPRs().filter((p) => p.repo === repoFullName);
        const openNumbers = new Set(openPRs.map((p) => p.number));
        for (const tracked of trackedOpen) {
          if (!openNumbers.has(tracked.number)) {
            try {
              const { state, merged } = await github.getPRState(owner, repo, tracked.number);
              storage.updatePRState(tracked.id, merged ? 'merged' : state);
              log(`PR closed: ${repoFullName}#${tracked.number} -> ${merged ? 'merged' : state}`);
            } catch {
              storage.updatePRState(tracked.id, 'closed');
            }
          }
        }
      } catch (err: any) {
        errors.push(`Scan ${repoFullName} failed: ${err.message}`);
        log(`Error scanning ${repoFullName}: ${err.message}`);
      }
    }

    // Sync comment counts for all open PRs
    const allOpenPRs = storage.getOpenPRs();
    for (const pr of allOpenPRs) {
      try {
        const { owner, repo } = parseRepo(pr.repo);
        const { totalComments, unresolvedCount } = await github.getReviewThreads(owner, repo, pr.number);
        storage.updatePRCommentCounts(pr.id, totalComments, unresolvedCount);
      } catch {
        // Silently skip comment sync errors
      }
    }

    // Process pending review runs
    await processReviewQueue(config, storage, github);
  } catch (err: any) {
    errors.push(`Scan error: ${err.message}`);
    log(`Scan error: ${err.message}`);
  } finally {
    log(`Scan complete: ${prsFound} PRs found, ${reviewsTriggered} reviews triggered${errors.length > 0 ? `, ${errors.length} errors` : ''}`);
    storage.completeScanLog(scanId, prsFound, reviewsTriggered, errors.length > 0 ? errors.join('; ') : undefined);
    isScanning = false;
  }
}

export async function processReviewQueue(config: Config, storage: Storage, github: GitHubClient) {
  if (isProcessingQueue) {
    return;
  }
  isProcessingQueue = true;

  try {
    while (true) {
      if (activeReviews >= config.reviewer.max_concurrent) {
        log(`Concurrency limit reached (${activeReviews}/${config.reviewer.max_concurrent}), remaining queued`);
        break;
      }
      const [run] = storage.getPendingReviewRuns();
      if (!run) {
        break;
      }

      try {
        const { owner, repo } = parseRepo(run.repo);
        const hasGoChanges = await github.hasGoChanges(owner, repo, run.pr_number);
        if (!hasGoChanges) {
          storage.updateReviewRun(run.id, {
            status: 'failed',
            completed_at: new Date().toISOString(),
            error: `Skipped: ${NO_GO_CHANGES_MESSAGE}`,
          });
          storage.updatePRStatus(run.pr_id, NO_GO_CHANGES_STATUS);
          log(`Skipping queued review for ${run.repo}#${run.pr_number}: ${NO_GO_CHANGES_MESSAGE.toLowerCase()}`);
          continue;
        }
      } catch (err: any) {
        log(`Go file preflight check failed for ${run.repo}#${run.pr_number}, continuing with review`, {
          error: err?.message || String(err),
        });
      }

      activeReviews++;
      const startedAt = new Date().toISOString();
      storage.updateReviewRun(run.id, { status: 'running', started_at: startedAt });
      storage.updatePRStatus(run.pr_id, 'reviewing');

      log(`Starting ${run.type} review: ${run.repo}#${run.pr_number}`);

      // Dry-run mode: skip codex invocation
      if (config.debug.dry_run) {
        log(`DRY RUN: would invoke codex for ${run.repo}#${run.pr_number} (${run.type})`);
        storage.updateReviewRun(run.id, {
          status: 'completed',
          completed_at: new Date().toISOString(),
          duration_ms: 0,
          exit_code: 0,
        });
        storage.updatePRStatus(run.pr_id, 'reviewed');
        activeReviews--;
        continue;
      }

      // Run review synchronously — block scan until review completes
      try {
        const followupMetadata = run.type === 'followup' ? parseFollowupMetadata(run.metadata) : undefined;
        const result = await runCodexReview(config, run.type as 'initial' | 'followup' | 'recheck', {
          repo: run.repo,
          number: run.pr_number,
          title: run.title,
          author: run.pr_author,
          followupMetadata,
        });

        const completedAt = new Date().toISOString();
        const orchestrationSucceeded = result.executionStatus
          ? result.executionStatus === 'success'
          : true;
        const status = result.exitCode === 0 && orchestrationSucceeded ? 'completed' : 'failed';
        const failureDetail = result.executionStatus && result.executionStatus !== 'success'
          ? `Orchestration ${result.executionStatus}${result.executionReason ? `: ${result.executionReason}` : ''}`
          : undefined;

        storage.updateReviewRun(run.id, {
          status,
          completed_at: completedAt,
          duration_ms: result.durationMs,
          exit_code: result.exitCode,
          error: status === 'failed'
            ? `${failureDetail ? `${failureDetail}. ` : ''}See log: ${path.basename(result.logFile)}`
            : undefined,
        });
        storage.updatePRStatus(run.pr_id, status === 'completed' ? 'reviewed' : 'failed');

        // Sync comment counts after review completes
        try {
          const { owner, repo } = parseRepo(run.repo);
          const { totalComments, unresolvedCount } = await github.getReviewThreads(owner, repo, run.pr_number);
          storage.updatePRCommentCounts(run.pr_id, totalComments, unresolvedCount);
        } catch {
          // ignore
        }

        const key = `${run.repo}#${run.pr_number}`;
        if (status === 'completed') {
          failureCount.delete(key);
        } else {
          failureCount.set(key, (failureCount.get(key) || 0) + 1);
        }

        log(`Review ${status}: ${run.repo}#${run.pr_number} (${result.durationMs}ms, exit ${result.exitCode})`);
        log(`Log file: ${result.logFile}`);
      } catch (err: any) {
        storage.updateReviewRun(run.id, {
          status: 'failed',
          completed_at: new Date().toISOString(),
          error: err.message,
        });
        storage.updatePRStatus(run.pr_id, 'failed');
        const key = `${run.repo}#${run.pr_number}`;
        failureCount.set(key, (failureCount.get(key) || 0) + 1);
        log(`Review error: ${run.repo}#${run.pr_number}: ${err.message}`);
      } finally {
        activeReviews--;
      }
    }
  } finally {
    isProcessingQueue = false;
  }
}

export function getScannerStatus(): {
  is_scanning: boolean;
  next_scan_at: string | null;
  scan_interval_seconds: number | null;
} {
  return {
    is_scanning: isScanning,
    next_scan_at: nextScanAt,
    scan_interval_seconds: scanIntervalSeconds,
  };
}

export function startScanner(config: Config, storage: Storage, github: GitHubClient): ReturnType<typeof setInterval> {
  storage.resetOrphanedReviews();
  scanIntervalSeconds = config.monitor.scan_interval_seconds;

  if (config.debug.enabled) {
    log('DEBUG MODE enabled');
    if (config.debug.dry_run) log('DRY RUN: codex will NOT be invoked');
    if (config.debug.skip_scan_interval) log('Single scan mode: no periodic scanning');
    log(`Debug PRs: ${config.debug.prs.map((p) => `${p.repo}#${p.number}`).join(', ')}`);
  }

  log(`Starting scanner (interval: ${config.monitor.scan_interval_seconds}s)`);
  log(`Monitoring repos: ${config.monitor.repos.join(', ')}`);
  log(`Monitoring users: ${config.monitor.users.join(', ')}`);
  log(`Follow-up automation: ${config.monitor.followup_enabled ? 'enabled' : 'disabled'}`);

  // Run initial scan
  scan(config, storage, github);

  // In debug mode with skip_scan_interval, don't set up periodic scanning
  if (config.debug.enabled && config.debug.skip_scan_interval) {
    nextScanAt = null;
    log('Periodic scanning disabled (debug.skip_scan_interval=true)');
    // Return a dummy interval that does nothing
    return setInterval(() => {}, 2_147_483_647);
  }

  // Schedule periodic scans
  const intervalMs = config.monitor.scan_interval_seconds * 1000;
  nextScanAt = new Date(Date.now() + intervalMs).toISOString();
  return setInterval(() => {
    nextScanAt = new Date(Date.now() + intervalMs).toISOString();
    void scan(config, storage, github);
  }, intervalMs);
}
