# Dashboard Split & UI Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `src/dashboard.ts` into separate server/HTML/CSS/JS files and simplify the dashboard UI (remove Automation card, flatten stats, drop State column).

**Architecture:** Extract the inline HTML template string from `dashboard.ts` into `public/index.html`, `public/style.css`, and `public/app.js`. Serve them via Hono's `serveStatic`. Apply UI changes to the extracted files.

**Tech Stack:** TypeScript, Hono, `@hono/node-server/serve-static`, vanilla HTML/CSS/JS.

**Spec:** `docs/superpowers/specs/2026-03-16-dashboard-split-and-ui-cleanup-design.md`

---

## Chunk 1: Code Splitting

### Task 1: Create `public/style.css`

**Files:**
- Create: `public/style.css`
- Reference: `src/dashboard.ts:342-1650`

- [ ] **Step 1: Extract CSS**

Copy lines 342–1650 of `src/dashboard.ts` (everything inside the `<style>` block) into `public/style.css`. Do NOT include the `<style>` / `</style>` tags themselves.

- [ ] **Step 2: Verify the file**

Run: `head -5 public/style.css && echo "..." && wc -l public/style.css`
Expected: First line is `:root {`, approximately 1308 lines total.

- [ ] **Step 3: Commit**

```bash
git add public/style.css
git commit -m "Extract dashboard CSS into public/style.css"
```

---

### Task 2: Create `public/app.js`

**Files:**
- Create: `public/app.js`
- Reference: `src/dashboard.ts:2025-2623`

- [ ] **Step 1: Extract JS**

Copy lines 2025–2623 of `src/dashboard.ts` (everything inside the `<script>` block, excluding the `<script>` / `</script>` tags). Place into `public/app.js`.

- [ ] **Step 2: Fix template interpolation**

The first line currently reads `const RECENT_SCAN_LIMIT = ${RECENT_SCAN_LIMIT};` (a template literal). Change it to:

```js
const RECENT_SCAN_LIMIT = 10;
```

- [ ] **Step 3: Verify the file**

Run: `head -3 public/app.js && echo "..." && wc -l public/app.js`
Expected: First line is `const RECENT_SCAN_LIMIT = 10;`, approximately 599 lines.

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "Extract dashboard JS into public/app.js"
```

---

### Task 3: Create `public/index.html`

**Files:**
- Create: `public/index.html`
- Reference: `src/dashboard.ts:336-341,1651-2023`

- [ ] **Step 1: Assemble HTML document**

Build `public/index.html` from the template string pieces:
- Lines 336–340: `<!DOCTYPE html>` through `<meta>` tags and `<title>`.
- Replace the inline `<style>...</style>` block with `<link rel="stylesheet" href="/style.css">`.
- Lines 1651–2022: `</head>` through the toast div.
- Replace the inline `<script>...</script>` block with `<script src="/app.js"></script>`.
- Close with `</body></html>`.

- [ ] **Step 2: Fix template interpolation in HTML**

Line 1819 has `${RECENT_SCAN_LIMIT}` inside a `<span class="section-count">`. Hardcode it:

```html
<span class="section-count">10</span>
```

- [ ] **Step 3: Verify the file**

Run: `head -8 public/index.html && echo "..." && grep 'style.css' public/index.html && grep 'app.js' public/index.html`
Expected: Standard HTML head with `<link rel="stylesheet" href="/style.css">` and `<script src="/app.js">`.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "Extract dashboard HTML into public/index.html"
```

---

### Task 4: Update `src/dashboard.ts` — remove template, add `serveStatic`

**Files:**
- Modify: `src/dashboard.ts`

- [ ] **Step 1: Add serveStatic import**

Add at the top of `src/dashboard.ts`:

```ts
import { serveStatic } from '@hono/node-server/serve-static';
```

- [ ] **Step 2: Remove the HTML template string**

Delete everything from line 335 (`const DASHBOARD_HTML = ...`) through line 2627 (end of the template string and the trailing backtick+semicolon). This removes approximately 2292 lines.

- [ ] **Step 3: Replace the SPA route with serveStatic**

Replace:
```ts
  // Dashboard SPA
  app.get('/', (c) => c.html(DASHBOARD_HTML));
```

