import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import type { Config } from './config.js';
import type { GitHubClient } from './github.js';
import type { PR, Storage } from './db.js';
import { getScannerStatus, processReviewQueue } from './scanner.js';
import { getTidbReviewGate, isTidbRepo } from './tidb-review-gate.js';
import { serveStatic } from '@hono/node-server/serve-static';

const RECENT_SCAN_LIMIT = 10;
const NO_GO_CHANGES_STATUS = 'no-go-changes';
const NO_GO_CHANGES_MESSAGE = 'No .go file changes in PR.';
const ACTIVE_RUN_STATUSES = new Set(['pending', 'running']);
const REVIEW_LOGS_DIR = path.join(process.cwd(), 'outputs', 'logs', 'reviews');

function parseRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split('/');
  return { owner, repo };
}

function parseManualPRReference(
  raw: string,
  defaultRepo?: string,
): { repo: string; number: number } | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }

  const urlMatch = value.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i);
  if (urlMatch) {
    return { repo: urlMatch[1], number: Number(urlMatch[2]) };
  }

  const repoMatch = value.match(/^([^#\s]+\/[^#\s]+)#(\d+)$/);
  if (repoMatch) {
    return { repo: repoMatch[1], number: Number(repoMatch[2]) };
  }

  const numberMatch = value.match(/^#?(\d+)$/);
  if (numberMatch && defaultRepo) {
    return { repo: defaultRepo, number: Number(numberMatch[1]) };
  }

  return null;
}

function isResolvedState(pr: PR): boolean {
  const resolvedComments = pr.comment_count - pr.unresolved_count;
  return pr.review_status === 'reviewed' && resolvedComments > 0 && pr.unresolved_count === 0;
}

function parseRunMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore malformed or legacy metadata payloads.
  }

  return null;
}

function extractLastJsonObject(content: string): Record<string, unknown> | null {
  const candidateStarts: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '{' && (i === 0 || content[i - 1] === '\n')) {
      candidateStarts.push(i);
    }
  }

  for (let i = candidateStarts.length - 1; i >= 0; i--) {
    const candidateStart = candidateStarts[i];
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let cursor = candidateStart; cursor < content.length; cursor++) {
      const ch = content[cursor];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '{') {
        depth++;
        continue;
      }

      if (ch !== '}') {
        continue;
      }

      depth--;
      if (depth !== 0) {
        continue;
      }

      try {
        const parsed = JSON.parse(content.slice(candidateStart, cursor + 1)) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        break;
      }

      break;
    }
  }

  return null;
}

function readMetadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  if (!metadata) {
    return null;
  }
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function readMetadataObject(metadata: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }
  const value = metadata[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeTriageReport(report: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!report) {
    return null;
  }

  const findings = Array.isArray(report.findings)
    ? report.findings.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    : [];
  const rawChecks = Array.isArray(report.failing_checks)
    ? report.failing_checks.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    : [];

  const findingBySignature = new Map<string, Record<string, unknown>>();
  const findingByCheck = new Map<string, Record<string, unknown>>();

  for (const finding of findings) {
    const signatureId = typeof finding.signature_id === 'string' ? finding.signature_id : null;
    if (signatureId) {
      findingBySignature.set(signatureId, finding);
      const checkName = signatureId.split(' :: ')[0]?.trim();
      if (checkName && !findingByCheck.has(checkName)) {
        findingByCheck.set(checkName, finding);
      }
    }

    const checkName = typeof finding.check_name === 'string' ? finding.check_name.trim() : '';
    if (checkName && !findingByCheck.has(checkName)) {
      findingByCheck.set(checkName, finding);
    }
  }

  const normalizedChecks = rawChecks.length > 0
    ? rawChecks.map((check) => {
        const signatureId = typeof check.signature_id === 'string' ? check.signature_id : null;
        const checkName = typeof check.check_name === 'string' ? check.check_name.trim() : '';
        const matchedFinding = (signatureId && findingBySignature.get(signatureId))
          || (checkName && findingByCheck.get(checkName))
          || null;
        return matchedFinding ? { ...matchedFinding, ...check } : check;
      })
    : findings.map((finding) => ({ ...finding }));

  return {
    ...report,
    failing_checks: normalizedChecks,
  };
}

