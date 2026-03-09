import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface PR {
  id: number;
  repo: string;
  number: number;
  title: string;
  author: string;
  head_sha: string;
  state: string;
  review_status: string;
  comment_count: number;
  unresolved_count: number;
  reviewing_since: string | null;
  last_reviewed_at: string | null;
  last_scanned_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewRun {
  id: number;
  pr_id: number;
  type: string;
  status: string;
  trigger_reason: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  error: string | null;
}

export interface ScanLog {
  id: number;
  started_at: string;
  completed_at: string | null;
  prs_found: number;
  reviews_triggered: number;
  errors: string | null;
}

export function initDatabase(dbPath?: string): Database.Database {
  const p = dbPath || path.join(process.cwd(), 'data', 'raas.db');
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS prs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      review_status TEXT NOT NULL DEFAULT 'pending',
      comment_count INTEGER NOT NULL DEFAULT 0,
      unresolved_count INTEGER NOT NULL DEFAULT 0,
      reviewing_since TEXT,
      last_reviewed_at TEXT,
      last_scanned_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(repo, number)
    );

    CREATE TABLE IF NOT EXISTS review_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('initial', 'followup', 'recheck')),
      status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
      trigger_reason TEXT,
      started_at TEXT,
      completed_at TEXT,
      duration_ms INTEGER,
      exit_code INTEGER,
      error TEXT,
      FOREIGN KEY (pr_id) REFERENCES prs(id)
    );

    CREATE TABLE IF NOT EXISTS scan_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      prs_found INTEGER DEFAULT 0,
      reviews_triggered INTEGER DEFAULT 0,
      errors TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_prs_repo_number ON prs(repo, number);
    CREATE INDEX IF NOT EXISTS idx_prs_review_status ON prs(review_status);
    CREATE INDEX IF NOT EXISTS idx_review_runs_pr_id ON review_runs(pr_id);
  `);

  return db;
}

// --- Query helpers ---

export function upsertPR(
  db: Database.Database,
  pr: { repo: string; number: number; title: string; author: string; head_sha: string; state: string },
): PR {
  const stmt = db.prepare(`
    INSERT INTO prs (repo, number, title, author, head_sha, state)
    VALUES (@repo, @number, @title, @author, @head_sha, @state)
    ON CONFLICT(repo, number) DO UPDATE SET
      title = @title,
      author = @author,
      head_sha = @head_sha,
      state = @state,
      updated_at = datetime('now')
    RETURNING *
  `);
  return stmt.get(pr) as PR;
}

export function getPR(db: Database.Database, repo: string, number: number): PR | undefined {
  return db.prepare('SELECT * FROM prs WHERE repo = ? AND number = ?').get(repo, number) as PR | undefined;
}

export function getAllPRs(db: Database.Database): PR[] {
  return db.prepare('SELECT * FROM prs ORDER BY updated_at DESC').all() as PR[];
}

export function getOpenPRs(db: Database.Database): PR[] {
  return db.prepare("SELECT * FROM prs WHERE state = 'open' ORDER BY updated_at DESC").all() as PR[];
}

export function updatePRStatus(db: Database.Database, id: number, status: string): void {
  const now = new Date().toISOString();
  if (status === 'reviewing') {
    db.prepare('UPDATE prs SET review_status = ?, reviewing_since = ?, updated_at = ? WHERE id = ?')
      .run(status, now, now, id);
  } else if (status === 'reviewed') {
    db.prepare('UPDATE prs SET review_status = ?, reviewing_since = NULL, last_reviewed_at = ?, updated_at = ? WHERE id = ?')
      .run(status, now, now, id);
  } else {
    db.prepare('UPDATE prs SET review_status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, id);
  }
}

export function updatePRCommentCounts(db: Database.Database, id: number, commentCount: number, unresolvedCount: number): void {
  db.prepare("UPDATE prs SET comment_count = ?, unresolved_count = ?, last_scanned_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(commentCount, unresolvedCount, id);
}

export function updatePRState(db: Database.Database, id: number, state: string): void {
  db.prepare("UPDATE prs SET state = ?, updated_at = datetime('now') WHERE id = ?").run(state, id);
}

export function createReviewRun(db: Database.Database, prId: number, type: string, triggerReason: string): number {
  const result = db.prepare(
    "INSERT INTO review_runs (pr_id, type, status, trigger_reason) VALUES (?, ?, 'pending', ?)",
  ).run(prId, type, triggerReason);
  return Number(result.lastInsertRowid);
}

export function updateReviewRun(
  db: Database.Database,
  id: number,
  updates: Partial<{ status: string; started_at: string; completed_at: string; duration_ms: number; exit_code: number; error: string }>,
): void {
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(val);
    }
  }
  if (sets.length > 0) {
    vals.push(id);
    db.prepare(`UPDATE review_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
}

