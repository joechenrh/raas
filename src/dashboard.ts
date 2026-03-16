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

function getManualTriggerState(storage: Storage, pr: PR): { available: boolean; reason: string } {
  if (!isTidbRepo(pr.repo)) {
    return { available: false, reason: 'Only available for pingcap/tidb.' };
  }
  if (pr.state !== 'open') {
    return { available: false, reason: `PR is ${pr.state}.` };
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

function serializePR(storage: Storage, pr: PR) {
  const manualTrigger = getManualTriggerState(storage, pr);
  const displayReviewStatus = isResolvedState(pr) ? 'resolved' : pr.review_status;

  return {
    ...pr,
    review_status: displayReviewStatus,
    manual_trigger_available: manualTrigger.available,
    manual_trigger_reason: manualTrigger.reason,
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
    return c.json(storage.getReviewRuns(id));
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

    if (pr.review_status !== 'approved') {
      return c.json({ ok: false, error: `PR is not in approved state (current: ${pr.review_status}).` }, 409);
    }

    // Throttle: one triage per SHA
    if (storage.hasTriageRunForSha(pr.id, pr.head_sha)) {
      return c.json({ ok: false, error: 'Triage already run for this SHA.' }, 409);
    }

    storage.updatePRStatus(pr.id, 'pending');
    const runId = storage.createReviewRun(pr.id, 'ci-triage', 'Manual CI triage from dashboard');

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

