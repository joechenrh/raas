const RECENT_SCAN_LIMIT = 10;
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

function formatCount(value, noun) {
  return value + ' ' + noun + (value === 1 ? '' : 's');
}

function renderStats(stats) {
  const queue = stats.pending_reviews + stats.reviewing;
  const items = [
    { label: 'Review queue', value: queue },
    { label: 'Open PRs', value: stats.open_prs },
    { label: 'Unresolved', value: stats.total_unresolved, danger: stats.total_unresolved > 0 },
    { label: 'Comments', value: stats.total_comments },
  ];

  document.getElementById('stats-row').innerHTML = items.map((item) =>
    '<div class="stat-item">' +
      '<div class="stat-value"' + (item.danger ? ' style="color:var(--danger)"' : '') + '>' + item.value + '</div>' +
      '<div class="stat-label">' + item.label + '</div>' +
    '</div>'
  ).join('');
}

function renderDashboardSummary(stats, prs, status) {
  const queue = stats.pending_reviews + stats.reviewing;
  const needsAttention = prs.filter((pr) => pr.unresolved_count > 0).length;
  const nextScan = status?.next_scan_at ? 'next scan ' + formatClockTime(status.next_scan_at) : 'no scan scheduled';
  let summary = 'Nothing on the radar yet. The scanner is listening for new pull requests.';

  if (prs.length) {
    if (needsAttention > 0) {
      summary = formatCount(prs.length, 'pull request') + ' in view. ' +
        formatCount(needsAttention, 'conversation') + ' waiting to be resolved.';
    } else if (queue > 0) {
      summary = formatCount(prs.length, 'pull request') + ' in view, ' +
        formatCount(queue, 'review') + ' actively running. ' + nextScan + '.';
    } else {
      summary = formatCount(prs.length, 'pull request') + ' in view. Queue is clear \u2014 nothing needs action right now.';
    }
  }

  document.getElementById('dashboard-summary').textContent = summary;
}

function manualActionLabel(reason) {
  const text = String(reason || '').toLowerCase();
  if (!text) return 'Not available';
  if (text.includes('already running')) return 'Review in progress';
  if (text.includes('already queued')) return 'Already in line';
  if (text.includes('already approved')) return 'All clear';
  if (text.includes('no .go file changes')) return 'No Go to review';
  if (text.includes('only resolved')) return 'Open threads remain';
  if (text.includes('resolved pr')) return 'Waiting on CI';
  if (text.includes('initial review')) return 'Starts after CI';
  if (text.includes('only available')) return 'TiDB repos only';
  if (text.includes('pr is')) return 'Not available';
  return 'Not available';
}

function renderPRs(prs) {
  const activePRs = prs.filter((pr) => pr.state !== 'merged');
  const mergedPRs = prs.filter((pr) => pr.state === 'merged');

  const count = document.getElementById('pr-count');
  const summary = document.getElementById('pr-summary');
  count.textContent = activePRs.length;

  const unresolvedPRs = activePRs.filter((pr) => pr.unresolved_count > 0).length;
  const activeReviews = activePRs.filter((pr) => pr.review_status === 'pending' || pr.review_status === 'reviewing').length;
  summary.textContent = activePRs.length
    ? unresolvedPRs > 0
      ? formatCount(unresolvedPRs, 'unresolved thread') + ' still open.'
      : activeReviews > 0
        ? formatCount(activeReviews, 'review') + ' in progress. Moving smoothly.'
        : 'All conversations resolved. Queue is at ease.'
    : 'No active pull requests yet.';

  if (!activePRs.length) {
    document.getElementById('pr-body').innerHTML =
      '<tr><td colspan="8"><div class="empty">' +
      '<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M11.5 7a4.499 4.499 0 11-8.998 0A4.499 4.499 0 0111.5 7zm-.82 4.74a6 6 0 111.06-1.06l3.04 3.04a.75.75 0 11-1.06 1.06l-3.04-3.04z"/></svg>' +
      '<div>Nothing in the queue yet. Add a PR above to get started.</div></div></td></tr>';
  } else {
    let html = '';
    for (const pr of activePRs) {
      html += renderPRRow(pr, true);
    }
    document.getElementById('pr-body').innerHTML = html;

    for (const pr of activePRs) {
      if (pr.review_status === 'ci-failed') {
        loadCIFailures(pr.id);
      }
    }
  }

  renderMergedPRs(mergedPRs);
}

