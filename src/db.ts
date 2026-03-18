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
  metadata: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  error: string | null;
}

export interface PendingReviewRun extends ReviewRun {
  repo: string;
  pr_number: number;
  title: string;
  pr_author: string;
  pr_head_sha: string;
}

export interface ScanLog {
  id: number;
  started_at: string;
  completed_at: string | null;
  prs_found: number;
  reviews_triggered: number;
  errors: string | null;
}

export interface Stats {
  total_prs: number;
  open_prs: number;
  pending_reviews: number;
  reviewing: number;
  total_comments: number;
  total_unresolved: number;
}

export interface UpsertPRInput {
  repo: string;
  number: number;
  title: string;
  author: string;
  head_sha: string;
  state: string;
}

export interface ReviewRunUpdate {
  status?: string;
  metadata?: string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  exit_code?: number;
  error?: string;
}

export interface Storage {
  close(): void;
  upsertPR(pr: UpsertPRInput): PR;
  getPR(repo: string, number: number): PR | undefined;
  getPRById(id: number): PR | undefined;
  getAllPRs(): PR[];
  getOpenPRs(): PR[];
  updatePRStatus(id: number, status: string): void;
  updatePRCommentCounts(id: number, commentCount: number, unresolvedCount: number): void;
  updatePRState(id: number, state: string): void;
  createReviewRun(prId: number, type: string, triggerReason: string, metadata?: string): number;
  updateReviewRun(id: number, updates: ReviewRunUpdate): void;
  getReviewRuns(prId: number): ReviewRun[];
  getLatestReviewRun(prId: number): ReviewRun | undefined;
  getLatestReviewRunByType(prId: number, type: string): ReviewRun | undefined;
  getActiveReviewRun(prId: number): ReviewRun | undefined;
  hasPrimaryReviewRun(prId: number): boolean;
  hasTriageRunForSha(prId: number, headSha: string): boolean;
  getPendingReviewRuns(): PendingReviewRun[];
  getRunningReviewCount(): number;
  createScanLog(): number;
  completeScanLog(id: number, prsFound: number, reviewsTriggered: number, errors?: string): void;
  getRecentScanLogs(limit?: number): ScanLog[];
  getStats(): Stats;
  resetOrphanedReviews(): void;
}

class SQLiteStorage implements Storage {
  constructor(private readonly database: Database.Database) {}

  close(): void {
    this.database.close();
  }

