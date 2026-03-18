import path from 'node:path';
import type { Config } from './config.js';
import type { PR, Storage } from './db.js';
import type { GitHubClient, GitHubPR } from './github.js';
import { runCodexReview, type FollowupReviewMetadata } from './reviewer.js';
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
type ReviewRunType = 'initial' | 'followup' | 'recheck' | 'ci-triage';

interface ScanPRContext {
  owner: string;
  repo: string;
  repoFullName: string;
  pr: GitHubPR;
  tracked: PR;
  existing?: PR;
}

type ReviewDecision =
  | { kind: 'none' }
  | { kind: 'log-only'; message: string; data?: Record<string, unknown> }
  | { kind: 'set-status'; status: string; message: string; data?: Record<string, unknown> }
  | {
      kind: 'queue';
      reviewType: ReviewRunType;
      triggerReason: string;
      message: string;
      data?: Record<string, unknown>;
      metadata?: string;
    };

function log(msg: string, data?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  if (data) {
    console.log(`[${ts}] [scanner] ${msg}`, JSON.stringify(data));
  } else {
    console.log(`[${ts}] [scanner] ${msg}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseRunMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isObject(parsed)) {
      return parsed;
    }
  } catch {
    // Preserve execution even if older metadata is malformed.
  }

  return { legacy_metadata: raw };
}

function buildCompletedRunMetadata(raw: string | null, result: Awaited<ReturnType<typeof runCodexReview>>): string {
  const metadata = parseRunMetadata(raw);
  metadata.log_file = path.basename(result.logFile);

  if (result.executionStatus) {
    metadata.execution_status = result.executionStatus;
  }
  if (result.executionReason) {
    metadata.execution_reason = result.executionReason;
  }

  if (isObject(result.finalPayload)) {
    const pr = isObject(result.finalPayload.pr) ? result.finalPayload.pr : null;
    if (pr && typeof pr.head_sha === 'string') {
      metadata.head_sha = pr.head_sha;
    }

    if (typeof result.finalPayload.skill === 'string') {
      metadata.skill = result.finalPayload.skill;
    }

    const report = isObject(result.finalPayload.report) ? result.finalPayload.report : null;
    if (report) {
      metadata.triage_report = report;
      if (typeof report.summary === 'string') {
        metadata.report_summary = report.summary;
      }
      if (typeof report.comment_url === 'string') {
        metadata.comment_url = report.comment_url;
      }
    }
  }

  return JSON.stringify(metadata);
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
  github: GitHubClient,
  context: ScanPRContext,
): Promise<ReviewDecision | undefined> {
  const hasGoChanges = await github.hasGoChanges(context.owner, context.repo, context.pr.number);
  if (!hasGoChanges) {
    return {
      kind: 'set-status',
      status: NO_GO_CHANGES_STATUS,
      message: `Skipping review for ${context.repoFullName}#${context.pr.number}: ${NO_GO_CHANGES_MESSAGE.toLowerCase()}`,
    };
  }
  return undefined;
}

function upsertTrackedPR(storage: Storage, repoFullName: string, pr: GitHubPR): PR {
  return storage.upsertPR({
    repo: repoFullName,
    number: pr.number,
    title: pr.title,
    author: pr.author,
    head_sha: pr.head_sha,
    state: pr.state,
  });
}

function shouldTrackPR(
  config: Config,
  repoFullName: string,
  pr: GitHubPR,
  existing: PR | undefined,
  monitoredUsers: Set<string>,
  debugPRSet: Set<string>,
): boolean {
  if (config.debug.enabled && !debugPRSet.has(`${repoFullName}#${pr.number}`)) {
    return false;
  }

  if (existing) {
    return true;
  }

  if (config.monitor.ignore_before && pr.created_at < config.monitor.ignore_before) {
    return false;
  }

  if (pr.base_branch !== 'master' && pr.base_branch !== 'main') {
    return false;
  }

  if (pr.title.startsWith('[DNM]')) {
    return false;
  }

  if (!config.debug.enabled && monitoredUsers.size > 0 && !monitoredUsers.has(pr.author.toLowerCase())) {
    return false;
  }

  return true;
}

