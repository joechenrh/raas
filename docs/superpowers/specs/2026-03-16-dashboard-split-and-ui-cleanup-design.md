# Dashboard Split & UI Cleanup

**Date:** 2026-03-16
**Status:** Draft

## Problem

`src/dashboard.ts` is 2626 lines containing server-side route handlers, inline HTML, CSS, and client-side JavaScript in a single template string. This makes the file difficult to navigate and edit. Additionally, the dashboard UI has visual clutter: a redundant Automation status card, oversized stats cards, and an unnecessary State column in the PR table.

## Goals

1. Split `dashboard.ts` by responsibility so each file has a single concern.
2. Simplify the top-of-page stats area and remove redundant UI elements.
3. Remove the PR State column (open/closed/merged) — it adds little value since active and merged PRs are already in separate sections.

## Non-Goals

- Full UI redesign or framework migration (React, Vue, etc.).
- Changing API endpoints or backend logic.
- Adding new features.

---

## Part 1: Code Splitting

### Current Structure

```
src/dashboard.ts (2626 lines)
  ├─ Lines 1-88:      Helper functions (parseRepo, parseManualPRReference, etc.)
  ├─ Lines 89-334:    Hono API route handlers
  ├─ Lines 336-1650:  Inline CSS (~1300 lines)
  ├─ Lines 1651-2020: HTML body
  └─ Lines 2024-2626: Client-side JavaScript
```

### Target Structure

```
src/
  dashboard.ts            # Route registration + API handlers (~300 lines)
public/
  index.html              # HTML document structure
  style.css               # All CSS (extracted from <style> block)
  app.js                  # Client-side JS (rendering, events, polling)
```

### Details

**`src/dashboard.ts`** retains:
- All imports, helper functions, and `serializePR` logic.
- All `app.get` / `app.post` API route handlers.
- `registerDashboard` export function.
- The `app.get('/')` route is removed in favor of static file serving.

**Static file serving:**
- Use `serveStatic` from `@hono/node-server/serve-static` to serve the `public/` directory.
- Register in `src/dashboard.ts` at the end of `registerDashboard`, after all API routes: `app.use('/*', serveStatic({ root: './public' }))`. This ensures `/api/*` routes take priority. The default `index: 'index.html'` option means `GET /` serves `public/index.html` automatically.
- **Production build note:** `tsc` does not copy `public/` into `dist/`. The `serveStatic` root resolves relative to CWD, so the process must be started from the repo root. Add `"build": "tsc && cp -r public dist/public"` to `package.json` scripts if a self-contained `dist/` is needed.

**Template interpolation:**
- The current HTML uses `${RECENT_SCAN_LIMIT}` in two places: the `<script>` block (line 2025) and the HTML body (line 1819, inside a `<span class="section-count">`).
- Hardcode `const RECENT_SCAN_LIMIT = 10;` in `app.js`. For the HTML occurrence, hardcode the value directly in `index.html` or populate it from JS on load.

**`public/index.html`:**
- Standard HTML document.
- `<link rel="stylesheet" href="/style.css">` in `<head>`.
- `<script src="/app.js"></script>` before `</body>`.
- Contains only the HTML body structure (navbar, page, sections, tables, toast).

**`public/style.css`:**
- Extracted verbatim from the current `<style>` block (lines 342–1650).
- UI changes (Part 2) applied after extraction.

**`public/app.js`:**
- Extracted verbatim from the current `<script>` block (lines 2024–2624).
- `const RECENT_SCAN_LIMIT = 10;` hardcoded at top.
- UI changes (Part 2) applied after extraction.

---

## Part 2: UI Changes

### 2a. Remove Automation Status Card

**What:** Delete the `.status-card` element from the masthead (right side). This card shows "Automation" status, "Last updated", and "Next scan" — all redundant with the navbar status indicators.

**HTML change:** Remove the `.status-card` div from the masthead section. The masthead becomes a simple block with eyebrow, title, and summary text.

**CSS change:** Remove `.status-card`, `.status-card-label`, `.status-card-value`, `.status-card-meta`, `.status-chip`, `.status-chip-label` rules. Remove the `grid-template-columns` from `.masthead` (no longer a two-column grid).