export function getReviewRuns(db: Database.Database, prId: number): ReviewRun[] {
  return db.prepare('SELECT * FROM review_runs WHERE pr_id = ? ORDER BY id DESC').all(prId) as ReviewRun[];
}

export function getPendingReviewRuns(
  db: Database.Database,
): (ReviewRun & { repo: string; pr_number: number; title: string; pr_author: string; pr_head_sha: string })[] {
  return db.prepare(`
    SELECT r.*, p.repo, p.number as pr_number, p.title, p.author as pr_author, p.head_sha as pr_head_sha
    FROM review_runs r
    JOIN prs p ON r.pr_id = p.id
    WHERE r.status = 'pending'
    ORDER BY r.id ASC
  `).all() as any[];
}

export function getRunningReviewCount(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM review_runs WHERE status = 'running'").get() as { count: number };
  return row.count;
}

export function createScanLog(db: Database.Database): number {
  const result = db.prepare("INSERT INTO scan_logs (started_at) VALUES (datetime('now'))").run();
  return Number(result.lastInsertRowid);
}

export function completeScanLog(db: Database.Database, id: number, prsFound: number, reviewsTriggered: number, errors?: string): void {
  db.prepare("UPDATE scan_logs SET completed_at = datetime('now'), prs_found = ?, reviews_triggered = ?, errors = ? WHERE id = ?")
    .run(prsFound, reviewsTriggered, errors || null, id);
}

export function getRecentScanLogs(db: Database.Database, limit: number = 20): ScanLog[] {
  return db.prepare('SELECT * FROM scan_logs ORDER BY id DESC LIMIT ?').all(limit) as ScanLog[];
}

export function getStats(db: Database.Database): {
  total_prs: number;
  open_prs: number;
  pending_reviews: number;
  reviewing: number;
  total_comments: number;
  total_unresolved: number;
} {
  const row = db.prepare(`
    SELECT
      COUNT(*) as total_prs,
      SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) as open_prs,
      SUM(CASE WHEN review_status = 'pending' THEN 1 ELSE 0 END) as pending_reviews,
      SUM(CASE WHEN review_status = 'reviewing' THEN 1 ELSE 0 END) as reviewing,
      SUM(comment_count) as total_comments,
      SUM(unresolved_count) as total_unresolved
    FROM prs
  `).get() as any;

  return {
    total_prs: row.total_prs || 0,
    open_prs: row.open_prs || 0,
    pending_reviews: row.pending_reviews || 0,
    reviewing: row.reviewing || 0,
    total_comments: row.total_comments || 0,
    total_unresolved: row.total_unresolved || 0,
  };
}

export function resetOrphanedReviews(db: Database.Database): void {
  const resetPRs = db.prepare("UPDATE prs SET review_status = 'failed' WHERE review_status = 'reviewing'").run();
  const resetRuns = db.prepare("UPDATE review_runs SET status = 'failed', error = 'Server restarted', completed_at = datetime('now') WHERE status = 'running'").run();
  if (resetPRs.changes > 0 || resetRuns.changes > 0) {
    console.log(`[db] Reset ${resetPRs.changes} orphaned PRs and ${resetRuns.changes} orphaned review runs`);
  }
}