async function getTidbGateDecision(
  storage: Storage,
  github: GitHubClient,
  context: ScanPRContext,
  options: {
    readyTriggerReason: string;
    readyMessage: string;
    waitingMessage: string;
    errorMessage: string;
  },
): Promise<ReviewDecision> {
  const gate = await getTidbReviewGate(github, context.owner, context.repo, context.pr.number);
  if (gate.state === 'ready') {
    return {
      kind: 'queue',
      reviewType: 'initial',
      triggerReason: options.readyTriggerReason.replace('{reason}', gate.reason),
      message: options.readyMessage,
      data: { gate: gate.reason },
    };
  }
  if (gate.state === 'ci-failed') {
    return {
      kind: 'set-status',
      status: 'ci-failed',
      message: `CI checks failed for TiDB PR: ${context.repoFullName}#${context.pr.number}`,
      data: { gate: gate.reason },
    };
  }
  if (gate.state === 'waiting-ci') {
    return {
      kind: 'set-status',
      status: 'waiting-ci',
      message: options.waitingMessage,
      data: { gate: gate.reason },
    };
  }
  return {
    kind: 'set-status',
    status: 'ci-fetch-error',
    message: options.errorMessage,
    data: { gate: gate.reason },
  };
}

async function determineNewPRDecision(
  storage: Storage,
  github: GitHubClient,
  context: ScanPRContext,
): Promise<ReviewDecision> {
  const goChangeDecision = await hasGoChangesOrMarkSkipped(github, context);
  if (goChangeDecision) {
    return goChangeDecision;
  }

  if (!isTidbRepo(context.repoFullName)) {
    return {
      kind: 'queue',
      reviewType: 'initial',
      triggerReason: 'New PR detected',
      message: `New PR: ${context.repoFullName}#${context.pr.number} "${context.pr.title}" by ${context.pr.author}`,
    };
  }

  return getTidbGateDecision(storage, github, context, {
    readyTriggerReason: 'TiDB CI gate passed: {reason}',
    readyMessage: `New TiDB PR ready for review: ${context.repoFullName}#${context.pr.number}`,
    waitingMessage: `New TiDB PR waiting for CI gate: ${context.repoFullName}#${context.pr.number}`,
    errorMessage: `New TiDB PR could not fetch CI gate: ${context.repoFullName}#${context.pr.number}`,
  });
}

async function determineUpdatedPRDecision(
  storage: Storage,
  github: GitHubClient,
  context: ScanPRContext,
): Promise<ReviewDecision> {
  const goChangeDecision = await hasGoChangesOrMarkSkipped(github, context);
  if (goChangeDecision) {
    return goChangeDecision;
  }

  if (!isTidbRepo(context.repoFullName)) {
    if (context.existing?.review_status === 'reviewing') {
      return { kind: 'none' };
    }
    return {
      kind: 'queue',
      reviewType: 'recheck',
      triggerReason: 'New commits pushed',
      message: `New commits on: ${context.repoFullName}#${context.pr.number}`,
    };
  }

  if (context.existing && storage.hasPrimaryReviewRun(context.existing.id)) {
    return {
      kind: 'log-only',
      message: `Skipping retrigger for TiDB PR after new commits: ${context.repoFullName}#${context.pr.number}`,
    };
  }

  return getTidbGateDecision(storage, github, context, {
    readyTriggerReason: 'TiDB CI gate passed after new commits: {reason}',
    readyMessage: `TiDB PR passed CI gate after new commits: ${context.repoFullName}#${context.pr.number}`,
    waitingMessage: `TiDB PR still waiting for CI gate after new commits: ${context.repoFullName}#${context.pr.number}`,
    errorMessage: `TiDB PR could not fetch CI gate after new commits: ${context.repoFullName}#${context.pr.number}`,
  });
}