**JS change:** Multiple functions reference the removed elements:
- `renderDashboardSummary`: remove the `status-card-summary` update (line 2163).
- `renderStatus`: remove the `next-scan-card-label` update (lines 2354).
- `setLastUpdated`: remove the function entirely (it only updates `last-updated-label` inside the status card).
- Error handler in `refresh()`: remove the `status-card-summary` fallback update (line 2591).

The navbar status indicators (`#live-status-label`, `#next-scan-label`) remain unchanged.

### 2b. Stats: Bare Numbers Layout

**What:** Replace the current 1-primary + 4-secondary card grid with a flat horizontal row of numbers (no card backgrounds, no borders). Four metrics: Review queue, Open PRs, Unresolved, Comments. Separated from the table below by a single border line.

**Metric change:** This intentionally replaces "Tracked PRs" (`total_prs`) with "Unresolved" (`total_unresolved`). Tracked PRs is low-signal; unresolved threads are the primary actionable metric.

**HTML change:** Replace the `#stats-row` section content. Instead of `stat-primary` and `stat-secondary` cards, render:
```html
<section class="stats-bar" id="stats-row">
  <div class="stat-item">
    <div class="stat-value">1</div>
    <div class="stat-label">Review queue</div>
  </div>
  <!-- ... repeat for Open PRs, Unresolved, Comments -->
</section>
```

**CSS change:**
- Replace the `.stats` grid rule (`display: grid; grid-template-columns: repeat(12, ...)`) and remove all `.stat`, `.stat-primary`, `.stat-secondary`, `.stat-primary-*`, `.stat-secondary-*` rules.
- Remove `.tone-*` rules.
- Remove related responsive overrides in `@media (max-width: 1180px)` and `@media (max-width: 640px)` for `.stats`, `.stat-primary`, `.stat-secondary`.
- Remove skeleton stat rules (`.skeleton-stats`, `.skeleton-stat-primary`, `.skeleton-stat-secondary`) and their responsive overrides.
- Add `.stats-bar`: `display: flex; gap: 40px; padding-bottom: 20px; border-bottom: 1px solid var(--border-soft); margin-bottom: 24px`.
- Add `.stat-value`: `font-size: 28px; font-weight: 600; color: var(--text-primary); letter-spacing: -0.5px; font-variant-numeric: tabular-nums`.
- Add `.stat-label`: `font-size: 12px; color: var(--text-tertiary); margin-top: 2px`.
- Unresolved count uses `color: var(--danger)` when > 0.

**JS change:** Simplify `renderStats` to generate 4 flat items instead of the current primary+secondary card structure. Remove `getHeadlineState` function (no longer needed — the headline logic drove the primary card's tone and copy). Keep `formatCount` helper — it is still used by `renderDashboardSummary`, `renderPRs`, and `renderMergedPRs`.

### 2c. Remove State Column

**What:** Remove the "State" column (open/closed/merged pill) from the active PR table.

**HTML change:** Remove the State `<th>` from the active PR table header.

**JS change:**
- In `renderPRRow`: remove the conditional `<td>` that renders `pill-${pr.state}` (only rendered when `showAction` is true). Reduce active `cols` from 9 → 8.
- The merged table is unaffected — it already omits the State column (`showAction = false` skips it).

**CSS change:** Remove `.pill-open`, `.pill-closed`, `.pill-merged` rules.

---

## File Inventory

| File | Action |
|------|--------|
| `src/dashboard.ts` | **Major edit** — remove HTML template string, keep routes and helpers |
| `src/index.ts` | **Minor edit** — add static file serving middleware |
| `public/index.html` | **New** — extracted HTML structure with UI changes applied |
| `public/style.css` | **New** — extracted CSS with UI changes applied |
| `public/app.js` | **New** — extracted JS with UI changes applied |

## Migration Notes

- No API changes. All `/api/*` endpoints remain identical.
- The dashboard remains a single-page app with client-side rendering and polling.
- No new dependencies required — Hono's built-in `serveStatic` is sufficient.
- Skeleton loading markup stays in `index.html` for initial load UX.
