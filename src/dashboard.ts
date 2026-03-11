import type { Hono } from 'hono';
import type Database from 'better-sqlite3';
import type { Config } from './config.js';
import type { GitHubClient } from './github.js';
import * as db from './db.js';
import { processReviewQueue } from './scanner.js';

function getManualTriggerState(database: Database.Database, pr: db.PR): { available: boolean; reason: string } {
  if (pr.repo !== 'pingcap/tidb') {
    return { available: false, reason: 'Only available for pingcap/tidb.' };
  }
  if (pr.state !== 'open') {
    return { available: false, reason: `PR is ${pr.state}.` };
  }
  if (db.hasPrimaryReviewRun(database, pr.id)) {
    return { available: false, reason: 'Primary review has already been triggered once.' };
  }
  if (pr.review_status === 'reviewing') {
    return { available: false, reason: 'Review is already running.' };
  }
  if (pr.review_status === 'pending') {
    return { available: false, reason: 'Review is already queued.' };
  }
  return { available: true, reason: 'Skip CI gate and trigger one review now.' };
}

function serializePR(database: Database.Database, pr: db.PR) {
  const manualTrigger = getManualTriggerState(database, pr);
  return {
    ...pr,
    manual_trigger_available: manualTrigger.available,
    manual_trigger_reason: manualTrigger.reason,
  };
}