function renderTriageReportMarkdown(report: Record<string, unknown>): string {
  const normalized = normalizeTriageReport(report) || report;
  const summary = typeof normalized.summary === 'string' ? normalized.summary.trim() : '';
  const checks = Array.isArray(normalized.failing_checks) ? normalized.failing_checks : [];

  const lines = ['## CI Failure Triage Report', ''];
  if (summary) {
    lines.push(summary, '');
  }

  if (checks.length > 0) {
    lines.push('| Check | Classification | Decision Confidence | Fix Recommendation | Signature |');
    lines.push('| --- | --- | --- | --- | --- |');

    for (const rawCheck of checks) {
      const check = rawCheck && typeof rawCheck === 'object' ? rawCheck as Record<string, unknown> : {};
      const checkName = typeof check.check_name === 'string' ? check.check_name : '-';
      const category = typeof check.category === 'string'
        ? check.category
        : typeof check.classification === 'string' ? check.classification : 'needs_more_evidence';
      const confidence = typeof check.confidence === 'string' ? check.confidence : '-';
      const recommendedToFix = typeof check.recommended_to_fix === 'boolean' ? check.recommended_to_fix : null;
      const fixPriority = typeof check.fix_priority === 'string' ? check.fix_priority : null;
      const fixRecommendation = recommendedToFix == null
        ? '-'
        : recommendedToFix
          ? `recommend fix${fixPriority ? ` (${fixPriority})` : ''}`
          : (fixPriority || 'observe');
      const signature = typeof check.signature_id === 'string'
        ? check.signature_id
        : typeof check.signature === 'string' ? check.signature : '-';
      const checkCell = typeof check.url === 'string'
        ? `[\`${checkName}\`](${check.url})`
        : `\`${checkName}\``;

      lines.push(`| ${checkCell} | \`${category}\` | ${confidence} | ${fixRecommendation} | \`${signature}\` |`);
      if (typeof check.fix_reason === 'string' && check.fix_reason.trim()) {
        lines.push('');
        lines.push(`Fix note for \`${checkName}\`: ${check.fix_reason.trim()}`);
        lines.push('');
      }
    }
    lines.push('');
  } else {
    lines.push('No failing checks were captured in the triage payload.', '');
  }

  lines.push('*Generated by RaaS CI Triage. Report only, no actions taken.*');
  return lines.join('\n');
}

function getRunLogFallback(repo: string, prNumber: number, runType: string, startedAt: string | null): Record<string, unknown> | null {
  if (!fs.existsSync(REVIEW_LOGS_DIR)) {
    return null;
  }

  const prefix = `${repo.replace('/', '_')}_${prNumber}_${runType}_`;
  const candidates = fs.readdirSync(REVIEW_LOGS_DIR)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.log'))
    .map((name) => {
      const filePath = path.join(REVIEW_LOGS_DIR, name);
      const stat = fs.statSync(filePath);
      return { name, filePath, mtimeMs: stat.mtimeMs };
    });

  if (candidates.length === 0) {
    return null;
  }

  let selected = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (startedAt) {
    const startedMs = Date.parse(startedAt);
    if (Number.isFinite(startedMs)) {
      selected = candidates.reduce((best, candidate) => {
        const bestDelta = Math.abs(best.mtimeMs - startedMs);
        const currentDelta = Math.abs(candidate.mtimeMs - startedMs);
        return currentDelta < bestDelta ? candidate : best;
      }, selected);
    }
  }

  try {
    const content = fs.readFileSync(selected.filePath, 'utf-8');
    const payload = extractLastJsonObject(content);
    const report = payload?.report && typeof payload.report === 'object' && !Array.isArray(payload.report)
      ? payload.report as Record<string, unknown>
      : null;
    return {
      log_file: selected.name,
      head_sha: payload?.pr && typeof payload.pr === 'object' && !Array.isArray(payload.pr) && typeof (payload.pr as { head_sha?: unknown }).head_sha === 'string'
        ? (payload.pr as { head_sha: string }).head_sha
        : null,
      skill: typeof payload?.skill === 'string' ? payload.skill : null,
      triage_report: normalizeTriageReport(report),
      report_summary: typeof report?.summary === 'string' ? report.summary : null,
      comment_url: typeof report?.comment_url === 'string' ? report.comment_url : null,
    };
  } catch {
    return { log_file: selected.name };
  }
}