async function determineTidbWaitingDecision(
  storage: Storage,
  github: GitHubClient,
  context: ScanPRContext,
): Promise<ReviewDecision> {
  const goChangeDecision = await hasGoChangesOrMarkSkipped(github, context);
  if (goChangeDecision) {
    return goChangeDecision;
  }

  return getTidbGateDecision(storage, github, context, {
    readyTriggerReason: 'TiDB CI gate passed: {reason}',
    readyMessage: `TiDB PR passed CI gate: ${context.repoFullName}#${context.pr.number}`,
    waitingMessage: `TiDB PR still waiting for CI gate: ${context.repoFullName}#${context.pr.number}`,
    errorMessage: `TiDB PR could not fetch CI gate: ${context.repoFullName}#${context.pr.number}`,
  });
}

function shouldRetryNow(repoFullName: string, prNumber: number): boolean {
  const key = `${repoFullName}#${prNumber}`;
  const failures = failureCount.get(key) || 0;
  const backoffScans = Math.min(2 ** failures, 32);
  return failures < MAX_RETRIES_PER_SCAN || failures % backoffScans === 0;
}

async function determineRetryDecision(
  storage: Storage,
  github: GitHubClient,
  context: ScanPRContext,
): Promise<ReviewDecision> {
  const goChangeDecision = await hasGoChangesOrMarkSkipped(github, context);
  if (goChangeDecision) {
    return goChangeDecision;
  }

  if (context.existing && isTidbRepo(context.repoFullName) && storage.hasPrimaryReviewRun(context.existing.id)) {
    return {
      kind: 'log-only',
      message: `Skipping retry for TiDB PR: ${context.repoFullName}#${context.pr.number} (one-shot review policy)`,
    };
  }

  if (!shouldRetryNow(context.repoFullName, context.pr.number)) {
    return { kind: 'none' };
  }

  const status = context.existing?.review_status;
  return {
    kind: 'queue',
    reviewType: 'recheck',
    triggerReason: status === 'failed' ? 'Retrying after failure' : 'Retrying stuck pending',
    message: `Retrying ${status} PR: ${context.repoFullName}#${context.pr.number} (attempt ${(failureCount.get(`${context.repoFullName}#${context.pr.number}`) || 0) + 1})`,
  };
}

async function determineFollowupDecision(
  github: GitHubClient,
  context: ScanPRContext,
  errors: string[],
): Promise<ReviewDecision> {
  try {
    const sinceTime = context.existing?.last_reviewed_at || context.existing?.created_at;
    if (!sinceTime) {
      return { kind: 'none' };
    }

    const followup = await github.getFollowupTargets(context.owner, context.repo, context.pr.number, sinceTime);
    if (followup.targets.length === 0) {
      return { kind: 'none' };
    }

    return {
      kind: 'queue',
      reviewType: 'followup',
      triggerReason: 'Author replied to review comments',
      metadata: JSON.stringify(followup),
      message: `New replies on: ${context.repoFullName}#${context.pr.number}`,
      data: {
        botUser: followup.botUser,
        targets: followup.targets.map((target) => ({
          parentCommentId: target.parentCommentId,
          replyCommentId: target.replyCommentId,
        })),
      },
    };
  } catch (err: any) {
    errors.push(`Reply check failed for ${context.repoFullName}#${context.pr.number}: ${err.message}`);
    return { kind: 'none' };
  }
}

async function determineReviewDecision(
  config: Config,
  storage: Storage,
  github: GitHubClient,
  context: ScanPRContext,
  errors: string[],
): Promise<ReviewDecision> {
  if (!context.existing) {
    return determineNewPRDecision(storage, github, context);
  }

  if (context.existing.head_sha !== context.pr.head_sha) {
    return determineUpdatedPRDecision(storage, github, context);
  }

  if (isTidbRepo(context.repoFullName)
    && (context.existing.review_status === 'waiting-ci' || context.existing.review_status === 'ci-fetch-error' || context.existing.review_status === 'ci-failed')) {
    return determineTidbWaitingDecision(storage, github, context);
  }

  if (context.existing.review_status === 'failed' || context.existing.review_status === 'pending') {
    return determineRetryDecision(storage, github, context);
  }

  if (config.monitor.followup_enabled
    && context.existing.review_status === 'reviewed'
    && context.existing.unresolved_count > 0) {
    return determineFollowupDecision(github, context, errors);
  }

  return { kind: 'none' };
}