With:
```ts
  // Serve static dashboard files (after API routes so /api/* takes priority)
  app.use('/*', serveStatic({ root: './public' }));
```

- [ ] **Step 4: Remove the `RECENT_SCAN_LIMIT` constant if it's only used by the template**

Check if `RECENT_SCAN_LIMIT` is used anywhere else in the TS file. If it's only used for the HTML template interpolation, delete line 8 (`const RECENT_SCAN_LIMIT = 10;`). If it's used by API handlers (e.g., the `/api/logs` default limit), keep it.

Run: `grep RECENT_SCAN_LIMIT src/dashboard.ts`

The constant IS used by the `/api/logs` handler (line 100), so keep it.

- [ ] **Step 5: Verify dashboard.ts is ~334 lines**

Run: `wc -l src/dashboard.ts`
Expected: Approximately 335 lines (helper functions + route handlers).

- [ ] **Step 6: Commit**

```bash
git add src/dashboard.ts
git commit -m "Remove inline HTML template, serve static files via serveStatic"
```

---

### Task 5: Update build script for production

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update build script**

Change the `build` script to copy `public/` into `dist/`:

```json
"build": "tsc && cp -r public dist/public"
```

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "Copy public/ into dist/ during build for production"
```

---

### Task 6: Smoke test the split

- [ ] **Step 1: Build and check for TS errors**

Run: `cd /mnt/data/joechenrh/raas && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 2: Start the server and check the dashboard**

Run: `cd /mnt/data/joechenrh/raas && timeout 5 npx tsx src/index.ts 2>&1 || true`
Expected: Server starts without errors, `Server listening on http://0.0.0.0:6688`.

- [ ] **Step 3: Test static file serving**

Run: `curl -s http://localhost:6688/ | head -5`
Expected: `<!DOCTYPE html>` and standard HTML output.

Run: `curl -s -o /dev/null -w '%{content_type}' http://localhost:6688/style.css`
Expected: `text/css`

Run: `curl -s -o /dev/null -w '%{content_type}' http://localhost:6688/app.js`
Expected: `application/javascript` or `text/javascript`

- [ ] **Step 4: Test API still works**

Run: `curl -s http://localhost:6688/api/health`
Expected: `{"status":"ok","timestamp":"..."}`

---

## Chunk 2: UI Changes

### Task 7: Remove Automation status card

**Files:**
- Modify: `public/index.html`
- Modify: `public/style.css`
- Modify: `public/app.js`

- [ ] **Step 1: Remove status card HTML**

In `public/index.html`, delete the `.status-card` div from the masthead section (the block starting `<div class="status-card">` through its closing `</div>`, containing `status-card-summary`, `last-updated-label`, and `next-scan-card-label`).

Remove the wrapping `<div>` (line 1674) and its closing `</div>` (line 1678) so `<p class="eyebrow">`, `<h1>`, and `<p class="masthead-summary">` are direct children of `<section class="masthead">`.

- [ ] **Step 2: Remove status card CSS**

In `public/style.css`, delete these rule blocks:
- `.status-card` (and `.status-card-label`, `.status-card-value`, `.status-card-meta`)
- `.status-chip` (and `.status-chip-label`, `.status-chip strong`)

Change `.masthead` rule: remove `display: grid; grid-template-columns: ...` — make it a plain block (`display: block`).

Remove `.masthead` responsive overrides in `@media (max-width: 1180px)` that reference `grid-template-columns`.

- [ ] **Step 3: Remove JS references to status card elements**

In `public/app.js`:

1. In `renderDashboardSummary()`: remove the entire `statusCardSummary` ternary variable definition AND the line `document.getElementById('status-card-summary').textContent = statusCardSummary;`.

2. In `renderStatus()`: remove the lines that update `next-scan-card-label`:
   ```js
   nextScanCardLabel.textContent = ...;
   ```
   And the `const nextScanCardLabel = document.getElementById('next-scan-card-label');` line.

3. Delete the entire `setLastUpdated` function.

4. Delete the `formatDateTime` function (only caller was `setLastUpdated`).

5. In `refresh()`: remove the `setLastUpdated(new Date());` call.

