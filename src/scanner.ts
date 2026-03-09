import type Database from 'better-sqlite3';
import type { Config } from './config.js';
import type { GitHubClient } from './github.js';
import { runCodexReview } from './reviewer.js';
import * as db from './db.js';

let activeReviews = 0;
let isScanning = false;
const failureCount = new Map<string, number>();  // repo#number -> consecutive failures
const MAX_RETRIES_PER_SCAN = 3;

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

export async function scan(config: Config, database: Database.Database, github: GitHubClient) {
  if (isScanning) {
    log('Scan already in progress, skipping');
    return;
  }
  isScanning = true;
  const scanId = db.createScanLog(database);
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
          // Debug mode: skip PRs not in the debug list
          if (config.debug.enabled && !debugPRSet.has(`${repoFullName}#${pr.number}`)) {
            continue;
          }

          // Normal mode: filter by configured users (if any configured)
          if (!config.debug.enabled && monitoredUsers.size > 0 && !monitoredUsers.has(pr.author.toLowerCase())) {
            continue;
          }

          prsFound++;
          const existing = db.getPR(database, repoFullName, pr.number);

          if (!existing) {
            // New PR detected
            const inserted = db.upsertPR(database, {
              repo: repoFullName,
              number: pr.number,
              title: pr.title,
              author: pr.author,
              head_sha: pr.head_sha,
              state: pr.state,
            });
            db.createReviewRun(database, inserted.id, 'initial', 'New PR detected');
            reviewsTriggered++;
            log(`New PR: ${repoFullName}#${pr.number} "${pr.title}" by ${pr.author}`);
          } else if (existing.head_sha !== pr.head_sha) {
            // New commits pushed
            db.upsertPR(database, {
              repo: repoFullName,
              number: pr.number,
              title: pr.title,
              author: pr.author,
              head_sha: pr.head_sha,
              state: pr.state,
            });
            if (existing.review_status !== 'reviewing') {
              db.updatePRStatus(database, existing.id, 'pending');
              db.createReviewRun(database, existing.id, 'recheck', 'New commits pushed');
              reviewsTriggered++;
              log(`New commits on: ${repoFullName}#${pr.number}`);
            }
          } else if (existing.review_status === 'failed' || existing.review_status === 'pending') {
            // Retry failed/pending reviews with exponential backoff
            const key = `${repoFullName}#${pr.number}`;
            const failures = failureCount.get(key) || 0;
            const backoffScans = Math.min(2 ** failures, 32); // 1, 2, 4, 8, 16, 32 scans between retries
            if (failures >= MAX_RETRIES_PER_SCAN && failures % backoffScans !== 0) {
              // Skip this retry cycle (backoff)
              continue;
            }
            db.updatePRStatus(database, existing.id, 'pending');
            db.createReviewRun(database, existing.id, 'recheck', existing.review_status === 'failed' ? 'Retrying after failure' : 'Retrying stuck pending');
            reviewsTriggered++;
            log(`Retrying ${existing.review_status} PR: ${repoFullName}#${pr.number} (attempt ${failures + 1})`);
          } else if (existing.review_status === 'reviewed' && existing.unresolved_count > 0) {
            // Check for new replies on unresolved threads
            try {
              const sinceTime = existing.last_reviewed_at || existing.created_at;
              const hasReplies = await github.hasNewReplies(owner, repo, pr.number, sinceTime);
              if (hasReplies) {
                db.updatePRStatus(database, existing.id, 'pending');
                db.createReviewRun(database, existing.id, 'followup', 'Author replied to review comments');
                reviewsTriggered++;
                log(`New replies on: ${repoFullName}#${pr.number}`);
              }
            } catch (err: any) {
              errors.push(`Reply check failed for ${repoFullName}#${pr.number}: ${err.message}`);
            }
          } else {
            // Update title/state if changed
            db.upsertPR(database, {
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
        const trackedOpen = db.getOpenPRs(database).filter((p) => p.repo === repoFullName);
        const openNumbers = new Set(openPRs.map((p) => p.number));
        for (const tracked of trackedOpen) {
          if (!openNumbers.has(tracked.number)) {
            try {
              const { state, merged } = await github.getPRState(owner, repo, tracked.number);
              db.updatePRState(database, tracked.id, merged ? 'merged' : state);
              log(`PR closed: ${repoFullName}#${tracked.number} -> ${merged ? 'merged' : state}`);
            } catch {
              db.updatePRState(database, tracked.id, 'closed');
            }
          }
        }
      } catch (err: any) {
        errors.push(`Scan ${repoFullName} failed: ${err.message}`);
        log(`Error scanning ${repoFullName}: ${err.message}`);
      }
    }

    // Sync comment counts for all open PRs
    const allOpenPRs = db.getOpenPRs(database);
    for (const pr of allOpenPRs) {
      try {
        const { owner, repo } = parseRepo(pr.repo);
        const { totalComments, unresolvedCount } = await github.getReviewThreads(owner, repo, pr.number);
        db.updatePRCommentCounts(database, pr.id, totalComments, unresolvedCount);
      } catch {
        // Silently skip comment sync errors
      }
    }

    // Process pending review runs
    await processReviewQueue(config, database, github);
  } catch (err: any) {
    errors.push(`Scan error: ${err.message}`);
    log(`Scan error: ${err.message}`);
  } finally {
    log(`Scan complete: ${prsFound} PRs found, ${reviewsTriggered} reviews triggered${errors.length > 0 ? `, ${errors.length} errors` : ''}`);
    db.completeScanLog(database, scanId, prsFound, reviewsTriggered, errors.length > 0 ? errors.join('; ') : undefined);
    isScanning = false;
  }
}