function applyReviewDecision(storage: Storage, context: ScanPRContext, decision: ReviewDecision): number {
  switch (decision.kind) {
    case 'none':
      return 0;
    case 'log-only':
      log(decision.message, decision.data);
      return 0;
    case 'set-status':
      storage.updatePRStatus(context.tracked.id, decision.status);
      log(decision.message, decision.data);
      return 0;
    case 'queue':
      storage.updatePRStatus(context.tracked.id, 'pending');
      storage.createReviewRun(context.tracked.id, decision.reviewType, decision.triggerReason, decision.metadata);
      log(decision.message, decision.data);
      return 1;
  }
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

          if (!shouldTrackPR(config, repoFullName, pr, existing, monitoredUsers, debugPRSet)) {
            continue;
          }

          const tracked = upsertTrackedPR(storage, repoFullName, pr);
          if (hasApprovedLabel) {
            if (!storage.getActiveReviewRun(tracked.id)) {
              storage.updatePRStatus(tracked.id, 'approved');
            }
            continue;
          }

          prsFound++;

          const context: ScanPRContext = {
            owner,
            repo,
            repoFullName,
            pr,
            tracked,
            existing,
          };
          const decision = await determineReviewDecision(config, storage, github, context, errors);
          reviewsTriggered += applyReviewDecision(storage, context, decision);
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

      const source = run.trigger_reason?.startsWith('Manual') ? 'dashboard' : 'scanner';
      log(`Starting ${run.type} review: ${run.repo}#${run.pr_number}`, { source, trigger: run.trigger_reason ?? 'unknown' });

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

      // Notify on the PR that a review is starting
      try {
        const { owner: o, repo: r } = parseRepo(run.repo);
        const msgs: Record<string, string> = {
          initial: `🔍 Starting code review for this PR...`,
          recheck: `🔍 New commits detected — starting re-review...`,
          followup: `🔍 Processing follow-up on review comments...`,
          'ci-triage': `🔍 Starting CI failure triage...`,
        };
        await github.createPRComment(o, r, run.pr_number, msgs[run.type] || msgs.initial);
      } catch (err: any) {
        log(`Failed to post review-start comment on ${run.repo}#${run.pr_number}: ${err.message}`);
      }

      // Run review synchronously — block scan until review completes
      try {
        const followupMetadata = run.type === 'followup' ? parseFollowupMetadata(run.metadata) : undefined;
        const result = await runCodexReview(config, run.type as 'initial' | 'followup' | 'recheck' | 'ci-triage', {
          repo: run.repo,
          number: run.pr_number,
          title: run.title,
          author: run.pr_author,
          followupMetadata,
        });

        const completedAt = new Date().toISOString();
        const orchestrationSucceeded = result.executionStatus
          ? result.executionStatus === 'success' || result.executionStatus === 'completed'
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
          metadata: buildCompletedRunMetadata(run.metadata, result),
          error: status === 'failed'
            ? `${failureDetail ? `${failureDetail}. ` : ''}See log: ${path.basename(result.logFile)}`
            : undefined,
        });
        if (run.type === 'ci-triage') {
          // After triage, set status back to ci-failed so the gate keeps polling for CI recovery
          storage.updatePRStatus(run.pr_id, status === 'completed' ? 'ci-failed' : 'failed');
        } else {
          storage.updatePRStatus(run.pr_id, status === 'completed' ? 'reviewed' : 'failed');
        }

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

        log(`Review ${status}: ${run.repo}#${run.pr_number} (${result.durationMs}ms, exit ${result.exitCode})`, { source, trigger: run.trigger_reason ?? 'unknown' });
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
