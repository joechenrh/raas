import type { Hono } from 'hono';
import type { Config } from './config.js';
import type { GitHubClient } from './github.js';
import type { PR, Storage } from './db.js';
import { getScannerStatus, processReviewQueue } from './scanner.js';
import { getTidbReviewGate, isTidbRepo } from './tidb-review-gate.js';

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

    if (pr.review_status !== 'ci-failed') {
      return c.json({ ok: false, error: `PR is not in ci-failed state (current: ${pr.review_status}).` }, 409);
    }

    // Throttle: one triage per SHA
    if (storage.hasTriageRunForSha(pr.id, pr.head_sha)) {
      return c.json({ ok: false, error: 'Triage already run for this SHA.' }, 409);
    }

    storage.updatePRStatus(pr.id, 'pending');
    const runId = storage.createReviewRun(pr.id, 'ci-triage', 'Manual CI triage from dashboard');

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

  // Dashboard SPA
  app.get('/', (c) => c.html(DASHBOARD_HTML));
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RaaS - Review as a Service</title>
  <style>
    :root {
      color-scheme: dark;
      --bg-top: #12161d;
      --bg-bottom: #181e26;
      --surface: rgba(255, 255, 255, 0.06);
      --surface-strong: rgba(255, 255, 255, 0.1);
      --surface-muted: rgba(255, 255, 255, 0.04);
      --border: rgba(255, 255, 255, 0.12);
      --border-soft: rgba(255, 255, 255, 0.085);
      --text-primary: #f5f7fa;
      --text-secondary: #b3bdc9;
      --text-tertiary: #a0aab8;
      --accent: #9bb8ff;
      --accent-strong: #dce6ff;
      --reviewed: #c4d2f2;
      --resolved: #8fd8cc;
      --success: #9ed2b4;
      --warning: #d9ba7a;
      --danger: #ff9898;
      --shadow: 0 24px 56px rgba(0, 0, 0, 0.26);
      --ring: 0 0 0 4px rgba(155, 184, 255, 0.18);
      --transition-fast: 0.12s ease;
      --transition-normal: 0.2s ease;
      --transition-slow: 0.3s ease;
    }

    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .sr-only:focus {
      position: fixed;
      top: 8px;
      left: 8px;
      width: auto;
      height: auto;
      padding: 12px 16px;
      margin: 0;
      overflow: visible;
      clip: auto;
      white-space: normal;
      z-index: 999;
      background: var(--bg-top);
      color: var(--accent-strong);
      border-radius: 10px;
      border: 2px solid var(--accent);
      font-size: 14px;
      font-weight: 600;
    }

    body {
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;
      color: var(--text-secondary);
      background:
        radial-gradient(circle at top, rgba(155, 184, 255, 0.18), transparent 34%),
        radial-gradient(circle at 85% 12%, rgba(255, 255, 255, 0.06), transparent 24%),
        linear-gradient(180deg, var(--bg-top) 0%, var(--bg-bottom) 100%);
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }

    a, button, input { -webkit-tap-highlight-color: transparent; }

    a:focus-visible,
    button:focus-visible,
    input:focus-visible {
      outline: none;
      box-shadow: var(--ring);
    }

    .navbar {
      position: sticky;
      top: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      height: 64px;
      padding: 0 32px;
      background: rgba(19, 24, 31, 0.7);
      border-bottom: 1px solid var(--border-soft);
      backdrop-filter: blur(20px);
    }

    .nav-left,
    .nav-right {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    }

    .nav-logo {
      width: 28px;
      height: 28px;
      border-radius: 9px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.11);
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 600;
      letter-spacing: -0.2px;
    }

    .nav-title {
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-width: 0;
    }

    .nav-title strong {
      color: var(--text-primary);
      font-size: 14px;
      font-weight: 600;
      letter-spacing: -0.2px;
    }

    .nav-title span {
      color: var(--text-tertiary);
      font-size: 11px;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }

    .nav-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .nav-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.055);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: var(--text-tertiary);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      white-space: nowrap;
    }

    .nav-tag b {
      color: var(--text-primary);
      font-weight: 600;
    }

    .nav-status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.055);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: var(--text-secondary);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      white-space: nowrap;
    }

    .nav-status.is-error {
      color: var(--danger);
      border-color: rgba(255, 152, 152, 0.24);
      background: rgba(255, 152, 152, 0.08);
    }

    .nav-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #76c48f;
      box-shadow: 0 0 0 4px rgba(118, 196, 143, 0.14);
    }

    .nav-status.is-error .nav-dot {
      background: var(--danger);
      box-shadow: 0 0 0 4px rgba(255, 152, 152, 0.12);
    }

    .nav-next-scan { color: var(--text-tertiary); }
    .nav-status.is-error .nav-next-scan { color: inherit; }

    .page {
      max-width: 1360px;
      margin: 0 auto;
      padding: 32px 32px 56px;
    }

    .masthead {
      display: grid;
      grid-template-columns: minmax(0, 1.7fr) minmax(320px, 0.9fr);
      gap: 24px;
      align-items: stretch;
      margin-bottom: 28px;
    }

    .eyebrow {
      margin-bottom: 10px;
      color: var(--text-tertiary);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }

    .masthead-title {
      color: var(--text-primary);
      font-size: 42px;
      line-height: 1;
      letter-spacing: -1.2px;
      font-weight: 650;
      margin-bottom: 12px;
    }

    .masthead-summary {
      max-width: 760px;
      color: var(--text-secondary);
      font-size: 16px;
      line-height: 1.6;
    }

    .status-card {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 18px;
      padding: 22px 24px;
      border-radius: 24px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.075), rgba(255, 255, 255, 0.045));
      border: 1px solid var(--border-soft);
      box-shadow: var(--shadow);
    }

    .status-card-label {
      color: var(--text-tertiary);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .status-card-value {
      color: var(--text-primary);
      font-size: 22px;
      line-height: 1.2;
      letter-spacing: -0.5px;
      font-weight: 600;
    }

    .status-card-meta {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .status-chip {
      padding: 12px 14px;
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.055);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }

    .status-chip-label {
      display: block;
      color: var(--text-tertiary);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 7px;
    }

    .status-chip strong {
      color: var(--text-primary);
      font-size: 14px;
      font-weight: 600;
      letter-spacing: -0.2px;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 16px;
      margin-bottom: 36px;
    }

    .stat {
      border-radius: 24px;
      border: 1px solid var(--border-soft);
      background: var(--surface);
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.22);
    }

    .stat-primary {
      grid-column: span 4;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.085), rgba(255, 255, 255, 0.045));
    }

    .stat-primary.tone-danger {
      border-color: rgba(255, 152, 152, 0.24);
      background: linear-gradient(180deg, rgba(255, 152, 152, 0.14), rgba(255, 255, 255, 0.045));
    }

    .stat-primary.tone-active {
      border-color: rgba(155, 184, 255, 0.24);
      background: linear-gradient(180deg, rgba(155, 184, 255, 0.15), rgba(255, 255, 255, 0.045));
    }

    .stat-primary.tone-calm {
      border-color: rgba(158, 210, 180, 0.22);
      background: linear-gradient(180deg, rgba(158, 210, 180, 0.13), rgba(255, 255, 255, 0.045));
    }

    .stat-primary-row {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
    }

    .stat-primary-value {
      color: var(--text-primary);
      font-size: 58px;
      line-height: 0.9;
      font-weight: 650;
      letter-spacing: -2px;
    }

    .stat-primary-label {
      color: var(--text-primary);
      font-size: 16px;
      font-weight: 600;
      letter-spacing: -0.2px;
    }

    .stat-primary-detail {
      color: var(--text-secondary);
      font-size: 14px;
      line-height: 1.6;
    }

    .stat-secondary {
      grid-column: span 2;
      padding: 22px 20px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 20px;
      min-height: 144px;
    }

    .stat-secondary-value {
      color: var(--text-primary);
      font-size: 34px;
      line-height: 1;
      letter-spacing: -1px;
      font-weight: 640;
    }

    .stat-secondary-label {
      color: var(--text-tertiary);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }

    .section {
      margin-bottom: 34px;
    }

    .section-head {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 16px;
    }

    .section-details { width: 100%; }
    .section-details > summary { list-style: none; cursor: pointer; }
    .section-details > summary::-webkit-details-marker { display: none; }
    .section-details > summary::marker { display: none; content: ''; }

    .section-head-toggle {
      user-select: none;
    }

    .section-toggle-chevron {
      flex-shrink: 0;
      color: var(--text-tertiary);
      transition: transform 0.2s ease;
    }

    .section-details[open] > summary .section-toggle-chevron {
      transform: rotate(90deg);
    }

    .section-details > .card {
      margin-top: 0;
    }

    .section-copy {
      display: flex;
      flex-direction: column;
      gap: 7px;
    }

    .section-name {
      color: var(--text-primary);
      font-size: 18px;
      font-weight: 620;
      letter-spacing: -0.3px;
      display: inline-flex;
      align-items: center;
      gap: 10px;
    }

    .section-name svg { fill: var(--text-tertiary); }

    .section-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 26px;
      padding: 3px 9px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.065);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: var(--text-secondary);
      font-size: 11px;
      font-weight: 600;
    }

    .section-subtitle {
      color: var(--text-tertiary);
      font-size: 13px;
      line-height: 1.5;
    }

    .section-tools {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .manual-add-form {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .manual-add-input {
      width: 440px;
      height: 42px;
      padding: 0 14px;
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-primary);
      font-size: 13px;
      font-family: inherit;
      transition: border-color 0.16s ease, background 0.16s ease, box-shadow 0.16s ease;
    }

    .manual-add-input::placeholder { color: var(--text-tertiary); opacity: 1; }

    .manual-add-input:hover {
      border-color: rgba(255, 255, 255, 0.13);
      background: rgba(255, 255, 255, 0.07);
    }

    .manual-add-input:focus {
      border-color: rgba(155, 184, 255, 0.32);
      background: rgba(255, 255, 255, 0.075);
    }

    .card {
      overflow-x: auto;
      border-radius: 26px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-soft);
      box-shadow: 0 14px 34px rgba(0, 0, 0, 0.2);
    }

    .card-secondary {
      background: rgba(255, 255, 255, 0.04);
      border-color: rgba(255, 255, 255, 0.07);
      box-shadow: none;
    }

    table {
      width: 100%;
      min-width: 980px;
      border-collapse: collapse;
      table-layout: fixed;
    }

    thead th {
      padding: 14px 16px;
      text-align: left;
      color: var(--text-tertiary);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      border-bottom: 1px solid rgba(255, 255, 255, 0.065);
      background: rgba(255, 255, 255, 0.03);
      white-space: nowrap;
    }

    tbody td {
      padding: 17px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.055);
      vertical-align: middle;
      font-size: 13px;
    }

    tbody tr {
      transition: background 0.14s ease;
    }

    tbody tr:hover {
      background: rgba(255, 255, 255, 0.035);
    }

    tbody tr:last-child td { border-bottom: none; }

    .title-col { width: 320px; }
    .action-col { width: 150px; }
    .actions-cell { display: flex; align-items: center; justify-content: flex-start; width: 100%; }

    .pr-link {
      color: var(--accent-strong);
      text-decoration: none;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: -0.1px;
    }

    .pr-link:hover { color: #ffffff; }

    .pr-repo {
      display: inline-block;
      margin-bottom: 4px;
      color: var(--text-tertiary);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }

    .pr-title {
      width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-primary);
      font-size: 14px;
      line-height: 1.45;
      font-weight: 560;
      letter-spacing: -0.15px;
    }

    .pr-author {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      white-space: nowrap;
      color: var(--text-secondary);
    }

    .avatar {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.07);
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 650;
      letter-spacing: 0.02em;
      border: 1px solid transparent;
    }

    .pill-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      opacity: 0.9;
    }

    .pill-open,
    .pill-closed,
    .pill-merged {
      color: var(--text-secondary);
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(255, 255, 255, 0.08);
    }

    .pill-pending,
    .pill-reviewing,
    .pill-waiting-ci {
      color: var(--accent-strong);
      background: rgba(155, 184, 255, 0.12);
      border-color: rgba(155, 184, 255, 0.18);
    }

    .pill-reviewed {
      color: var(--reviewed);
      background: rgba(196, 210, 242, 0.12);
      border-color: rgba(196, 210, 242, 0.18);
    }

    .pill-no-go-changes {
      color: var(--text-secondary);
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(255, 255, 255, 0.08);
    }

    .pill-approved,
    .pill-ok {
      color: var(--success);
      background: rgba(158, 210, 180, 0.12);
      border-color: rgba(158, 210, 180, 0.18);
    }

    .pill-resolved {
      color: var(--resolved);
      background: rgba(143, 216, 204, 0.12);
      border-color: rgba(143, 216, 204, 0.18);
    }

    .pill-failed,
    .pill-ci-fetch-error,
    .pill-ci-failed {
      color: var(--danger);
      background: rgba(255, 152, 152, 0.12);
      border-color: rgba(255, 152, 152, 0.2);
    }

    .ci-failures-row td {
      padding: 0 !important;
    }

    .ci-failures-wrap {
      padding: 16px 24px 16px 52px;
      background: rgba(255, 152, 152, 0.04);
      border-top: 1px solid rgba(255, 152, 152, 0.1);
    }

    .ci-failures-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--danger);
      margin-bottom: 10px;
    }

    .ci-failure-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 0;
      font-size: 12px;
    }

    .ci-failure-item a {
      color: var(--accent);
      text-decoration: none;
    }

    .ci-failure-item a:hover {
      text-decoration: underline;
    }

    .ci-failure-state {
      color: var(--danger);
      font-weight: 600;
      font-size: 11px;
      min-width: 60px;
    }

    .comment-group {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      white-space: nowrap;
      font-size: 12px;
      font-weight: 600;
    }

    .comment-resolved { color: var(--text-tertiary); }
    .comment-open { color: var(--danger); }

    .time {
      color: var(--text-tertiary);
      font-size: 12px;
      white-space: nowrap;
    }

    .btn {
      height: 40px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 14px;
      padding: 0 14px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 650;
      letter-spacing: 0.01em;
      white-space: nowrap;
      color: var(--text-primary);
      background: rgba(255, 255, 255, 0.06);
      cursor: pointer;
      transition: transform 0.12s ease, border-color 0.16s ease, background 0.16s ease, color 0.16s ease;
    }

    .btn:hover {
      transform: translateY(-1px);
      border-color: rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.095);
    }

    .btn:active { transform: translateY(0); }

    .btn-primary {
      border-color: rgba(155, 184, 255, 0.26);
      background: rgba(155, 184, 255, 0.14);
      color: var(--accent-strong);
    }

    .btn-primary:hover {
      border-color: rgba(155, 184, 255, 0.34);
      background: rgba(155, 184, 255, 0.18);
      color: #fff;
    }

    .btn-danger {
      border-color: rgba(255, 152, 152, 0.26);
      background: rgba(255, 152, 152, 0.14);
      color: var(--danger);
    }

    .btn-danger:hover {
      border-color: rgba(255, 152, 152, 0.34);
      background: rgba(255, 152, 152, 0.18);
      color: #fff;
    }

    .btn:disabled,
    .btn[aria-disabled="true"] {
      cursor: not-allowed;
      transform: none;
      color: var(--text-tertiary);
      background: rgba(255, 255, 255, 0.04);
      border-color: rgba(255, 255, 255, 0.07);
      pointer-events: none;
    }

    .action-note {
      color: var(--text-tertiary);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      white-space: nowrap;
    }

    .expand-btn {
      width: 28px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid transparent;
      border-radius: 999px;
      background: transparent;
      color: var(--text-tertiary);
      cursor: pointer;
      transition: color 0.14s ease, background 0.14s ease, border-color 0.14s ease;
    }

    .expand-btn:hover {
      color: var(--text-primary);
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(255, 255, 255, 0.08);
    }

    .expand-btn svg {
      width: 12px;
      height: 12px;
      fill: currentColor;
    }

    .runs-row td {
      padding: 0 !important;
      background: rgba(255, 255, 255, 0.025);
    }

    .runs-row.hidden { display: none; }
    .runs-row:hover { background: rgba(255, 255, 255, 0.025) !important; }

    .runs-wrap {
      padding: 18px 20px 18px 56px;
    }

    .runs-label {
      margin-bottom: 10px;
      color: var(--text-tertiary);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }

    .run-card {
      display: grid;
      grid-template-columns: auto minmax(72px, 0.8fr) auto auto 1fr;
      align-items: center;
      gap: 12px;
      padding: 12px 0;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      font-size: 12px;
    }

    .run-card:first-child { border-top: none; }

    .run-type {
      color: var(--text-primary);
      font-weight: 600;
      letter-spacing: -0.1px;
      text-transform: capitalize;
    }

    .run-dur { color: var(--text-tertiary); }

    .run-err {
      color: var(--danger);
      font-size: 11px;
      word-break: break-word;
    }

    .empty {
      padding: 72px 32px;
      text-align: center;
      color: var(--text-tertiary);
      font-size: 14px;
    }

    .empty svg {
      width: 44px;
      height: 44px;
      margin-bottom: 12px;
      fill: currentColor;
      opacity: 0.28;
    }

    .toast {
      position: fixed;
      right: 24px;
      bottom: 24px;
      z-index: 200;
      padding: 12px 16px;
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(24, 28, 35, 0.92);
      color: var(--text-primary);
      font-size: 12px;
      font-weight: 600;
      backdrop-filter: blur(18px);
      box-shadow: var(--shadow);
      opacity: 0;
      transform: translateY(8px);
      transition: opacity 0.22s ease, transform 0.22s ease;
    }

    .toast.show {
      opacity: 1;
      transform: translateY(0);
    }

    .toast.error {
      color: var(--danger);
      border-color: rgba(255, 152, 152, 0.24);
      background: rgba(38, 18, 21, 0.96);
    }

    /* Lifecycle diagram */
    .lifecycle-card {
      padding: 32px;
      display: flex;
      flex-direction: column;
      gap: 0;
    }

    .lifecycle-diagram {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      padding-bottom: 24px;
    }

    .lifecycle-svg {
      display: block;
      width: 100%;
      max-width: 820px;
      height: auto;
      min-width: 620px;
      margin: 0 auto;
    }

    .lc-node rect { stroke-width: 1.2; }

    .lc-node text {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;
      font-size: 11.5px;
      font-weight: 600;
      text-anchor: middle;
      fill: currentColor;
    }

    .lc-node-active rect { fill: rgba(155,184,255,0.10); stroke: rgba(155,184,255,0.28); }
    .lc-node-active text { fill: #dce6ff; }
    .lc-node-danger rect { fill: rgba(255,152,152,0.10); stroke: rgba(255,152,152,0.28); }
    .lc-node-danger text { fill: #ff9898; }
    .lc-node-reviewed rect { fill: rgba(196,210,242,0.10); stroke: rgba(196,210,242,0.28); }
    .lc-node-reviewed text { fill: #c4d2f2; }
    .lc-node-success rect { fill: rgba(158,210,180,0.10); stroke: rgba(158,210,180,0.28); }
    .lc-node-success text { fill: #9ed2b4; }
    .lc-node-muted rect { fill: rgba(255,255,255,0.05); stroke: rgba(255,255,255,0.10); }
    .lc-node-muted text { fill: #b3bdc9; }

    .lc-edge { stroke: rgba(155,184,255,0.35); stroke-width: 1.2; fill: none; }
    .lc-edge-danger { stroke: rgba(255,152,152,0.35); }
    .lc-edge-success { stroke: rgba(158,210,180,0.35); }
    .lc-edge-muted { stroke: rgba(255,255,255,0.13); stroke-dasharray: 4 3; }

    .lc-label {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;
      font-size: 9.5px;
      font-weight: 600;
      fill: rgba(255,255,255,0.35);
      text-anchor: middle;
    }
    .lc-label-dim { fill: rgba(255,255,255,0.22); }

    .lifecycle-legend {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0;
      border-top: 1px solid var(--border-soft);
      padding-top: 20px;
    }

    .lifecycle-legend-item {
      display: flex;
      align-items: center;
      gap: 12px;
      height: 36px;
      font-size: 12px;
      color: var(--text-secondary);
      white-space: nowrap;
    }

    .lifecycle-legend-item .pill {
      flex-shrink: 0;
      width: 110px;
      justify-content: center;
      text-align: center;
    }

    .triage-example {
      border-top: 1px solid var(--border-soft);
      margin-top: 4px;
      padding-top: 20px;
    }

    .triage-example > summary { list-style: none; cursor: pointer; user-select: none; }
    .triage-example > summary::-webkit-details-marker { display: none; }
    .triage-example > summary::marker { display: none; content: ''; }
    .triage-example[open] > summary .section-toggle-chevron { transform: rotate(90deg); }
    .triage-example > summary .section-toggle-chevron { margin-left: auto; }

    .triage-example-head {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .triage-example-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .triage-example-link {
      font-size: 11px;
      color: var(--accent);
      text-decoration: none;
      opacity: 0.7;
    }
    .triage-example-link:hover { opacity: 1; text-decoration: underline; }

    .triage-example-desc {
      font-size: 12px;
      color: var(--text-secondary);
      margin-bottom: 16px;
      line-height: 1.5;
    }

    .triage-mock {
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--border-soft);
      border-radius: 10px;
      padding: 20px 24px;
      font-size: 12.5px;
      color: var(--text-secondary);
      line-height: 1.6;
      overflow-x: auto;
    }

    .triage-mock h4 {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 12px 0;
    }

    .triage-mock table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 16px;
      font-size: 12px;
    }

    .triage-mock th {
      text-align: left;
      font-weight: 600;
      color: var(--text-secondary);
      padding: 6px 12px 6px 0;
      border-bottom: 1px solid var(--border-soft);
    }

    .triage-mock td {
      padding: 6px 12px 6px 0;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      vertical-align: top;
    }

    .triage-mock code {
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 11px;
      background: rgba(255,255,255,0.06);
      padding: 1px 5px;
      border-radius: 4px;
      color: var(--text-primary);
    }

    .triage-classification {
      display: inline-block;
      font-size: 10.5px;
      font-weight: 600;
      padding: 1px 7px;
      border-radius: 4px;
    }
    .triage-classification.flaky {
      background: rgba(255,193,99,0.12);
      color: #ffc163;
    }
    .triage-classification.infra {
      background: rgba(155,184,255,0.12);
      color: #9bb8ff;
    }
    .triage-classification.regression {
      background: rgba(255,152,152,0.12);
      color: #ff9898;
    }

    .triage-detail-block {
      background: rgba(255,255,255,0.02);
      border-left: 2px solid var(--border-soft);
      padding: 8px 14px;
      margin-bottom: 10px;
      border-radius: 0 6px 6px 0;
    }

    .triage-detail-block strong {
      color: var(--text-primary);
      font-size: 12px;
    }

    .triage-detail-block .triage-detail-row {
      display: flex;
      gap: 6px;
      margin-top: 3px;
      font-size: 11.5px;
    }

    .triage-detail-block .triage-detail-row span:first-child {
      color: var(--text-tertiary);
      flex-shrink: 0;
    }

    .triage-mock-footer {
      font-size: 11px;
      color: var(--text-tertiary);
      font-style: italic;
      border-top: 1px solid var(--border-soft);
      padding-top: 10px;
      margin-top: 8px;
    }

    @media (max-width: 900px) {
      .lifecycle-legend { grid-template-columns: repeat(2, 1fr); }
    }

    @media (max-width: 1180px) {
      .navbar,
      .page { padding-left: 24px; padding-right: 24px; }

      .masthead { grid-template-columns: 1fr; }
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .stat-primary,
      .stat-secondary { grid-column: span 1; }
      .section-head { flex-wrap: wrap; align-items: flex-start; }
      .section-tools { width: 100%; justify-content: flex-start; }
      .manual-add-input { width: 100%; }
    }

    @media (max-width: 640px) {
      .navbar { height: 56px; padding: 0 16px; gap: 12px; }
      .nav-meta { display: none; }
      .nav-next-scan { display: none; }
      .page { padding: 20px 16px 40px; }
      .masthead { gap: 16px; margin-bottom: 20px; }
      .masthead-title { font-size: 28px; letter-spacing: -0.8px; }
      .masthead-summary { font-size: 14px; }
      .status-card { padding: 18px 16px; border-radius: 20px; }
      .status-card-meta { grid-template-columns: 1fr; gap: 8px; }
      .stats { grid-template-columns: 1fr; gap: 10px; margin-bottom: 24px; }
      .stat-primary,
      .stat-secondary { grid-column: span 1; }
      .stat-primary { padding: 18px 16px; border-radius: 18px; }
      .stat-primary-value { font-size: 40px; letter-spacing: -1.4px; }
      .stat-secondary { padding: 16px 14px; border-radius: 18px; min-height: auto; gap: 12px; }
      .stat-secondary-value { font-size: 26px; }
      .section-head { gap: 12px; }
      .section-name { font-size: 16px; }
      .manual-add-form { flex-direction: column; gap: 8px; width: 100%; }
      .manual-add-input { width: 100%; height: 38px; font-size: 14px; }
      .btn { height: 38px; font-size: 12px; }
      .card { border-radius: 18px; }
      table { min-width: 700px; }
      .lifecycle-legend { grid-template-columns: 1fr; }
      .triage-mock { padding: 14px 16px; }
    }

    /* Skeleton loading */
    @keyframes skeleton-pulse {
      0%, 100% { opacity: 0.06; }
      50% { opacity: 0.12; }
    }

    .skeleton {
      background: rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      animation: skeleton-pulse 1.8s ease-in-out infinite;
    }

    .skeleton-stats {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 16px;
    }

    .skeleton-stat-primary {
      grid-column: span 4;
      height: 160px;
      border-radius: 24px;
    }

    .skeleton-stat-secondary {
      grid-column: span 2;
      height: 144px;
      border-radius: 24px;
    }

    .skeleton-row {
      height: 56px;
      margin-bottom: 2px;
    }

    @media (max-width: 1180px) {
      .skeleton-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .skeleton-stat-primary,
      .skeleton-stat-secondary { grid-column: span 1; }
    }

    @media (max-width: 640px) {
      .skeleton-stats { grid-template-columns: 1fr; }
      .skeleton-stat-primary { height: 120px; border-radius: 18px; }
      .skeleton-stat-secondary { height: 100px; border-radius: 18px; }
    }

    /* Reduced motion */
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
    }
  </style>
</head>
<body>
  <a class="sr-only" href="#pr-body">Skip to pull requests</a>
  <nav class="navbar" role="navigation" aria-label="Main navigation">
    <div class="nav-left">
      <div class="nav-logo" aria-hidden="true">R</div>
      <div class="nav-title">
        <strong>RaaS</strong>
        <span>Review Operations</span>
      </div>
    </div>
    <div class="nav-right">
      <div class="nav-meta" id="config-info" aria-label="Configuration"></div>
      <div class="nav-status" id="live-status" role="status" aria-live="polite">
        <span class="nav-dot" aria-hidden="true"></span>
        <span id="live-status-label">Live monitoring</span>
        <span class="nav-next-scan" id="next-scan-label">No schedule</span>
      </div>
    </div>
  </nav>

  <div class="page">
    <section class="masthead">
      <div>
        <p class="eyebrow">Review Operations</p>
        <h1 class="masthead-title">Pull request review queue</h1>
        <p class="masthead-summary" id="dashboard-summary">Monitoring tracked pull requests and review activity.</p>
      </div>
      <div class="status-card">
        <div>
          <div class="status-card-label">Automation</div>
          <div class="status-card-value" id="status-card-summary">Waiting for the first sync.</div>
        </div>
        <div class="status-card-meta">
          <div class="status-chip">
            <span class="status-chip-label">Last updated</span>
            <strong id="last-updated-label">Waiting</strong>
          </div>
          <div class="status-chip">
            <span class="status-chip-label">Next scan</span>
            <strong id="next-scan-card-label">No schedule</strong>
          </div>
        </div>
      </div>
    </section>

    <section class="stats" id="stats-row" role="region" aria-label="Review statistics">
      <div class="skeleton skeleton-stat-primary" id="skel-stat-1"></div>
      <div class="skeleton skeleton-stat-secondary" id="skel-stat-2"></div>
      <div class="skeleton skeleton-stat-secondary" id="skel-stat-3"></div>
      <div class="skeleton skeleton-stat-secondary" id="skel-stat-4"></div>
      <div class="skeleton skeleton-stat-secondary" id="skel-stat-5"></div>
    </section>

    <section class="section">
      <div class="section-head">
        <div class="section-copy">
          <div class="section-name">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.25a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zm5.677-.177L9.573.677A.25.25 0 0110 .854V2.5h1A2.5 2.5 0 0113.5 5v5.628a2.251 2.251 0 11-1.5 0V5a1 1 0 00-1-1h-1v1.646a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm0 9.5a.75.75 0 100 1.5.75.75 0 000-1.5zm8.25.75a.75.75 0 10-1.5 0 .75.75 0 001.5 0z"/></svg>
            Pull Requests
            <span class="section-count" id="pr-count">0</span>
          </div>
          <div class="section-subtitle" id="pr-summary">Tracked pull requests and their current review state.</div>
        </div>
        <div class="section-tools">
          <form class="manual-add-form" id="manual-add-form" role="search" aria-label="Add pull request">
            <label for="manual-add-input" class="sr-only">Pull request number or URL</label>
            <input
              id="manual-add-input"
              class="manual-add-input"
              type="text"
              placeholder="#66738 / pingcap/tidb#66738 / GitHub PR URL"
              autocomplete="off"
              aria-describedby="manual-add-hint"
            >
            <span id="manual-add-hint" class="sr-only">Enter a PR number, repo#number, or GitHub PR URL</span>
            <button class="btn btn-primary" id="manual-add-btn" type="submit">Add to Queue</button>
          </form>
        </div>
      </div>
      <div class="card" role="region" aria-label="Pull request list">
        <table aria-label="Pull requests">
          <colgroup>
            <col style="width:36px">
            <col style="width:130px">
            <col class="title-col" style="width:320px">
            <col style="width:120px">
            <col style="width:92px">
            <col style="width:110px">
            <col style="width:150px">
            <col style="width:110px">
            <col style="width:150px">
          </colgroup>
          <thead>
            <tr>
              <th scope="col"><span class="sr-only">Expand</span></th>
              <th scope="col">PR</th>
              <th scope="col">Title</th>
              <th scope="col">Author</th>
              <th scope="col">State</th>
              <th scope="col">Review</th>
              <th scope="col">Comments</th>
              <th scope="col">Last Review</th>
              <th scope="col" class="action-col">Action</th>
            </tr>
          </thead>
          <tbody id="pr-body" aria-live="polite">
            <tr><td colspan="9">
              <div style="padding: 20px 16px; display: flex; flex-direction: column; gap: 6px;">
                <div class="skeleton skeleton-row" id="skel-pr-1"></div>
                <div class="skeleton skeleton-row" id="skel-pr-2"></div>
                <div class="skeleton skeleton-row" id="skel-pr-3"></div>
              </div>
            </td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="section">
      <details class="section-details" id="scans-section">
        <summary class="section-head section-head-toggle" aria-label="Toggle recent scans section">
          <div class="section-copy">
            <div class="section-name">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.001 7.001 0 0115 8a.75.75 0 01-1.5 0A5.5 5.5 0 008 2.5zM2.5 8a.75.75 0 00-1.5 0 7.001 7.001 0 0012.193 4.693l1.38 1.38a.25.25 0 00.427-.177V10.25a.25.25 0 00-.25-.25h-3.646a.25.25 0 00-.177.427l1.204 1.204A5.5 5.5 0 012.5 8z"/></svg>
              Recent Scans
              <span class="section-count">${RECENT_SCAN_LIMIT}</span>
            </div>
            <div class="section-subtitle">Latest scan activity and review handoffs.</div>
          </div>
          <svg class="section-toggle-chevron" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z" fill="currentColor"/></svg>
        </summary>
        <div class="card card-secondary" role="region" aria-label="Recent scans">
          <table aria-label="Scan history">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">PRs Found</th>
                <th scope="col">Reviews Triggered</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody id="scan-body" aria-live="polite"></tbody>
          </table>
        </div>
      </details>
    </section>

    <section class="section">
      <div class="section-head">
        <div class="section-copy">
          <div class="section-name">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0zM8 0a8 8 0 100 16A8 8 0 008 0zm.5 4.75a.75.75 0 00-1.5 0v3.5a.75.75 0 00.37.65l2.5 1.5a.75.75 0 10.76-1.3L8.5 7.94V4.75z"/></svg>
            Review Lifecycle
          </div>
          <div class="section-subtitle">How a pull request moves through the review pipeline.</div>
        </div>
      </div>
      <div class="card lifecycle-card">
        <div class="lifecycle-diagram">
          <svg viewBox="0 -16 800 190" xmlns="http://www.w3.org/2000/svg" class="lifecycle-svg">
            <!--
              Grid: 5 columns x 2 rows.  Orthogonal edges with r=8 rounded corners.
              Col centers:  70   220   390   560   730
              Row centers:  40   120
              Node: w=112 h=36 rx=10  (wide: w=120)
              Edges: top=22 bottom=58 left=cx-56 right=cx+56  (wide: cx-60/+60)
            -->
            <defs>
              <marker id="ah" markerWidth="7" markerHeight="6" refX="6.5" refY="3" orient="auto"><path d="M0.5,0.5 L6,3 L0.5,5.5" fill="none" stroke="rgba(155,184,255,0.5)" stroke-width="1" stroke-linejoin="round"/></marker>
              <marker id="ah-r" markerWidth="7" markerHeight="6" refX="6.5" refY="3" orient="auto"><path d="M0.5,0.5 L6,3 L0.5,5.5" fill="none" stroke="rgba(255,152,152,0.5)" stroke-width="1" stroke-linejoin="round"/></marker>
              <marker id="ah-g" markerWidth="7" markerHeight="6" refX="6.5" refY="3" orient="auto"><path d="M0.5,0.5 L6,3 L0.5,5.5" fill="none" stroke="rgba(158,210,180,0.5)" stroke-width="1" stroke-linejoin="round"/></marker>
              <marker id="ah-m" markerWidth="7" markerHeight="6" refX="6.5" refY="3" orient="auto"><path d="M0.5,0.5 L6,3 L0.5,5.5" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="1" stroke-linejoin="round"/></marker>
            </defs>

            <!-- Row 0 -->
            <g class="lc-node lc-node-muted"><rect x="14" y="22" width="112" height="36" rx="10"/><text x="70" y="40" dy="0.35em">New PR</text></g>
            <g class="lc-node lc-node-active"><rect x="160" y="22" width="120" height="36" rx="10"/><text x="220" y="40" dy="0.35em">waiting-ci</text></g>
            <g class="lc-node lc-node-active"><rect x="334" y="22" width="112" height="36" rx="10"/><text x="390" y="40" dy="0.35em">pending</text></g>
            <g class="lc-node lc-node-active"><rect x="500" y="22" width="120" height="36" rx="10"/><text x="560" y="40" dy="0.35em">reviewing</text></g>
            <g class="lc-node lc-node-reviewed"><rect x="674" y="22" width="112" height="36" rx="10"/><text x="730" y="40" dy="0.35em">reviewed</text></g>

            <!-- Row 1 -->
            <g class="lc-node lc-node-danger"><rect x="160" y="102" width="120" height="36" rx="10"/><text x="220" y="120" dy="0.35em">ci-failed</text></g>
            <g class="lc-node lc-node-danger"><rect x="504" y="102" width="112" height="36" rx="10"/><text x="560" y="120" dy="0.35em">failed</text></g>
            <g class="lc-node lc-node-success"><rect x="674" y="102" width="112" height="36" rx="10"/><text x="730" y="120" dy="0.35em">resolved</text></g>

            <!-- === Edges === -->

            <!-- 1. New PR → waiting-ci (straight) -->
            <line x1="126" y1="40" x2="156" y2="40" class="lc-edge" marker-end="url(#ah)"/>
            <text x="141" y="34" class="lc-label">TiDB</text>

            <!-- 2. Non-TiDB: New PR top → up → right → down → pending top -->
            <path d="M 70 22 V 8 A 8 8 0 0 1 78 0 H 382 A 8 8 0 0 1 390 8 V 18" class="lc-edge lc-edge-muted" marker-end="url(#ah-m)"/>
            <text x="230" y="-4" class="lc-label lc-label-dim">non-TiDB</text>

            <!-- 3. waiting-ci → pending (straight) -->
            <line x1="280" y1="40" x2="330" y2="40" class="lc-edge" marker-end="url(#ah)"/>
            <text x="305" y="34" class="lc-label">CI pass</text>

            <!-- 4. waiting-ci → ci-failed (straight down) -->
            <line x1="220" y1="58" x2="220" y2="98" class="lc-edge lc-edge-danger" marker-end="url(#ah-r)"/>
            <text x="234" y="82" class="lc-label">fail</text>

            <!-- 5. Recover: ci-failed left → left → up → right → waiting-ci left -->
            <path d="M 160 120 H 148 A 8 8 0 0 1 140 112 V 48 A 8 8 0 0 1 148 40 H 156" class="lc-edge" marker-end="url(#ah)"/>
            <text x="112" y="80" class="lc-label lc-label-dim">recover</text>

            <!-- 6. pending → reviewing (straight) -->
            <line x1="446" y1="40" x2="496" y2="40" class="lc-edge" marker-end="url(#ah)"/>
            <text x="471" y="34" class="lc-label">run</text>

            <!-- 7. reviewing → reviewed (straight) -->
            <line x1="620" y1="40" x2="670" y2="40" class="lc-edge lc-edge-success" marker-end="url(#ah-g)"/>
            <text x="645" y="34" class="lc-label">done</text>

            <!-- 8. reviewing → failed (straight down) -->
            <line x1="560" y1="58" x2="560" y2="98" class="lc-edge lc-edge-danger" marker-end="url(#ah-r)"/>
            <text x="574" y="82" class="lc-label">error</text>

            <!-- 9. Retry: failed top → up to y=80 → left to x=396 → up → pending bottom -->
            <path d="M 560 102 V 88 A 8 8 0 0 0 552 80 H 404 A 8 8 0 0 1 396 72 V 58" class="lc-edge" marker-end="url(#ah)"/>
            <text x="478" y="74" class="lc-label">retry</text>

            <!-- 10. reviewed → resolved (straight down) -->
            <line x1="730" y1="58" x2="730" y2="98" class="lc-edge lc-edge-success" marker-end="url(#ah-g)"/>
            <text x="766" y="82" class="lc-label lc-label-dim">resolve</text>

            <!-- 11. Recheck: resolved bottom → down to y=158 → left to x=384 → up → pending bottom -->
            <path d="M 730 138 V 150 A 8 8 0 0 1 722 158 H 392 A 8 8 0 0 1 384 150 V 58" class="lc-edge lc-edge-muted" marker-end="url(#ah-m)"/>
            <text x="557" y="170" class="lc-label lc-label-dim">recheck</text>
          </svg>
        </div>
        <div class="lifecycle-legend">
          <div class="lifecycle-legend-item"><span class="pill pill-waiting-ci"><span class="pill-dot"></span>waiting-ci</span>CI checks still running</div>
          <div class="lifecycle-legend-item"><span class="pill pill-ci-failed"><span class="pill-dot"></span>ci-failed</span>CI failed, use Triage CI</div>
          <div class="lifecycle-legend-item"><span class="pill pill-pending"><span class="pill-dot"></span>pending</span>Review queued</div>
          <div class="lifecycle-legend-item"><span class="pill pill-reviewing"><span class="pill-dot"></span>reviewing</span>Codex running</div>
          <div class="lifecycle-legend-item"><span class="pill pill-reviewed"><span class="pill-dot"></span>reviewed</span>Has open comments</div>
          <div class="lifecycle-legend-item"><span class="pill pill-resolved"><span class="pill-dot"></span>resolved</span>All comments resolved</div>
          <div class="lifecycle-legend-item"><span class="pill pill-failed"><span class="pill-dot"></span>failed</span>Run errored, will retry</div>
          <div class="lifecycle-legend-item"><span class="pill pill-approved"><span class="pill-dot"></span>approved</span>Has approved label</div>
          <div class="lifecycle-legend-item"><span class="pill pill-no-go-changes"><span class="pill-dot"></span>no-go-changes</span>No .go files, skipped</div>
        </div>

        <details class="triage-example">
          <summary class="triage-example-head">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm9-3a1 1 0 11-2 0 1 1 0 012 0zM6.75 8a.75.75 0 000 1.5h.5v2h-.5a.75.75 0 000 1.5h2.5a.75.75 0 000-1.5H9V8z"/></svg>
            <span class="triage-example-title">What is Triage CI?</span>
            <a class="triage-example-link" href="https://github.com/GMHDBJD/skills/tree/main/dont-retest" target="_blank" rel="noopener">dont-retest skill &nearr;</a>
            <svg class="section-toggle-chevron" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z" fill="currentColor"/></svg>
          </summary>
          <div class="triage-example-desc">
            When a PR enters <strong>ci-failed</strong>, clicking <strong>Triage CI</strong> invokes Codex with the
            <a class="triage-example-link" href="https://github.com/GMHDBJD/skills/tree/main/dont-retest" target="_blank" rel="noopener">dont-retest</a>
            skill. It collects every failing CI check, extracts failure signatures from logs, classifies the root cause, and posts a structured report as a PR comment. Below is an example of the report it produces:
          </div>

          <div class="triage-mock">
            <h4>CI Failure Triage Report</h4>
            <table>
              <thead>
                <tr><th>Check</th><th>Classification</th><th>Confidence</th><th>Signature</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td><code>idc-jenkins-ci-tidb/unit-test</code></td>
                  <td><span class="triage-classification flaky">probable_flaky</span></td>
                  <td>medium</td>
                  <td><code>TestIndexMerge: timeout after 300s</code></td>
                </tr>
                <tr>
                  <td><code>pull-unit-test-next-gen</code></td>
                  <td><span class="triage-classification infra">probable_infra</span></td>
                  <td>high</td>
                  <td><code>OOMKilled</code></td>
                </tr>
                <tr>
                  <td><code>idc-jenkins-ci-tidb/build</code></td>
                  <td><span class="triage-classification regression">pr_regression</span></td>
                  <td>high</td>
                  <td><code>planner/core: undefined: plannercore.NewCtx</code></td>
                </tr>
              </tbody>
            </table>

            <div class="triage-detail-block">
              <strong><code>idc-jenkins-ci-tidb/unit-test</code> &mdash; <span class="triage-classification flaky">probable_flaky</span> (medium)</strong>
              <div class="triage-detail-row"><span>Failing test:</span> <span><code>TestIndexMerge</code> in <code>pkg/executor/test/...</code></span></div>
              <div class="triage-detail-row"><span>Signature:</span> <span><code>timeout after 300s</code></span></div>
              <div class="triage-detail-row"><span>Evidence:</span> <span>This test has timed out 3 times this week on unrelated PRs</span></div>
              <div class="triage-detail-row"><span>Log:</span> <span><a class="triage-example-link" href="#" onclick="return false">Jenkins link &nearr;</a></span></div>
            </div>

            <div class="triage-detail-block">
              <strong><code>pull-unit-test-next-gen</code> &mdash; <span class="triage-classification infra">probable_infra</span> (high)</strong>
              <div class="triage-detail-row"><span>Failing test:</span> <span>N/A (infrastructure failure)</span></div>
              <div class="triage-detail-row"><span>Signature:</span> <span><code>OOMKilled</code></span></div>
              <div class="triage-detail-row"><span>Evidence:</span> <span>Pod killed by OOM before tests started</span></div>
              <div class="triage-detail-row"><span>Log:</span> <span><a class="triage-example-link" href="#" onclick="return false">Prow link &nearr;</a></span></div>
            </div>

            <div class="triage-detail-block">
              <strong><code>idc-jenkins-ci-tidb/build</code> &mdash; <span class="triage-classification regression">pr_regression</span> (high)</strong>
              <div class="triage-detail-row"><span>Failing test:</span> <span><code>build</code> (compilation error)</span></div>
              <div class="triage-detail-row"><span>Signature:</span> <span><code>planner/core: undefined: plannercore.NewCtx</code></span></div>
              <div class="triage-detail-row"><span>Evidence:</span> <span>Error is in <code>pkg/planner/core/</code>, touched by this PR</span></div>
              <div class="triage-detail-row"><span>Log:</span> <span><a class="triage-example-link" href="#" onclick="return false">Jenkins link &nearr;</a></span></div>
            </div>

            <div class="triage-mock-footer">Generated by RaaS CI Triage &mdash; report only, no actions taken</div>
          </div>
        </details>
      </div>
    </section>
  </div>

  <div class="toast" id="toast" role="alert" aria-live="assertive">Updated</div>

  <script>
    const RECENT_SCAN_LIMIT = ${RECENT_SCAN_LIMIT};
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/[<]/g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    function timeAgo(iso) {
      if (!iso) return 'Never';
      const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
      if (isNaN(d)) return iso;
      const s = Math.floor((Date.now() - d) / 1000);
      if (s < 0) return 'just now';
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      return Math.floor(s / 86400) + 'd ago';
    }

    function duration(ms) {
      if (!ms && ms !== 0) return '-';
      if (ms < 1000) return ms + 'ms';
      if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
      return (ms / 60000).toFixed(1) + 'min';
    }

    function formatClockTime(value) {
      if (!value) return 'No schedule';
      const d = new Date(value);
      if (isNaN(d)) return 'No schedule';
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }

    function formatDateTime(value) {
      const d = value instanceof Date ? value : new Date(value);
      if (isNaN(d)) return 'Unavailable';
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }

    function formatCount(value, noun) {
      return value + ' ' + noun + (value === 1 ? '' : 's');
    }

    function getHeadlineState(stats) {
      const queue = stats.pending_reviews + stats.reviewing;

      if (stats.total_unresolved > 0) {
        return {
          tone: 'danger',
          eyebrow: 'Needs attention',
          value: stats.total_unresolved,
          label: 'Unresolved comments',
          detail: queue > 0
            ? 'Open conversations are holding the queue open while ' + formatCount(queue, 'review') + ' stays in motion.'
            : 'Open conversations are blocking a calm queue.'
        };
      }

      if (queue > 0) {
        return {
          tone: 'active',
          eyebrow: 'In progress',
          value: queue,
          label: 'Reviews in motion',
          detail: stats.open_prs > 0
            ? formatCount(stats.open_prs, 'open pull request') + ' are under watch while the queue keeps moving.'
            : 'The service is moving review work forward without open drift.'
        };
      }

      return {
        tone: 'calm',
        eyebrow: 'Steady state',
        value: stats.open_prs,
        label: stats.open_prs === 1 ? 'Open pull request' : 'Open pull requests',
        detail: stats.total_prs > 0
          ? formatCount(stats.total_prs, 'tracked pull request') + ' are visible and nothing urgent is pressing on the queue.'
          : 'Nothing is waiting for review right now.'
      };
    }

    function renderStats(stats) {
      const queue = stats.pending_reviews + stats.reviewing;
      const headline = getHeadlineState(stats);
      const secondary = [
        { label: 'Review queue', value: queue },
        { label: 'Tracked PRs', value: stats.total_prs },
        { label: 'Open PRs', value: stats.open_prs },
        { label: 'Comments', value: stats.total_comments },
      ];

      const primaryCard =
        '<div class="stat stat-primary tone-' + headline.tone + '">' +
          '<div>' +
            '<div class="eyebrow">' + headline.eyebrow + '</div>' +
            '<div class="stat-primary-row">' +
              '<div>' +
                '<div class="stat-primary-value">' + headline.value + '</div>' +
                '<div class="stat-primary-label">' + headline.label + '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="stat-primary-detail">' + headline.detail + '</div>' +
        '</div>';

      const secondaryCards = secondary.map((item) =>
        '<div class="stat stat-secondary">' +
          '<div class="stat-secondary-label">' + item.label + '</div>' +
          '<div class="stat-secondary-value">' + item.value + '</div>' +
        '</div>'
      ).join('');

      document.getElementById('stats-row').innerHTML = primaryCard + secondaryCards;
    }

    function renderDashboardSummary(stats, prs, status) {
      const queue = stats.pending_reviews + stats.reviewing;
      const needsAttention = prs.filter((pr) => pr.unresolved_count > 0).length;
      const nextScan = status?.next_scan_at ? 'next scan ' + formatClockTime(status.next_scan_at) : 'no scan scheduled';
      let summary = 'No pull requests are being tracked right now; the scanner is waiting for the next review cycle.';

      if (prs.length) {
        if (needsAttention > 0) {
          summary = formatCount(prs.length, 'tracked pull request') + ' are in view, and ' +
            formatCount(needsAttention, 'thread') + ' still need closure before the queue can settle.';
        } else if (queue > 0) {
          summary = formatCount(prs.length, 'tracked pull request') + ' are in view, and the queue is moving with ' +
            formatCount(queue, 'active review') + '. ' + nextScan + '.';
        } else {
          summary = formatCount(prs.length, 'tracked pull request') + ' are in view, and the queue feels clear for now.';
        }
      }

      const statusCardSummary = needsAttention > 0
        ? 'Open threads are holding the queue open.'
        : queue > 0
          ? 'Reviews are in motion and the queue is moving.'
          : prs.length
            ? 'The queue is calm and nothing urgent is waiting.'
            : 'Waiting for the next review cycle.';

      document.getElementById('dashboard-summary').textContent = summary;
      document.getElementById('status-card-summary').textContent = statusCardSummary;
    }

    function manualActionLabel(reason) {
      const text = String(reason || '').toLowerCase();
      if (!text) return 'Unavailable';
      if (text.includes('already running')) return 'Running';
      if (text.includes('already queued')) return 'Queued';
      if (text.includes('already approved')) return 'Approved';
      if (text.includes('no .go file changes')) return 'No Go changes';
      if (text.includes('resolved pr')) return 'Awaiting CI';
      if (text.includes('only resolved')) return 'Resolve comments first';
      if (text.includes('initial review')) return 'Auto after CI';
      if (text.includes('only available')) return 'TiDB only';
      if (text.includes('pr is')) return 'Unavailable';
      return 'Unavailable';
    }

    function renderPRs(prs) {
      const count = document.getElementById('pr-count');
      const summary = document.getElementById('pr-summary');
      count.textContent = prs.length;

      const unresolvedPRs = prs.filter((pr) => pr.unresolved_count > 0).length;
      const activeReviews = prs.filter((pr) => pr.review_status === 'pending' || pr.review_status === 'reviewing').length;
      summary.textContent = prs.length
        ? unresolvedPRs > 0
          ? formatCount(unresolvedPRs, 'open conversation') + ' are keeping this queue from going quiet.'
          : activeReviews > 0
            ? formatCount(activeReviews, 'review') + ' are in flight and the queue is moving cleanly.'
            : 'No open conversations are pushing on the queue right now.'
        : 'No pull requests are being tracked yet.';

      if (!prs.length) {
        document.getElementById('pr-body').innerHTML =
          '<tr><td colspan="9"><div class="empty">' +
          '<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M11.5 7a4.499 4.499 0 11-8.998 0A4.499 4.499 0 0111.5 7zm-.82 4.74a6 6 0 111.06-1.06l3.04 3.04a.75.75 0 11-1.06 1.06l-3.04-3.04z"/></svg>' +
          '<div>No pull requests are in the review queue yet.</div></div></td></tr>';
        return;
      }

      let html = '';
      for (const pr of prs) {
        const resolved = pr.comment_count - pr.unresolved_count;
        const manualTitle = esc(pr.manual_trigger_reason || '');
        let manualAction;
        if (pr.repo === 'pingcap/tidb') {
          if (pr.review_status === 'ci-failed') {
            manualAction = '<button class="btn btn-danger ci-triage-btn" data-id="' + pr.id + '">Triage CI</button>';
          } else if (pr.manual_trigger_available) {
            manualAction = '<button class="btn btn-primary manual-trigger-btn" data-id="' + pr.id + '">Trigger Review</button>';
          } else {
            manualAction = '<span class="action-note" title="' + manualTitle + '">' + esc(manualActionLabel(pr.manual_trigger_reason)) + '</span>';
          }
        } else {
          manualAction = '<span class="action-note">TiDB only</span>';
        }

        html +=
          '<tr>' +
            '<td><button class="expand-btn" data-id="' + pr.id + '" title="Show review runs" aria-label="Show review runs for PR #' + pr.number + '" aria-expanded="false">' +
              '<svg viewBox="0 0 16 16" class="chevron"><path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z"/></svg>' +
            '</button></td>' +
            '<td><span class="pr-repo">' + esc(pr.repo) + '</span><br>' +
              '<a class="pr-link" href="https://github.com/' + esc(pr.repo) + '/pull/' + pr.number + '" target="_blank" rel="noreferrer noopener">#' + pr.number + '</a></td>' +
            '<td><div class="pr-title" title="' + esc(pr.title) + '">' + esc(pr.title) + '</div></td>' +
            '<td><span class="pr-author"><img class="avatar" src="https://github.com/' + esc(pr.author) + '.png?size=40" alt=""><span>' + esc(pr.author) + '</span></span></td>' +
            '<td><span class="pill pill-' + pr.state + '"><span class="pill-dot"></span>' + esc(pr.state) + '</span></td>' +
            '<td><span class="pill pill-' + pr.review_status + '"><span class="pill-dot"></span>' + esc(pr.review_status) + '</span></td>' +
            '<td><div class="comment-group">' +
              '<span class="comment-resolved">' + resolved + ' resolved</span>' +
              '<span class="comment-open">' + pr.unresolved_count + ' open</span>' +
            '</div></td>' +
            '<td><span class="time">' + timeAgo(pr.last_reviewed_at) + '</span></td>' +
            '<td class="action-col"><div class="actions-cell">' + manualAction + '</div></td>' +
          '</tr>' +
          '<tr class="runs-row hidden" id="runs-' + pr.id + '"><td colspan="9"><div class="runs-wrap"><div class="runs-label">Review Runs</div><div class="runs-list">Loading...</div></div></td></tr>' +
          (pr.review_status === 'ci-failed'
            ? '<tr class="ci-failures-row" id="ci-failures-' + pr.id + '"><td colspan="9"><div class="ci-failures-wrap"><div class="ci-failures-label">Failing CI Checks</div><div class="ci-failures-list">Loading...</div></div></td></tr>'
            : '');
      }

      document.getElementById('pr-body').innerHTML = html;

      // Auto-load CI failure details for ci-failed PRs
      for (const pr of prs) {
        if (pr.review_status === 'ci-failed') {
          loadCIFailures(pr.id);
        }
      }
    }

    function renderScans(logs) {
      if (!logs.length) {
        document.getElementById('scan-body').innerHTML =
          '<tr><td colspan="4"><div class="empty" style="padding:40px 32px">No scans yet</div></td></tr>';
        return;
      }

      document.getElementById('scan-body').innerHTML = logs.map((log) =>
        '<tr>' +
          '<td><span class="time">' + timeAgo(log.started_at) + '</span></td>' +
          '<td>' + log.prs_found + '</td>' +
          '<td>' + log.reviews_triggered + '</td>' +
          '<td>' + (
            log.errors
              ? '<span class="pill pill-failed"><span class="pill-dot"></span>Error</span>'
              : '<span class="pill pill-ok"><span class="pill-dot"></span>OK</span>'
          ) + '</td>' +
        '</tr>'
      ).join('');
    }

    function renderStatus(status) {
      const nextScanLabel = document.getElementById('next-scan-label');
      const nextScanCardLabel = document.getElementById('next-scan-card-label');
      const nextScanText = status?.next_scan_at ? 'Next scan ' + formatClockTime(status.next_scan_at) : 'No schedule';

      nextScanLabel.textContent = nextScanText;
      nextScanLabel.title = status?.next_scan_at || '';
      nextScanCardLabel.textContent = status?.next_scan_at ? formatClockTime(status.next_scan_at) : 'No schedule';
    }

    function setLiveStatus(isHealthy) {
      const status = document.getElementById('live-status');
      const label = document.getElementById('live-status-label');
      status.classList.toggle('is-error', !isHealthy);
      label.textContent = isHealthy ? 'Live monitoring' : 'Refresh failed';
    }

    function setLastUpdated(value) {
      document.getElementById('last-updated-label').textContent = formatDateTime(value);
    }

    async function loadRuns(prId) {
      const row = document.getElementById('runs-' + prId);
      const list = row.querySelector('.runs-list');

      try {
        const runs = await fetch('/api/prs/' + prId + '/runs').then((res) => res.json());
        if (!runs.length) {
          list.innerHTML = '<div class="time">No review runs yet.</div>';
          return;
        }

        list.innerHTML = runs.map((run) =>
          '<div class="run-card">' +
            '<span class="pill pill-' + run.status + '"><span class="pill-dot"></span>' + esc(run.status) + '</span>' +
            '<span class="run-type">' + esc(run.type) + '</span>' +
            '<span class="run-dur">' + duration(run.duration_ms) + '</span>' +
            '<span class="time">' + timeAgo(run.started_at) + '</span>' +
            '<span class="run-err">' + (run.error ? esc(run.error) : '') + '</span>' +
          '</div>'
        ).join('');
      } catch {
        list.innerHTML = '<div class="run-err">Failed to load review runs.</div>';
      }
    }

    document.addEventListener('click', (event) => {
      const btn = event.target.closest('.expand-btn');
      if (!btn) return;

      const id = btn.dataset.id;
      const row = document.getElementById('runs-' + id);
      const hidden = row.classList.toggle('hidden');
      const chevron = btn.querySelector('.chevron');
      chevron.style.transform = hidden ? '' : 'rotate(90deg)';
      chevron.style.transition = 'transform 0.15s ease';
      btn.setAttribute('aria-expanded', String(!hidden));

      if (!hidden) loadRuns(id);
    });

    document.addEventListener('click', async (event) => {
      const btn = event.target.closest('.manual-trigger-btn');
      if (!btn || btn.disabled) return;

      const id = btn.dataset.id;
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'Queueing...';

      try {
        const res = await fetch('/api/prs/' + id + '/manual-trigger', { method: 'POST' });
        const payload = await res.json();
        if (!res.ok || !payload.ok) {
          throw new Error(payload.error || 'Manual trigger failed.');
        }
        showToast(payload.message || 'Manual review trigger queued.');
        refreshNow();
      } catch (err) {
        showToast(err.message || 'Manual review trigger failed.', true);
      } finally {
        btn.textContent = original;
        btn.disabled = false;
      }
    });

    // CI triage button handler
    document.addEventListener('click', async (event) => {
      const btn = event.target.closest('.ci-triage-btn');
      if (!btn || btn.disabled) return;

      const id = btn.dataset.id;
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'Queueing...';

      try {
        const res = await fetch('/api/prs/' + id + '/ci-triage', { method: 'POST' });
        const payload = await res.json();
        if (!res.ok || !payload.ok) {
          throw new Error(payload.error || 'CI triage trigger failed.');
        }
        showToast(payload.message || 'CI triage queued.');
        refreshNow();
      } catch (err) {
        showToast(err.message || 'CI triage trigger failed.', true);
      } finally {
        btn.textContent = original;
        btn.disabled = false;
      }
    });

    // Auto-load CI failure details for ci-failed PRs
    async function loadCIFailures(prId) {
      const row = document.getElementById('ci-failures-' + prId);
      if (!row) return;
      const list = row.querySelector('.ci-failures-list');

      try {
        const data = await fetch('/api/prs/' + prId + '/ci-failures').then((res) => res.json());
        if (!data.ok || !data.failures.length) {
          list.innerHTML = '<div class="time">No failing checks found.</div>';
          return;
        }

        list.innerHTML = data.failures.map((f) =>
          '<div class="ci-failure-item">' +
            '<span class="ci-failure-state">' + esc(f.state) + '</span>' +
            '<span>' + esc(f.name) + '</span>' +
            (f.details_url
              ? '<a href="' + esc(f.details_url) + '" target="_blank" rel="noreferrer noopener">View Log</a>'
              : '') +
          '</div>'
        ).join('');
      } catch {
        list.innerHTML = '<div class="run-err">Failed to load CI failures.</div>';
      }
    }

    document.getElementById('manual-add-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = document.getElementById('manual-add-input');
      const btn = document.getElementById('manual-add-btn');
      const value = input.value.trim();

      if (!value) {
        showToast('Enter a PR number, repo#number, or GitHub PR URL.', true);
        input.focus();
        return;
      }

      input.disabled = true;
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'Adding...';

      try {
        const res = await fetch('/api/manual-prs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        });
        const payload = await res.json();
        if (!res.ok || !payload.ok) {
          throw new Error(payload.error || 'Manual add failed.');
        }
        input.value = '';
        showToast(payload.message || 'Manual review queued.');
        refreshNow();
      } catch (err) {
        showToast(err.message || 'Manual add failed.', true);
      } finally {
        btn.textContent = original;
        btn.disabled = false;
        input.disabled = false;
      }
    });

    async function loadConfig() {
      try {
        const cfg = await fetch('/api/config').then((res) => res.json());
        const el = document.getElementById('config-info');
        let html = '';

        if (cfg.users.length) {
          html += '<span class="nav-tag" title="' + esc(cfg.users.join(', ')) + '">Users <b>' + cfg.users.length + '</b></span>';
        }

        if (cfg.repos.length) {
          html += '<span class="nav-tag" title="' + esc(cfg.repos.join(', ')) + '">Repos <b>' + cfg.repos.length + '</b></span>';
        }

        el.innerHTML = html;
      } catch {}
    }

    loadConfig();

    let refreshTimer;
    let isFirstLoad = true;

    async function refresh() {
      try {
        const [stats, prs, logs, status] = await Promise.all([
          fetch('/api/stats').then((res) => res.json()),
          fetch('/api/prs').then((res) => res.json()),
          fetch('/api/logs?limit=' + RECENT_SCAN_LIMIT).then((res) => res.json()),
          fetch('/api/status').then((res) => res.json()),
        ]);

        renderDashboardSummary(stats, prs, status);
        renderStats(stats);
        renderPRs(prs);
        renderScans(logs);
        renderStatus(status);
        setLiveStatus(true);
        setLastUpdated(new Date());
        isFirstLoad = false;
      } catch (error) {
        console.error('Refresh failed', error);
        setLiveStatus(false);
        document.getElementById('status-card-summary').textContent = 'Connection interrupted. Retrying automatically.';
      }

      scheduleRefresh();
    }

    function scheduleRefresh() {
      clearTimeout(refreshTimer);
      if (document.visibilityState === 'hidden') return;
      refreshTimer = setTimeout(refresh, 15000);
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        refresh();
      } else {
        clearTimeout(refreshTimer);
      }
    });

    function showToast(message, isError) {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.className = 'toast show' + (isError ? ' error' : '');
      setTimeout(() => { toast.className = 'toast'; }, 2200);
    }

    function refreshNow() {
      clearTimeout(refreshTimer);
      refresh();
    }

    refresh();
  </script>
</body>
</html>`;