function serializeRun(
  run: { id: number; pr_id: number; type: string; status: string; trigger_reason: string | null; metadata: string | null; started_at: string | null; completed_at: string | null; duration_ms: number | null; exit_code: number | null; error: string | null; },
  context?: { repo: string; number: number },
) {
  const metadata = parseRunMetadata(run.metadata) || {};
  if (context) {
    const fallback = getRunLogFallback(context.repo, context.number, run.type, run.started_at);
    if (fallback) {
      Object.entries(fallback).forEach(([key, value]) => {
        if ((metadata as Record<string, unknown>)[key] == null && value != null) {
          (metadata as Record<string, unknown>)[key] = value;
        }
      });
    }
  }

  return {
    ...run,
    metadata,
    summary: readMetadataString(metadata, 'report_summary'),
    comment_url: readMetadataString(metadata, 'comment_url'),
    log_file: readMetadataString(metadata, 'log_file'),
    skill: readMetadataString(metadata, 'skill'),
    head_sha: readMetadataString(metadata, 'head_sha'),
    triage_report: normalizeTriageReport(readMetadataObject(metadata, 'triage_report')),
  };
}

function getManualTriggerState(storage: Storage, pr: PR): { available: boolean; reason: string } {
  if (!isTidbRepo(pr.repo)) {
    return { available: false, reason: 'Only available for pingcap/tidb.' };
  }
  if (pr.state !== 'open') {
    return { available: false, reason: `PR is ${pr.state}.` };
  }
  const activeRun = storage.getActiveReviewRun(pr.id);
  if (activeRun) {
    return {
      available: false,
      reason: activeRun.type === 'ci-triage'
        ? `CI triage is already ${activeRun.status === 'pending' ? 'queued' : 'running'}.`
        : 'Review is already running.',
    };
  }
  if (pr.review_status === 'reviewing') {
    return { available: false, reason: 'Review is already running.' };
  }
  if (pr.review_status === 'pending') {
    return { available: false, reason: 'Review is already queued.' };
  }
  if (pr.review_status === 'approved') {
    return { available: false, reason: 'PR is already approved.' };
  }
  if (pr.review_status === NO_GO_CHANGES_STATUS) {
    return { available: false, reason: NO_GO_CHANGES_MESSAGE };
  }
  if (!storage.hasPrimaryReviewRun(pr.id)) {
    return { available: false, reason: 'Initial review is triggered automatically after TiDB CI passes.' };
  }
  if (!isResolvedState(pr)) {
    return { available: false, reason: 'Only resolved PRs can trigger a recheck review.' };
  }
  return { available: true, reason: 'Resolved PR can trigger a recheck review after current TiDB CI passes.' };
}

function getCITriageState(storage: Storage, pr: PR): { available: boolean; reason: string } {
  if (!isTidbRepo(pr.repo)) {
    return { available: false, reason: 'Only available for pingcap/tidb.' };
  }
  if (pr.state !== 'open') {
    return { available: false, reason: `PR is ${pr.state}.` };
  }

  const activeRun = storage.getActiveReviewRun(pr.id);
  if (activeRun && activeRun.type === 'ci-triage' && ACTIVE_RUN_STATUSES.has(activeRun.status)) {
    return {
      available: false,
      reason: `CI triage is already ${activeRun.status === 'pending' ? 'queued' : 'running'}.`,
    };
  }
  if (activeRun) {
    return { available: false, reason: 'Another review is already running.' };
  }
  if (pr.review_status !== 'approved') {
    return { available: false, reason: `PR is not in approved state (current: ${pr.review_status}).` };
  }
  if (storage.hasTriageRunForSha(pr.id, pr.head_sha)) {
    return { available: false, reason: 'CI triage already ran for this commit.' };
  }

  return { available: true, reason: 'Approved PR can trigger CI triage.' };
}

