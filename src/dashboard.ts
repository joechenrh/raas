import type { Hono } from 'hono';
import type Database from 'better-sqlite3';
import * as db from './db.js';

export function registerDashboard(app: Hono, database: Database.Database) {
  // JSON API
  app.get('/api/prs', (c) => c.json(db.getAllPRs(database)));
  app.get('/api/stats', (c) => c.json(db.getStats(database)));
  app.get('/api/logs', (c) => c.json(db.getRecentScanLogs(database)));
  app.get('/api/prs/:id/runs', (c) => {
    const id = Number(c.req.param('id'));
    return c.json(db.getReviewRuns(database, id));
  });
  app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

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
    .badge-ok { background: rgba(63,185,80,.15); color: var(--accent-green); }

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
          '<tr><td colspan="8"><div class="empty-state"><div class="icon">&#128269;</div>No pull requests yet</div></td></tr>';
        return;
      }
      let html = '';
      for (const pr of prs) {
        const resolved = pr.comment_count - pr.unresolved_count;
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
        '</tr>' +
        '<tr class="runs-row hidden" id="runs-' + pr.id + '"><td colspan="8"><div class="runs-container"><h4>Review Runs</h4><div class="runs-list">Loading...</div></div></td></tr>';
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

    function flash() {
      const t = document.getElementById('toast');
      t.textContent = 'Updated ' + new Date().toLocaleTimeString();
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 1500);
    }

    refresh();
  </script>
</body>
</html>`;