6. In the `catch` block of `refresh()`: remove `document.getElementById('status-card-summary').textContent = 'Lost connection...'`.

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/style.css public/app.js
git commit -m "Remove Automation status card from masthead"
```

---

### Task 8: Replace stats cards with bare numbers

**Files:**
- Modify: `public/index.html`
- Modify: `public/style.css`
- Modify: `public/app.js`

- [ ] **Step 1: Replace stats HTML**

In `public/index.html`, replace the entire `#stats-row` section (including skeleton placeholders) with:

```html
<section class="stats-bar" id="stats-row" role="region" aria-label="Review statistics">
</section>
```

The content will be rendered by JS on first data load.

- [ ] **Step 2: Replace stats CSS**

In `public/style.css`:

Delete these rule blocks:
- `.stats` (the grid container)
- `.stat-primary`, `.stat-primary-row`, `.stat-primary-value`, `.stat-primary-label`, `.stat-primary-detail`
- `.stat-secondary`, `.stat-secondary-label`, `.stat-secondary-value`
- `.tone-calm`, `.tone-active`, `.tone-danger`
- `.skeleton-stats`, `.skeleton-stat-primary`, `.skeleton-stat-secondary`
- All responsive overrides in `@media` blocks referencing `.stats`, `.stat-primary`, `.stat-secondary`, `.skeleton-stat-*`

Add these new rules:

```css
.stats-bar {
  display: flex;
  gap: 40px;
  padding-bottom: 20px;
  margin-bottom: 24px;
  border-bottom: 1px solid var(--border-soft);
}

.stat-item {}

.stat-value {
  font-size: 28px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.5px;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}

.stat-label {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
}
```

- [ ] **Step 3: Rewrite `renderStats` in JS**

In `public/app.js`:

Delete the `getHeadlineState` function entirely.

Replace the `renderStats` function with:

```js
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
```

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/style.css public/app.js
git commit -m "Replace stats cards with bare numbers layout"
```

---

### Task 9: Remove State column from PR table

**Files:**
- Modify: `public/index.html`
- Modify: `public/style.css`
- Modify: `public/app.js`

- [ ] **Step 1: Remove State column from HTML**

In `public/index.html`, in the active PR table:

1. Remove the `<col style="width:92px">` (5th colgroup entry — the State column).
2. Remove the `<th scope="col">State</th>` from `<thead>`.
3. Update the skeleton row colspan from `9` to `8`.

The merged PR table has no State column already — no changes needed there.

- [ ] **Step 2: Remove State column from JS rendering**

In `public/app.js`, in the `renderPRRow` function:

1. Change `const cols = showAction ? 9 : 7;` to `const cols = showAction ? 8 : 7;`.

2. Remove the conditional State `<td>`:
   ```js
   (showAction ? '<td><span class="pill pill-' + pr.state + '"><span class="pill-dot"></span>' + esc(pr.state) + '</span></td>' : '') +
   ```

3. In the `renderPRs` function, update the empty-state colspan from `9` to `8`:
   ```js
   '<tr><td colspan="8"><div class="empty">' +
   ```

- [ ] **Step 3: Remove unused State pill CSS**

In `public/style.css`, delete the rule block:

```css
.pill-open,
.pill-closed,
.pill-merged {
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.08);
}
```

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/style.css public/app.js
git commit -m "Remove State column from active PR table"
```

---

### Task 10: Final verification

- [ ] **Step 1: TypeScript check**

Run: `cd /mnt/data/joechenrh/raas && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 2: Visual check**

Start the server and open the dashboard in a browser. Verify:
- Masthead shows title + summary only (no Automation card)
- Stats are 4 bare numbers in a row (Review queue, Open PRs, Unresolved, Comments)
- PR table has no State column
- All interactive features work (expand runs, add PR, trigger review, triage CI, merged section toggle, scan logs toggle)

- [ ] **Step 3: API check**

Run:
```bash
curl -s http://localhost:6688/api/health
curl -s http://localhost:6688/api/stats
curl -s http://localhost:6688/api/prs | head -1
```
Expected: All return valid JSON, unchanged from before.

- [ ] **Step 4: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "Dashboard split & UI cleanup complete"
```
