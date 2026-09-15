import { createRequire } from 'node:module';
import type { DatabaseSync as SqliteDatabaseSync, StatementSync } from 'node:sqlite';
import { paths, ensureDirs } from './paths.ts';
import { readJson, writeJsonAtomic } from './util.ts';

// 同步探测 node:sqlite（保持模块图无 TLA，pm2 fork 模式的 require() 包装才能加载 ESM）
const localRequire = createRequire(import.meta.url);
let DatabaseSync: typeof SqliteDatabaseSync | null = null;
try {
  ({ DatabaseSync } = localRequire('node:sqlite'));
} catch {
  DatabaseSync = null;
}

interface ProcessedFileKey {
  path: string;
  size: number;
  mtime: number;
}

interface ProcessedRow extends ProcessedFileKey {
  jobId: string | null;
  processed_at: number;
}

class SqliteStore {
  db: SqliteDatabaseSync;
  _check: StatementSync;
  _insert: StatementSync;
  constructor(file: string) {
    this.db = new DatabaseSync!(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed_files (
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        job_id TEXT,
        processed_at INTEGER NOT NULL,
        PRIMARY KEY (path, size, mtime)
      );
    `);
    this._check = this.db.prepare('SELECT 1 FROM processed_files WHERE path=? AND size=? AND mtime=?');
    this._insert = this.db.prepare(
      'INSERT OR REPLACE INTO processed_files (path, size, mtime, job_id, processed_at) VALUES (?,?,?,?,?)'
    );
  }
  isProcessed({ path, size, mtime }: ProcessedFileKey): boolean {
    return this._check.get(path, size, Math.round(mtime)) !== undefined;
  }
  markProcessed({ path, size, mtime, jobId = null }: ProcessedFileKey & { jobId?: string | null }): void {
    this._insert.run(path, size, Math.round(mtime), jobId, Date.now());
  }
  close(): void {
    this.db.close();
  }
}

class JsonStore {
  file: string;
  rows: ProcessedRow[];
  constructor(file: string) {
    this.file = file;
    this.rows = readJson(file, [] as ProcessedRow[]);
  }
  isProcessed({ path, size, mtime }: ProcessedFileKey): boolean {
    return this.rows.some((r) => r.path === path && r.size === size && Math.round(r.mtime) === Math.round(mtime));
  }
  markProcessed({ path, size, mtime, jobId = null }: ProcessedFileKey & { jobId?: string | null }): void {
    this.rows = this.rows.filter((r) => !(r.path === path && r.size === size));
    this.rows.push({ path, size, mtime, jobId, processed_at: Date.now() });
    writeJsonAtomic(this.file, this.rows);
  }
  close(): void {}
}

let store: SqliteStore | JsonStore | null = null;

export function getStore(): SqliteStore | JsonStore {
  if (store) return store;
  ensureDirs();
  store = DatabaseSync ? new SqliteStore(paths.db) : new JsonStore(paths.dbJson);
  return store;
}

export const storeKind = (): 'sqlite' | 'json-fallback' => (DatabaseSync ? 'sqlite' : 'json-fallback');