async function processReviewQueue(config: Config, database: Database.Database, github: GitHubClient) {
  const pendingRuns = db.getPendingReviewRuns(database);

  for (const run of pendingRuns) {
    if (activeReviews >= config.reviewer.max_concurrent) {
      log(`Concurrency limit reached (${activeReviews}/${config.reviewer.max_concurrent}), remaining queued`);
      break;
    }

    activeReviews++;
    const startedAt = new Date().toISOString();
    db.updateReviewRun(database, run.id, { status: 'running', started_at: startedAt });
    db.updatePRStatus(database, run.pr_id, 'reviewing');

    log(`Starting ${run.type} review: ${run.repo}#${run.pr_number}`);

    // Dry-run mode: skip codex invocation
    if (config.debug.dry_run) {
      log(`DRY RUN: would invoke codex for ${run.repo}#${run.pr_number} (${run.type})`);
      db.updateReviewRun(database, run.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        duration_ms: 0,
        exit_code: 0,
      });
      db.updatePRStatus(database, run.pr_id, 'reviewed');
      activeReviews--;
      continue;
    }

    // Run review synchronously — block scan until review completes
    try {
      const result = await runCodexReview(config, run.type as 'initial' | 'followup' | 'recheck', {
        repo: run.repo,
        number: run.pr_number,
        title: run.title,
        author: run.pr_author,
      });

      const completedAt = new Date().toISOString();
      const status = result.exitCode === 0 ? 'completed' : 'failed';

      db.updateReviewRun(database, run.id, {
        status,
        completed_at: completedAt,
        duration_ms: result.durationMs,
        exit_code: result.exitCode,
        error: status === 'failed' ? `See log: ${result.logFile}` : undefined,
      });
      db.updatePRStatus(database, run.pr_id, status === 'completed' ? 'reviewed' : 'failed');

      // Sync comment counts after review completes
      try {
        const { owner, repo } = parseRepo(run.repo);
        const { totalComments, unresolvedCount } = await github.getReviewThreads(owner, repo, run.pr_number);
        db.updatePRCommentCounts(database, run.pr_id, totalComments, unresolvedCount);
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
      db.updateReviewRun(database, run.id, {
        status: 'failed',
        completed_at: new Date().toISOString(),
        error: err.message,
      });
      db.updatePRStatus(database, run.pr_id, 'failed');
      const key = `${run.repo}#${run.pr_number}`;
      failureCount.set(key, (failureCount.get(key) || 0) + 1);
      log(`Review error: ${run.repo}#${run.pr_number}: ${err.message}`);
    } finally {
      activeReviews--;
    }
  }
}

export function startScanner(config: Config, database: Database.Database, github: GitHubClient): ReturnType<typeof setInterval> {
  db.resetOrphanedReviews(database);

  if (config.debug.enabled) {
    log('DEBUG MODE enabled');
    if (config.debug.dry_run) log('DRY RUN: codex will NOT be invoked');
    if (config.debug.skip_scan_interval) log('Single scan mode: no periodic scanning');
    log(`Debug PRs: ${config.debug.prs.map((p) => `${p.repo}#${p.number}`).join(', ')}`);
  }

  log(`Starting scanner (interval: ${config.monitor.scan_interval_seconds}s)`);
  log(`Monitoring repos: ${config.monitor.repos.join(', ')}`);
  log(`Monitoring users: ${config.monitor.users.join(', ')}`);

  // Run initial scan
  scan(config, database, github);

  // In debug mode with skip_scan_interval, don't set up periodic scanning
  if (config.debug.enabled && config.debug.skip_scan_interval) {
    log('Periodic scanning disabled (debug.skip_scan_interval=true)');
    // Return a dummy interval that does nothing
    return setInterval(() => {}, 2_147_483_647);
  }

  // Schedule periodic scans
  const intervalMs = config.monitor.scan_interval_seconds * 1000;
  return setInterval(() => scan(config, database, github), intervalMs);
}