function renderPRRow(pr, showAction) {
  const resolved = pr.comment_count - pr.unresolved_count;
  const cols = showAction ? 8 : 7;
  let manualAction = '';

  if (showAction) {
    const manualTitle = esc(pr.manual_trigger_reason || '');
    if (pr.repo === 'pingcap/tidb') {
      if (pr.review_status === 'approved') {
        manualAction = '<button class="btn btn-danger ci-triage-btn" data-id="' + pr.id + '">Triage CI</button>';
      } else if (pr.manual_trigger_available) {
        manualAction = '<button class="btn btn-primary manual-trigger-btn" data-id="' + pr.id + '">Trigger Review</button>';
      } else {
        manualAction = '<span class="action-note" title="' + manualTitle + '">' + esc(manualActionLabel(pr.manual_trigger_reason)) + '</span>';
      }
    } else {
      manualAction = '<span class="action-note">TiDB only</span>';
    }
  }

  return '<tr>' +
      '<td><button class="expand-btn" data-id="' + pr.id + '" title="Show review runs" aria-label="Show review runs for PR #' + pr.number + '" aria-expanded="false">' +
        '<svg viewBox="0 0 16 16" class="chevron"><path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z"/></svg>' +
      '</button></td>' +
      '<td><span class="pr-repo">' + esc(pr.repo) + '</span><br>' +
        '<a class="pr-link" href="https://github.com/' + esc(pr.repo) + '/pull/' + pr.number + '" target="_blank" rel="noreferrer noopener">#' + pr.number + '</a></td>' +
      '<td><div class="pr-title" title="' + esc(pr.title) + '">' + esc(pr.title) + '</div></td>' +
      '<td><span class="pr-author"><img class="avatar" src="https://github.com/' + esc(pr.author) + '.png?size=40" alt=""><span>' + esc(pr.author) + '</span></span></td>' +
      '<td>' + (pr.review_status === 'ci-failed'
        ? '<span class="pill pill-ci-failed ci-failures-tip"><span class="pill-dot"></span>ci-failed<div class="ci-failures-tooltip"><div class="ci-failures-tooltip-title">Failing CI Checks</div><div class="ci-failures-list" id="ci-tip-' + pr.id + '">' + (ciFailuresHtmlCache[pr.id] || 'Loading...') + '</div></div></span>'
        : '<span class="pill pill-' + pr.review_status + '"><span class="pill-dot"></span>' + esc(pr.review_status) + '</span>') + '</td>' +
      '<td><div class="comment-group">' +
        '<span class="comment-resolved">' + resolved + ' resolved</span>' +
        '<span class="comment-open">' + pr.unresolved_count + ' open</span>' +
      '</div></td>' +
      '<td><span class="time">' + timeAgo(pr.last_reviewed_at) + '</span></td>' +
      (showAction ? '<td class="action-col"><div class="actions-cell">' + manualAction + '</div></td>' : '') +
    '</tr>' +
    '<tr class="runs-row hidden" id="runs-' + pr.id + '"><td colspan="' + cols + '"><div class="runs-wrap"><div class="runs-label">Review Runs</div><div class="runs-list">Loading...</div></div></td></tr>';
}

const ciFailuresHtmlCache = {};

const MERGED_PAGE_SIZE = 10;
let mergedPage = 0;
let mergedPRsCache = [];

function renderMergedPRs(mergedPRs) {
  mergedPRsCache = mergedPRs;
  document.getElementById('merged-section-wrap').hidden = true;
  document.getElementById('merged-count').textContent = mergedPRs.length;
  document.getElementById('merged-summary').textContent = mergedPRs.length
    ? formatCount(mergedPRs.length, 'pull request') + ' shipped and done.'
    : 'Nothing merged yet. It\u2019ll show up here when it does.';

  if (mergedPage * MERGED_PAGE_SIZE >= mergedPRs.length && mergedPage > 0) {
    mergedPage = Math.max(0, Math.ceil(mergedPRs.length / MERGED_PAGE_SIZE) - 1);
  }

  renderMergedPage();
}