  upsertPR(pr: UpsertPRInput): PR {
    const stmt = this.database.prepare(`
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

  getPR(repo: string, number: number): PR | undefined {
    return this.database.prepare('SELECT * FROM prs WHERE repo = ? AND number = ?').get(repo, number) as PR | undefined;
  }

  getPRById(id: number): PR | undefined {
    return this.database.prepare('SELECT * FROM prs WHERE id = ?').get(id) as PR | undefined;
  }

  getAllPRs(): PR[] {
    return this.database.prepare('SELECT * FROM prs ORDER BY repo ASC, number DESC').all() as PR[];
  }

  getOpenPRs(): PR[] {
    return this.database.prepare("SELECT * FROM prs WHERE state = 'open' ORDER BY repo ASC, number DESC").all() as PR[];
  }

  updatePRStatus(id: number, status: string): void {
    const now = new Date().toISOString();
    if (status === 'reviewing') {
      this.database.prepare('UPDATE prs SET review_status = ?, reviewing_since = ?, updated_at = ? WHERE id = ?')
        .run(status, now, now, id);
      return;
    }

    if (status === 'reviewed') {
      this.database.prepare('UPDATE prs SET review_status = ?, reviewing_since = NULL, last_reviewed_at = ?, updated_at = ? WHERE id = ?')
        .run(status, now, now, id);
      return;
    }

    this.database.prepare('UPDATE prs SET review_status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, id);
  }

  updatePRCommentCounts(id: number, commentCount: number, unresolvedCount: number): void {
    this.database.prepare("UPDATE prs SET comment_count = ?, unresolved_count = ?, last_scanned_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(commentCount, unresolvedCount, id);
  }

  updatePRState(id: number, state: string): void {
    this.database.prepare("UPDATE prs SET state = ?, updated_at = datetime('now') WHERE id = ?").run(state, id);
  }

  createReviewRun(prId: number, type: string, triggerReason: string, metadata?: string): number {
    const result = this.database.prepare(
      "INSERT INTO review_runs (pr_id, type, status, trigger_reason, metadata) VALUES (?, ?, 'pending', ?, ?)",
    ).run(prId, type, triggerReason, metadata || null);
    return Number(result.lastInsertRowid);
  }

  updateReviewRun(id: number, updates: ReviewRunUpdate): void {
    const sets: string[] = [];
    const values: Array<string | number> = [];

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        sets.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (sets.length === 0) {
      return;
    }

    values.push(id);
    this.database.prepare(`UPDATE review_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  getReviewRuns(prId: number): ReviewRun[] {
    return this.database.prepare('SELECT * FROM review_runs WHERE pr_id = ? ORDER BY id DESC').all(prId) as ReviewRun[];
  }

  getLatestReviewRun(prId: number): ReviewRun | undefined {
    return this.database.prepare('SELECT * FROM review_runs WHERE pr_id = ? ORDER BY id DESC LIMIT 1').get(prId) as ReviewRun | undefined;
  }

  getLatestReviewRunByType(prId: number, type: string): ReviewRun | undefined {
    return this.database.prepare('SELECT * FROM review_runs WHERE pr_id = ? AND type = ? ORDER BY id DESC LIMIT 1').get(prId, type) as ReviewRun | undefined;
  }

  getActiveReviewRun(prId: number): ReviewRun | undefined {
    return this.database.prepare(
      "SELECT * FROM review_runs WHERE pr_id = ? AND status IN ('pending', 'running') ORDER BY id DESC LIMIT 1",
    ).get(prId) as ReviewRun | undefined;
  }

  hasPrimaryReviewRun(prId: number): boolean {
    const row = this.database.prepare(
      "SELECT 1 as found FROM review_runs WHERE pr_id = ? AND type IN ('initial', 'recheck') LIMIT 1",
    ).get(prId) as { found: number } | undefined;
    return Boolean(row?.found);
  }

  hasTriageRunForSha(prId: number, headSha: string): boolean {
    const rows = this.database.prepare(
      "SELECT status, metadata FROM review_runs WHERE pr_id = ? AND type = 'ci-triage' ORDER BY id DESC",
    ).all(prId) as Array<{ status: string; metadata: string | null }>;

    let hasLegacyTriageRun = false;
    for (const row of rows) {
      if (!row.metadata) {
        hasLegacyTriageRun = true;
        continue;
      }

      try {
        const parsed = JSON.parse(row.metadata) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as { head_sha?: unknown }).head_sha === headSha) {
          return true;
        }
      } catch {
        hasLegacyTriageRun = true;
      }
    }

    return hasLegacyTriageRun && rows.some((row) => row.status === 'pending' || row.status === 'running');
  }

  getPendingReviewRuns(): PendingReviewRun[] {
    return this.database.prepare(`
      SELECT r.*, p.repo, p.number as pr_number, p.title, p.author as pr_author, p.head_sha as pr_head_sha
      FROM review_runs r
      JOIN prs p ON r.pr_id = p.id
      WHERE r.status = 'pending'
      ORDER BY r.id ASC
    `).all() as PendingReviewRun[];
  }

  getRunningReviewCount(): number {
    const row = this.database.prepare("SELECT COUNT(*) as count FROM review_runs WHERE status = 'running'").get() as { count: number };
    return row.count;
  }

  createScanLog(): number {
    const result = this.database.prepare("INSERT INTO scan_logs (started_at) VALUES (datetime('now'))").run();
    return Number(result.lastInsertRowid);
  }

  completeScanLog(id: number, prsFound: number, reviewsTriggered: number, errors?: string): void {
    this.database.prepare("UPDATE scan_logs SET completed_at = datetime('now'), prs_found = ?, reviews_triggered = ?, errors = ? WHERE id = ?")
      .run(prsFound, reviewsTriggered, errors || null, id);
  }