function serializePR(storage: Storage, pr: PR) {
  const manualTrigger = getManualTriggerState(storage, pr);
  const ciTriage = getCITriageState(storage, pr);
  const activeRun = storage.getActiveReviewRun(pr.id);
  const latestRun = storage.getLatestReviewRun(pr.id);
  const latestCITriage = storage.getLatestReviewRunByType(pr.id, 'ci-triage');
  const displayReviewStatus = activeRun?.status === 'running'
    ? 'reviewing'
    : activeRun?.status === 'pending'
      ? 'pending'
      : isResolvedState(pr) ? 'resolved' : pr.review_status;

  return {
    ...pr,
    review_status: displayReviewStatus,
    manual_trigger_available: manualTrigger.available,
    manual_trigger_reason: manualTrigger.reason,
    ci_triage_available: ciTriage.available,
    ci_triage_reason: ciTriage.reason,
    active_run: activeRun ? serializeRun(activeRun, { repo: pr.repo, number: pr.number }) : null,
    latest_run: latestRun ? serializeRun(latestRun, { repo: pr.repo, number: pr.number }) : null,
    latest_ci_triage: latestCITriage ? serializeRun(latestCITriage, { repo: pr.repo, number: pr.number }) : null,
  };
}

export function registerDashboard(
  app: Hono,
  storage: Storage,
  config: Config,
  github: GitHubClient,
) {
  // JSON API
  app.get('/api/prs', (c) => c.json(storage.getAllPRs().map((pr) => serializePR(storage, pr))));
  app.get('/api/stats', (c) => c.json(storage.getStats()));
  app.get('/api/logs', (c) => {
    const limitRaw = Number(c.req.query('limit') || RECENT_SCAN_LIMIT);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 100)) : RECENT_SCAN_LIMIT;
    return c.json(storage.getRecentScanLogs(limit));
  });
  app.get('/api/prs/:id/runs', (c) => {
    const id = Number(c.req.param('id'));
    const pr = storage.getPRById(id);
    if (!pr) {
      return c.json({ ok: false, error: 'PR not found.' }, 404);
    }
    return c.json(storage.getReviewRuns(id).map((run) => serializeRun(run, { repo: pr.repo, number: pr.number })));
  });
  app.post('/api/prs/:id/triage-comment', async (c) => {
    const id = Number(c.req.param('id'));
    const pr = storage.getPRById(id);
    if (!pr) {
      return c.json({ ok: false, error: 'PR not found.' }, 404);
    }

    const latestTriage = storage.getLatestReviewRunByType(pr.id, 'ci-triage');
    if (!latestTriage) {
      return c.json({ ok: false, error: 'No CI triage run found for this PR.' }, 409);
    }

    const serialized = serializeRun(latestTriage, { repo: pr.repo, number: pr.number });
    if (!serialized.triage_report) {
      return c.json({ ok: false, error: 'Latest CI triage run has no report payload.' }, 409);
    }
    if (serialized.comment_url) {
      return c.json({
        ok: false,
        error: 'CI triage report was already commented.',
        comment_url: serialized.comment_url,
      }, 409);
    }

    const { owner, repo } = parseRepo(pr.repo);
    const comment = await github.createPRComment(owner, repo, pr.number, renderTriageReportMarkdown(serialized.triage_report));

    const metadata = parseRunMetadata(latestTriage.metadata) || {};
    metadata.comment_url = comment.url;
    storage.updateReviewRun(latestTriage.id, { metadata: JSON.stringify(metadata) });

    return c.json({
      ok: true,
      message: 'CI triage report commented on GitHub.',
      comment_url: comment.url,
      pr: serializePR(storage, pr),
    });
  });
  app.post('/api/manual-prs', async (c) => {
    const body = await c.req.json<{ value?: string }>().catch(() => null);
    const rawValue = body?.value || '';
    const defaultRepo = config.monitor.repos.length === 1 ? config.monitor.repos[0] : undefined;
    const parsed = parseManualPRReference(rawValue, defaultRepo);

    if (!parsed) {
      return c.json({
        ok: false,
        error: 'Use #123, owner/repo#123, or a GitHub PR URL.',
      }, 400);
    }

    const { owner, repo } = parseRepo(parsed.repo);
    let remotePR;
    try {
      remotePR = await github.getPullRequest(owner, repo, parsed.number);
    } catch (err) {
      return c.json({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to fetch PR from GitHub.',
      }, 404);
    }

    if (remotePR.state !== 'open') {
      return c.json({
        ok: false,
        error: `PR is ${remotePR.state}.`,
      }, 409);
    }

    const hasGoChanges = await github.hasGoChanges(owner, repo, parsed.number);

    const existing = storage.getPR(parsed.repo, parsed.number);
    if (existing?.review_status === 'pending') {
      return c.json({
        ok: false,
        error: 'PR review is already queued.',
        pr: serializePR(storage, existing),
      }, 409);
    }
    if (existing?.review_status === 'reviewing') {
      return c.json({
        ok: false,
        error: 'PR review is already running.',
        pr: serializePR(storage, existing),
      }, 409);
    }
    if (existing && storage.hasPrimaryReviewRun(existing.id)) {
      return c.json({
        ok: false,
        error: 'PR is already tracked. Use Trigger Review if you need another run.',
        pr: serializePR(storage, existing),
      }, 409);
    }

    const tracked = storage.upsertPR({
      repo: parsed.repo,
      number: parsed.number,
      title: remotePR.title,
      author: remotePR.author,
      head_sha: remotePR.head_sha,
      state: remotePR.state,
    });

    if (!hasGoChanges) {
      storage.updatePRStatus(tracked.id, NO_GO_CHANGES_STATUS);
      const refreshed = storage.getPR(parsed.repo, parsed.number);
      return c.json({
        ok: true,
        message: `Tracked ${parsed.repo}#${parsed.number}, but review was not queued: ${NO_GO_CHANGES_MESSAGE}`,
        pr: refreshed ? serializePR(storage, refreshed) : null,
      });
    }

    storage.updatePRStatus(tracked.id, 'pending');
    const runId = storage.createReviewRun(
      tracked.id,
      'initial',
      `Manually added from dashboard for review (base: ${remotePR.base_branch})`,
    );

    console.log(`[dashboard] Manual add: ${parsed.repo}#${parsed.number} queued for initial review (run ${runId})`);

    void processReviewQueue(config, storage, github).catch((err) => {
      console.error('[dashboard] manual add queue processing failed:', err);
    });

    const refreshed = storage.getPR(parsed.repo, parsed.number);
    return c.json({
      ok: true,
      message: `Manual review queued for ${parsed.repo}#${parsed.number}.`,
      run_id: runId,
      pr: refreshed ? serializePR(storage, refreshed) : null,
    });
  });
  app.post('/api/prs/:id/manual-trigger', async (c) => {
    const id = Number(c.req.param('id'));
    const pr = storage.getPRById(id);
    if (!pr) {
      return c.json({ ok: false, error: 'PR not found.' }, 404);
    }

    const manualTrigger = getManualTriggerState(storage, pr);
    if (!manualTrigger.available) {
      return c.json({
        ok: false,
        error: manualTrigger.reason,
        pr: serializePR(storage, pr),
      }, 409);
    }

    const { owner, repo } = parseRepo(pr.repo);
    const hasGoChanges = await github.hasGoChanges(owner, repo, pr.number);
    if (!hasGoChanges) {
      storage.updatePRStatus(pr.id, NO_GO_CHANGES_STATUS);
      const refreshed = storage.getPR(pr.repo, pr.number);
      return c.json({
        ok: false,
        error: NO_GO_CHANGES_MESSAGE,
        pr: refreshed ? serializePR(storage, refreshed) : null,
      }, 409);
    }

    const gate = await getTidbReviewGate(github, owner, repo, pr.number);
    if (gate.state !== 'ready') {
      return c.json({
        ok: false,
        error: `TiDB CI gate not ready: ${gate.reason}`,
        pr: serializePR(storage, pr),
      }, 409);
    }

    const triggerReason = `Manual recheck from dashboard after TiDB CI gate passed: ${gate.reason}`;

    storage.updatePRStatus(pr.id, 'pending');
    const runId = storage.createReviewRun(pr.id, 'recheck', triggerReason);

    console.log(`[dashboard] Manual trigger: ${pr.repo}#${pr.number} queued for recheck review (run ${runId})`);

    void processReviewQueue(config, storage, github).catch((err) => {
      console.error('[dashboard] manual trigger queue processing failed:', err);
    });

    const refreshed = storage.getPR(pr.repo, pr.number);
    return c.json({
      ok: true,
      message: 'Manual review trigger queued.',
      run_id: runId,
      pr: refreshed ? serializePR(storage, refreshed) : null,
    });
  });
  // CI failure details endpoint — fetches failing checks live from GitHub
  app.get('/api/prs/:id/ci-failures', async (c) => {
    const id = Number(c.req.param('id'));
    const pr = storage.getPRById(id);
    if (!pr) {
      return c.json({ ok: false, error: 'PR not found.' }, 404);
    }

    const { owner, repo } = parseRepo(pr.repo);
    const statusResult = await github.getPRStatusChecks(owner, repo, pr.number);
    if (!statusResult.ok) {
      return c.json({ ok: false, error: statusResult.error || 'Failed to fetch CI checks.' }, 502);
    }

    const FAILED_STATES = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED']);
    const failures = statusResult.checks.filter((check) => FAILED_STATES.has(check.state));
    return c.json({
      ok: true,
      head_sha: pr.head_sha,
      failures: failures.map((check) => ({
        name: check.name,
        state: check.state,
        details_url: check.detailsUrl,
      })),
    });
  });

  // Manual CI triage trigger — queues a ci-triage codex run
  app.post('/api/prs/:id/ci-triage', async (c) => {
    const id = Number(c.req.param('id'));
    const pr = storage.getPRById(id);
    if (!pr) {
      return c.json({ ok: false, error: 'PR not found.' }, 404);
    }

    if (pr.state !== 'open') {
      return c.json({ ok: false, error: `PR is ${pr.state}.` }, 409);
    }

    const ciTriage = getCITriageState(storage, pr);
    if (!ciTriage.available) {
      return c.json({
        ok: false,
        error: ciTriage.reason,
        pr: serializePR(storage, pr),
      }, 409);
    }

    storage.updatePRStatus(pr.id, 'pending');
    const runId = storage.createReviewRun(
      pr.id,
      'ci-triage',
      'Manual CI triage from dashboard',
      JSON.stringify({ head_sha: pr.head_sha }),
    );

    console.log(`[dashboard] CI triage: ${pr.repo}#${pr.number} queued for ci-triage (run ${runId})`);

    void processReviewQueue(config, storage, github).catch((err) => {
      console.error('[dashboard] ci-triage queue processing failed:', err);
    });

    const refreshed = storage.getPR(pr.repo, pr.number);
    return c.json({
      ok: true,
      message: `CI triage queued for ${pr.repo}#${pr.number}.`,
      run_id: runId,
      pr: refreshed ? serializePR(storage, refreshed) : null,
    });
  });

  app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));
  app.get('/api/status', (c) => c.json(getScannerStatus()));
  app.get('/api/config', (c) => c.json({
    users: config.monitor.users,
    repos: config.monitor.repos,
  }));


  // Serve static dashboard files (after API routes so /api/* takes priority)
  app.use('/*', serveStatic({ root: './public' }));
}