function renderMergedPage() {
  const prs = mergedPRsCache;
  const totalPages = Math.max(1, Math.ceil(prs.length / MERGED_PAGE_SIZE));
  const start = mergedPage * MERGED_PAGE_SIZE;
  const pageItems = prs.slice(start, start + MERGED_PAGE_SIZE);

  if (!prs.length) {
    document.getElementById('merged-body').innerHTML =
      '<tr><td colspan="7"><div class="empty" style="padding:40px 32px">No merged PRs yet. They\u2019ll land here after shipping.</div></td></tr>';
    document.getElementById('merged-pagination').innerHTML = '';
    return;
  }

  let html = '';
  for (const pr of pageItems) {
    html += renderPRRow(pr, false);
  }
  document.getElementById('merged-body').innerHTML = html;

  let paginationHtml = '';
  if (totalPages > 1) {
    paginationHtml += '<button class="pagination-btn" data-merged-page="prev"' + (mergedPage === 0 ? ' disabled' : '') + ' aria-label="Previous page">&lsaquo;</button>';
    for (let i = 0; i < totalPages; i++) {
      paginationHtml += '<button class="pagination-btn' + (i === mergedPage ? ' is-active' : '') + '" data-merged-page="' + i + '" aria-label="Page ' + (i + 1) + '"' + (i === mergedPage ? ' aria-current="page"' : '') + '>' + (i + 1) + '</button>';
    }
    paginationHtml += '<button class="pagination-btn" data-merged-page="next"' + (mergedPage >= totalPages - 1 ? ' disabled' : '') + ' aria-label="Next page">&rsaquo;</button>';
    paginationHtml += '<span class="pagination-info">' + (start + 1) + '–' + Math.min(start + MERGED_PAGE_SIZE, prs.length) + ' of ' + prs.length + '</span>';
  }
  document.getElementById('merged-pagination').innerHTML = paginationHtml;
}

document.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-merged-page]');
  if (!btn || btn.disabled) return;
  const val = btn.dataset.mergedPage;
  const totalPages = Math.max(1, Math.ceil(mergedPRsCache.length / MERGED_PAGE_SIZE));
  if (val === 'prev') mergedPage = Math.max(0, mergedPage - 1);
  else if (val === 'next') mergedPage = Math.min(totalPages - 1, mergedPage + 1);
  else mergedPage = parseInt(val, 10);
  renderMergedPage();
});

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
  const nextScanText = status?.next_scan_at ? 'Next scan ' + formatClockTime(status.next_scan_at) : 'No schedule';

  nextScanLabel.textContent = nextScanText;
  nextScanLabel.title = status?.next_scan_at || '';
}

function setLiveStatus(isHealthy) {
  const status = document.getElementById('live-status');
  const label = document.getElementById('live-status-label');
  status.classList.toggle('is-error', !isHealthy);
  label.textContent = isHealthy ? 'Watching' : 'Connection lost';
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
  btn.textContent = 'On it\u2026';

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
  btn.textContent = 'On it\u2026';

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
  const list = document.getElementById('ci-tip-' + prId);
  if (!list) return;

  try {
    const data = await fetch('/api/prs/' + prId + '/ci-failures').then((res) => res.json());
    if (!data.ok || !data.failures.length) {
      const html = '<div class="time">No failing checks found.</div>';
      ciFailuresHtmlCache[prId] = html;
      list.innerHTML = html;
      return;
    }

    const html = data.failures.map((f) =>
      '<div class="ci-failure-item">' +
        '<span class="ci-failure-state">' + esc(f.state) + '</span>' +
        '<span>' + esc(f.name) + '</span>' +
        (f.details_url
          ? '<a href="' + esc(f.details_url) + '" target="_blank" rel="noreferrer noopener">View Log</a>'
          : '') +
      '</div>'
    ).join('');
    ciFailuresHtmlCache[prId] = html;
    list.innerHTML = html;
  } catch {
    list.innerHTML = '<div class="run-err">Failed to load CI failures.</div>';
  }
}

// Position ci-failures tooltip on hover via event delegation
document.addEventListener('mouseenter', (e) => {
  const tip = e.target.closest('.ci-failures-tip');
  if (!tip) return;
  const tooltip = tip.querySelector('.ci-failures-tooltip');
  if (!tooltip) return;
  const rect = tip.getBoundingClientRect();
  tooltip.style.left = rect.left + rect.width / 2 + 'px';
  tooltip.style.transform = 'translateX(-50%)';
  tooltip.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
  tooltip.classList.add('is-visible');
}, true);

document.addEventListener('mouseleave', (e) => {
  const tip = e.target.closest('.ci-failures-tip');
  if (!tip) return;
  const tooltip = tip.querySelector('.ci-failures-tooltip');
  if (tooltip) tooltip.classList.remove('is-visible');
}, true);

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
  btn.textContent = 'Adding\u2026';

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
    isFirstLoad = false;
  } catch (error) {
    console.error('Refresh failed', error);
    setLiveStatus(false);
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