  getRecentScanLogs(limit: number = 20): ScanLog[] {
    return this.database.prepare('SELECT * FROM scan_logs ORDER BY id DESC LIMIT ?').all(limit) as ScanLog[];
  }

  getStats(): Stats {
    const row = this.database.prepare(`
      SELECT
        COUNT(*) as total_prs,
        SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) as open_prs,
        SUM(CASE WHEN state = 'open' AND review_status = 'pending' THEN 1 ELSE 0 END) as pending_reviews,
        SUM(CASE WHEN state = 'open' AND review_status = 'reviewing' THEN 1 ELSE 0 END) as reviewing,
        SUM(CASE WHEN state = 'open' THEN comment_count ELSE 0 END) as total_comments,
        SUM(CASE WHEN state = 'open' THEN unresolved_count ELSE 0 END) as total_unresolved
      FROM prs
    `).get() as Partial<Stats>;

    return {
      total_prs: row.total_prs || 0,
      open_prs: row.open_prs || 0,
      pending_reviews: row.pending_reviews || 0,
      reviewing: row.reviewing || 0,
      total_comments: row.total_comments || 0,
      total_unresolved: row.total_unresolved || 0,
    };
  }

  resetOrphanedReviews(): void {
    const resetPRs = this.database.prepare("UPDATE prs SET review_status = 'failed' WHERE review_status = 'reviewing'").run();
    const resetRuns = this.database.prepare("UPDATE review_runs SET status = 'failed', error = 'Server restarted', completed_at = datetime('now') WHERE status = 'running'").run();
    if (resetPRs.changes > 0 || resetRuns.changes > 0) {
      console.log(`[db] Reset ${resetPRs.changes} orphaned PRs and ${resetRuns.changes} orphaned review runs`);
    }
  }
}

export function initDatabase(dbPath?: string): Storage {
  const resolvedPath = dbPath || path.join(process.cwd(), 'outputs', 'data', 'raas.db');
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const database = new Database(resolvedPath);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');

  database.exec(`
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
      type TEXT NOT NULL CHECK(type IN ('initial', 'followup', 'recheck', 'ci-triage')),
      status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
      trigger_reason TEXT,
      metadata TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_prs_repo_number_sort ON prs(repo, number DESC);
    CREATE INDEX IF NOT EXISTS idx_prs_review_status ON prs(review_status);
    CREATE INDEX IF NOT EXISTS idx_review_runs_pr_id ON review_runs(pr_id);
  `);

  const reviewRunColumns = database.prepare("PRAGMA table_info(review_runs)").all() as Array<{ name: string }>;
  if (!reviewRunColumns.some((column) => column.name === 'metadata')) {
    database.exec('ALTER TABLE review_runs ADD COLUMN metadata TEXT');
  }

  // Migrate CHECK constraint to allow 'ci-triage' type (SQLite requires recreate)
  try {
    database.exec("INSERT INTO review_runs (pr_id, type, status, trigger_reason) VALUES (0, 'ci-triage', 'pending', 'migration-test')");
    database.exec("DELETE FROM review_runs WHERE pr_id = 0 AND trigger_reason = 'migration-test'");
  } catch {
    // CHECK constraint rejects ci-triage — recreate the table with updated constraint
    database.exec(`
      CREATE TABLE review_runs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_id INTEGER NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('initial', 'followup', 'recheck', 'ci-triage')),
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
        trigger_reason TEXT,
        metadata TEXT,
        started_at TEXT,
        completed_at TEXT,
        duration_ms INTEGER,
        exit_code INTEGER,
        error TEXT,
        FOREIGN KEY (pr_id) REFERENCES prs(id)
      );
      INSERT INTO review_runs_new SELECT * FROM review_runs;
      DROP TABLE review_runs;
      ALTER TABLE review_runs_new RENAME TO review_runs;
      CREATE INDEX IF NOT EXISTS idx_review_runs_pr_id ON review_runs(pr_id);
    `);
  }

  return new SQLiteStorage(database);
}