export function registerDashboard(
  app: Hono,
  database: Database.Database,
  config: Config,
  github: GitHubClient,
) {
  // JSON API
  app.get('/api/prs', (c) => c.json(db.getAllPRs(database).map((pr) => serializePR(database, pr))));
  app.get('/api/stats', (c) => c.json(db.getStats(database)));
  app.get('/api/logs', (c) => c.json(db.getRecentScanLogs(database)));
  app.get('/api/prs/:id/runs', (c) => {
    const id = Number(c.req.param('id'));
    return c.json(db.getReviewRuns(database, id));
  });
  app.post('/api/prs/:id/manual-trigger', async (c) => {
    const id = Number(c.req.param('id'));
    const pr = db.getAllPRs(database).find((item) => item.id === id);
    if (!pr) {
      return c.json({ ok: false, error: 'PR not found.' }, 404);
    }

    const manualTrigger = getManualTriggerState(database, pr);
    if (!manualTrigger.available) {
      return c.json({
        ok: false,
        error: manualTrigger.reason,
        pr: serializePR(database, pr),
      }, 409);
    }

    db.updatePRStatus(database, pr.id, 'pending');
    const runId = db.createReviewRun(database, pr.id, 'initial', 'Manual override: skip TiDB CI gate from dashboard');

    void processReviewQueue(config, database, github).catch((err) => {
      console.error('[dashboard] manual trigger queue processing failed:', err);
    });

    const refreshed = db.getPR(database, pr.repo, pr.number);
    return c.json({
      ok: true,
      message: 'Manual review trigger queued.',
      run_id: runId,
      pr: refreshed ? serializePR(database, refreshed) : null,
    });
  });
  app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));
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
      --bg-primary: #0d1117;
      --bg-secondary: #161b22;
      --bg-tertiary: #1c2128;
      --border: #30363d;
      --border-light: #21262d;
      --text-primary: #f0f6fc;
      --text-secondary: #c9d1d9;
      --text-muted: #8b949e;
      --accent-blue: #58a6ff;
      --accent-green: #3fb950;
      --accent-yellow: #d29922;
      --accent-red: #f85149;
      --accent-purple: #8957e5;
      --radius: 12px;
      --radius-sm: 8px;
      --shadow: 0 1px 3px rgba(0,0,0,.3), 0 4px 12px rgba(0,0,0,.2);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans SC', sans-serif;
      background: var(--bg-primary);
      color: var(--text-secondary);
      min-height: 100vh;
    }

    /* Header */
    .header {
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      padding: 0 32px;
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 100;
      backdrop-filter: blur(12px);
    }
    .header-left { display: flex; align-items: center; gap: 12px; }
    .logo {
      width: 32px; height: 32px; border-radius: 8px;
      background: linear-gradient(135deg, var(--accent-blue), var(--accent-purple));
      display: flex; align-items: center; justify-content: center;
      font-weight: 800; font-size: 14px; color: #fff;
    }
    .header h1 { font-size: 18px; font-weight: 600; color: var(--text-primary); }
    .header h1 span { color: var(--text-muted); font-weight: 400; }
    .header-right { display: flex; align-items: center; gap: 16px; }
    .live-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--accent-green);
      animation: pulse 2s ease-in-out infinite;
      box-shadow: 0 0 6px var(--accent-green);
    }
    .live-label { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
    .config-info { display: flex; align-items: center; gap: 16px; }
    .config-tag {
      font-size: 11px; padding: 3px 10px; border-radius: 16px;
      background: var(--bg-tertiary); color: var(--text-muted);
      border: 1px solid var(--border); font-family: monospace;
      position: relative; cursor: default;
    }
    .config-tag .config-label { color: var(--text-muted); margin-right: 4px; }
    .config-tag .config-value { color: var(--accent-blue); }
    .config-tag .config-popover {
      display: none; position: absolute; top: calc(100% + 8px); right: 0;
      background: var(--bg-secondary); border: 1px solid var(--border);
      border-radius: 8px; padding: 12px; min-width: 180px; max-width: 320px;
      max-height: 300px; overflow-y: auto; z-index: 100;
      box-shadow: 0 4px 16px rgba(0,0,0,.4); font-size: 12px;
    }
    .config-tag:hover .config-popover { display: block; }
    .config-popover-list { display: flex; flex-wrap: wrap; gap: 4px; }
    .config-popover-item {
      padding: 2px 8px; border-radius: 4px; background: var(--bg-tertiary);
      color: var(--accent-blue); white-space: nowrap;
    }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.3; } }

    /* Layout */
    .container { max-width: 1280px; margin: 0 auto; padding: 24px 32px; }

    /* Stats */
    .stats-row {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 16px;
      margin-bottom: 28px;
    }
    .stat-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
      transition: border-color .2s, transform .15s;
      cursor: default;
    }
    .stat-card:hover { border-color: var(--text-muted); transform: translateY(-1px); }
    .stat-label { font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .5px; margin-bottom: 8px; }
    .stat-value { font-size: 36px; font-weight: 700; color: var(--text-primary); line-height: 1; }
    .stat-value.blue { color: var(--accent-blue); }
    .stat-value.green { color: var(--accent-green); }
    .stat-value.yellow { color: var(--accent-yellow); }
    .stat-value.red { color: var(--accent-red); }

    /* Section */
    .section { margin-bottom: 28px; }
    .section-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 12px;
    }
    .section-title {
      font-size: 15px; font-weight: 600; color: var(--text-primary);
      display: flex; align-items: center; gap: 8px;
    }
    .section-title .icon { font-size: 16px; opacity: .7; }
    .section-badge {
      font-size: 11px; background: var(--bg-tertiary); color: var(--text-muted);
      padding: 2px 8px; border-radius: 10px; font-weight: 500;
    }

    /* Table */
    .table-wrap {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      box-shadow: var(--shadow);
    }
    table { width: 100%; border-collapse: collapse; }
    thead th {
      text-align: left; padding: 12px 16px;
      font-size: 11px; font-weight: 600; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: .5px;
      background: var(--bg-primary); border-bottom: 1px solid var(--border);
    }
    tbody td {
      padding: 14px 16px; font-size: 13px;
      border-bottom: 1px solid var(--border-light);
      vertical-align: middle;
    }
    tbody tr { transition: background .15s; }
    tbody tr:hover { background: var(--bg-tertiary); }
    tbody tr:last-child td { border-bottom: none; }

    /* PR Row */
    .pr-number {
      color: var(--accent-blue); text-decoration: none;
      font-weight: 600; font-size: 14px;
    }
    .pr-number:hover { text-decoration: underline; }
    .pr-title {
      color: var(--text-primary); font-weight: 500;
      max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .pr-title:hover { white-space: normal; word-break: break-word; }
    .pr-repo { color: var(--text-muted); font-size: 12px; font-family: monospace; }
    .pr-author {
      display: inline-flex; align-items: center; gap: 6px;
    }
    .avatar {
      width: 20px; height: 20px; border-radius: 50%;
      background: var(--bg-tertiary); border: 1px solid var(--border);
    }

    /* Badge */
    .badge {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 3px 10px; border-radius: 16px;
      font-size: 11px; font-weight: 600; letter-spacing: .3px;
    }
    .badge-dot { width: 6px; height: 6px; border-radius: 50%; }
    .badge-open { background: rgba(63,185,80,.15); color: var(--accent-green); }
    .badge-open .badge-dot { background: var(--accent-green); }
    .badge-closed { background: rgba(248,81,73,.15); color: var(--accent-red); }
    .badge-closed .badge-dot { background: var(--accent-red); }
    .badge-merged { background: rgba(137,87,229,.15); color: var(--accent-purple); }
    .badge-merged .badge-dot { background: var(--accent-purple); }
    .badge-pending { background: rgba(210,153,34,.15); color: var(--accent-yellow); }
    .badge-pending .badge-dot { background: var(--accent-yellow); }
    .badge-reviewing { background: rgba(31,111,235,.2); color: var(--accent-blue); }
    .badge-reviewing .badge-dot { background: var(--accent-blue); animation: pulse 1.5s infinite; }
    .badge-reviewed { background: rgba(63,185,80,.15); color: var(--accent-green); }
    .badge-reviewed .badge-dot { background: var(--accent-green); }
    .badge-failed { background: rgba(248,81,73,.15); color: var(--accent-red); }
    .badge-failed .badge-dot { background: var(--accent-red); }
    .badge-waiting-ci { background: rgba(210,153,34,.15); color: var(--accent-yellow); }
    .badge-waiting-ci .badge-dot { background: var(--accent-yellow); }
    .badge-ok { background: rgba(63,185,80,.15); color: var(--accent-green); }

    /* Actions */
    .actions-cell { display: flex; justify-content: flex-end; }
    .action-btn {
      border: 1px solid var(--border);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border-radius: 999px;
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
      transition: border-color .15s, background .15s, transform .15s;
      white-space: nowrap;
    }
    .action-btn:hover {
      border-color: var(--accent-blue);
      background: rgba(88,166,255,.12);
      transform: translateY(-1px);
    }
    .action-btn:disabled {
      cursor: not-allowed;
      opacity: .45;
      transform: none;
      border-color: var(--border);
      background: var(--bg-tertiary);
      color: var(--text-muted);
    }

    /* Comments */
    .comments-cell { display: flex; gap: 12px; font-size: 12px; }
    .comments-cell .c-resolved { color: var(--accent-green); }
    .comments-cell .c-unresolved { color: var(--accent-red); font-weight: 600; }

    /* Time */
    .time-ago { color: var(--text-muted); font-size: 12px; }

    /* Expand row */
    .expand-btn {
      background: none; border: none; color: var(--text-muted);
      cursor: pointer; font-size: 14px; padding: 4px 8px; border-radius: 4px;
      transition: background .15s, color .15s;
    }
    .expand-btn:hover { background: var(--bg-tertiary); color: var(--text-primary); }
    .runs-row td { padding: 0 !important; background: var(--bg-primary); }
    .runs-row.hidden { display: none; }
    .runs-row:hover { background: var(--bg-primary) !important; }
    .runs-container { padding: 12px 16px 12px 48px; }
    .runs-container h4 { font-size: 12px; color: var(--text-muted); margin-bottom: 8px; text-transform: uppercase; letter-spacing: .5px; }
    .run-item {
      display: flex; align-items: center; gap: 12px;
      padding: 8px 12px; border-radius: var(--radius-sm);
      background: var(--bg-secondary); border: 1px solid var(--border-light);
      margin-bottom: 6px; font-size: 12px;
    }
    .run-item:last-child { margin-bottom: 0; }
    .run-type { font-weight: 600; color: var(--text-primary); min-width: 64px; }
    .run-duration { color: var(--text-muted); }
    .run-error { color: var(--accent-red); font-size: 11px; margin-top: 2px; word-break: break-all; }

    /* Scan log */
    .scan-status { display: flex; align-items: center; gap: 6px; }

    /* Empty state */
    .empty-state {
      text-align: center; padding: 64px 32px; color: var(--text-muted);
      font-size: 14px;
    }
    .empty-state .icon { font-size: 48px; margin-bottom: 12px; opacity: .4; }

    /* Toast */
    .toast {
      position: fixed; bottom: 24px; right: 24px;
      background: var(--bg-secondary); border: 1px solid var(--border);
      border-radius: var(--radius-sm); padding: 10px 16px;
      font-size: 12px; color: var(--text-muted);
      box-shadow: var(--shadow); opacity: 0;
      transition: opacity .3s;
      z-index: 200;
    }
    .toast.show { opacity: 1; }

    /* Responsive */
    @media (max-width: 900px) {
      .stats-row { grid-template-columns: repeat(3, 1fr); }
      .header { padding: 0 16px; }
      .container { padding: 16px; }
      .pr-title { max-width: 200px; }
    }
    @media (max-width: 600px) {
      .stats-row { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <div class="logo">R</div>
      <h1>RaaS <span>Review as a Service</span></h1>
    </div>
    <div class="header-right">
      <div class="config-info" id="config-info"></div>
      <div class="live-label"><span class="live-dot"></span> Live</div>
    </div>
  </div>

  <div class="container">
    <!-- Stats -->
    <div class="stats-row" id="stats-row"></div>

    <!-- PRs -->
    <div class="section">
      <div class="section-header">
        <div class="section-title">
          <span class="icon">&#9776;</span> Pull Requests
          <span class="section-badge" id="pr-count">0</span>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:32px"></th>
              <th>PR</th>
              <th>Title</th>
              <th>Author</th>
              <th>State</th>
              <th>Review</th>
              <th>Comments</th>
              <th>Last Review</th>
              <th style="width:160px;text-align:right">Action</th>
            </tr>
          </thead>
          <tbody id="pr-body"></tbody>
        </table>
      </div>
    </div>

    <!-- Scans -->
    <div class="section">
      <div class="section-header">
        <div class="section-title">
          <span class="icon">&#8635;</span> Recent Scans
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>PRs Found</th>
              <th>Reviews Triggered</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="scan-body"></tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="toast" id="toast">Updated</div>

  <script>
    const esc = s => s.replace(/&/g,'&amp;').replace(/[<]/g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    function timeAgo(iso) {
      if (!iso) return 'Never';
      const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
      if (isNaN(d)) return iso;
      const s = Math.floor((Date.now() - d) / 1000);
      if (s < 0) return 'just now';
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.floor(s/60) + 'm ago';
      if (s < 86400) return Math.floor(s/3600) + 'h ago';
      return Math.floor(s/86400) + 'd ago';
    }

    function duration(ms) {
      if (!ms && ms !== 0) return '-';
      if (ms < 1000) return ms + 'ms';
      if (ms < 60000) return (ms/1000).toFixed(1) + 's';
      return (ms/60000).toFixed(1) + 'min';
    }

    function renderStats(stats) {
      const items = [
        { label: 'Total PRs', value: stats.total_prs, color: 'blue' },
        { label: 'Open PRs', value: stats.open_prs, color: '' },
        { label: 'Pending Reviews', value: stats.pending_reviews + stats.reviewing, color: 'yellow' },
        { label: 'Comments', value: stats.total_comments, color: 'green' },
        { label: 'Unresolved', value: stats.total_unresolved, color: stats.total_unresolved > 0 ? 'red' : '' },
      ];
      document.getElementById('stats-row').innerHTML = items.map(i =>
        '<div class="stat-card"><div class="stat-label">' + i.label +
        '</div><div class="stat-value ' + i.color + '">' + i.value + '</div></div>'
      ).join('');
    }

    function renderPRs(prs) {
      document.getElementById('pr-count').textContent = prs.length;
      if (!prs.length) {
        document.getElementById('pr-body').innerHTML =
          '<tr><td colspan="9"><div class="empty-state"><div class="icon">&#128269;</div>No pull requests yet</div></td></tr>';
        return;
      }
      let html = '';
      for (const pr of prs) {
        const resolved = pr.comment_count - pr.unresolved_count;
        const manualTitle = esc(pr.manual_trigger_reason || '');
        const manualDisabled = pr.manual_trigger_available ? '' : ' disabled';
        const manualButton = pr.repo === 'pingcap/tidb'
          ? '<button class="action-btn manual-trigger-btn" data-id="' + pr.id + '" title="' + manualTitle + '"' + manualDisabled + '>Trigger Review</button>'
          : '<span class="time-ago">-</span>';
        html += '<tr>' +
          '<td><button class="expand-btn" data-id="' + pr.id + '" title="Show review runs">&#9654;</button></td>' +
          '<td><span class="pr-repo">' + esc(pr.repo) + '</span><br>' +
            '<a class="pr-number" href="https://github.com/' + esc(pr.repo) + '/pull/' + pr.number + '" target="_blank">#' + pr.number + '</a></td>' +
          '<td><div class="pr-title" title="' + esc(pr.title) + '">' + esc(pr.title) + '</div></td>' +
          '<td><span class="pr-author"><img class="avatar" src="https://github.com/' + esc(pr.author) + '.png?size=40" alt="">' + esc(pr.author) + '</span></td>' +
          '<td><span class="badge badge-' + pr.state + '"><span class="badge-dot"></span>' + pr.state + '</span></td>' +
          '<td><span class="badge badge-' + pr.review_status + '"><span class="badge-dot"></span>' + pr.review_status + '</span></td>' +
          '<td><div class="comments-cell">' +
            '<span class="c-resolved">' + resolved + ' resolved</span>' +
            '<span class="c-unresolved">' + pr.unresolved_count + ' open</span>' +
          '</div></td>' +
          '<td><span class="time-ago">' + timeAgo(pr.last_reviewed_at) + '</span></td>' +
          '<td><div class="actions-cell">' + manualButton + '</div></td>' +
        '</tr>' +
        '<tr class="runs-row hidden" id="runs-' + pr.id + '"><td colspan="9"><div class="runs-container"><h4>Review Runs</h4><div class="runs-list">Loading...</div></div></td></tr>';
      }
      document.getElementById('pr-body').innerHTML = html;
    }

    function renderScans(logs) {
      if (!logs.length) {
        document.getElementById('scan-body').innerHTML =
          '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:24px">No scans yet</td></tr>';
        return;
      }
      document.getElementById('scan-body').innerHTML = logs.map(l =>
        '<tr>' +
          '<td><span class="time-ago">' + timeAgo(l.started_at) + '</span></td>' +
          '<td>' + l.prs_found + '</td>' +
          '<td>' + l.reviews_triggered + '</td>' +
          '<td>' + (l.errors
            ? '<span class="badge badge-failed"><span class="badge-dot"></span>Error</span>'
            : '<span class="badge badge-ok"><span class="badge-dot"></span>OK</span>') +
          '</td>' +
        '</tr>'
      ).join('');
    }

    async function loadRuns(prId) {
      const row = document.getElementById('runs-' + prId);
      const list = row.querySelector('.runs-list');
      try {
        const runs = await fetch('/api/prs/' + prId + '/runs').then(r => r.json());
        if (!runs.length) { list.innerHTML = '<div style="color:var(--text-muted);font-size:12px">No runs yet</div>'; return; }
        list.innerHTML = runs.map(r =>
          '<div class="run-item">' +
            '<span class="badge badge-' + r.status + '"><span class="badge-dot"></span>' + r.status + '</span>' +
            '<span class="run-type">' + r.type + '</span>' +
            '<span class="run-duration">' + duration(r.duration_ms) + '</span>' +
            '<span class="time-ago">' + timeAgo(r.started_at) + '</span>' +
            (r.error ? '<span class="run-error">' + esc(r.error) + '</span>' : '') +
          '</div>'
        ).join('');
      } catch { list.innerHTML = '<div style="color:var(--accent-red)">Failed to load</div>'; }
    }

    document.addEventListener('click', e => {
      const btn = e.target.closest('.expand-btn');
      if (!btn) return;
      const id = btn.dataset.id;
      const row = document.getElementById('runs-' + id);
      const hidden = row.classList.toggle('hidden');
      btn.innerHTML = hidden ? '&#9654;' : '&#9660;';
      if (!hidden) loadRuns(id);
    });

    document.addEventListener('click', async e => {
      const btn = e.target.closest('.manual-trigger-btn');
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

    async function loadConfig() {
      try {
        const cfg = await fetch('/api/config').then(r => r.json());
        const el = document.getElementById('config-info');
        let html = '';
        if (cfg.users.length) {
          const count = cfg.users.length;
          const popover = '<div class="config-popover"><div class="config-popover-list">' + cfg.users.map(u => '<span class="config-popover-item">' + esc(u) + '</span>').join('') + '</div></div>';
          html += '<span class="config-tag"><span class="config-label">Users:</span><span class="config-value">' + count + '</span>' + popover + '</span>';
        }
        if (cfg.repos.length) {
          html += '<span class="config-tag"><span class="config-label">Repos:</span><span class="config-value">' + cfg.repos.map(esc).join(', ') + '</span></span>';
        }
        el.innerHTML = html;
      } catch {}
    }
    loadConfig();

    let refreshTimer;
    async function refresh() {
      try {
        const [stats, prs, logs] = await Promise.all([
          fetch('/api/stats').then(r => r.json()),
          fetch('/api/prs').then(r => r.json()),
          fetch('/api/logs').then(r => r.json()),
        ]);
        renderStats(stats);
        renderPRs(prs);
        renderScans(logs);
        flash();
      } catch (e) { console.error('Refresh failed', e); }
      refreshTimer = setTimeout(refresh, 15000);
    }

    function showToast(message, isError) {
      const t = document.getElementById('toast');
      t.textContent = message;
      t.style.borderColor = isError ? 'var(--accent-red)' : 'var(--border)';
      t.style.color = isError ? 'var(--accent-red)' : 'var(--text-muted)';
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 1500);
    }

    function flash() {
      showToast('Updated ' + new Date().toLocaleTimeString(), false);
    }

    function refreshNow() {
      clearTimeout(refreshTimer);
      refresh();
    }

    refresh();
  </script>
</body>
</html>`;
