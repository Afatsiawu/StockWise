import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_SQL } from './schema.js';
import { DEFAULT_SETTINGS } from '../domain/types.js';

export type Db = DatabaseSync;

export interface OpenDatabaseOptions {
  path: string;
  verbose?: boolean;
}

export function openDatabase(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  db.exec(SCHEMA_SQL);
  seedSettings(db);
  return db;
}

export function seedSettings(db: Db): void {
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insert.run(key, String(value));
  }
}

/**
 * Run `fn` inside BEGIN IMMEDIATE ... COMMIT. Any thrown error rolls the whole unit of
 * work back, which is what keeps a sale, its line items and the stock ledger consistent.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // A failed rollback (e.g. connection already closed) must not mask the original error.
    }
    throw error;
  }
}

/** Typed rows: node:sqlite returns null-prototype objects, so copy them into plain ones. */
export function rows<T>(statement: ReturnType<Db['prepare']>, ...params: SupportedParam[]): T[] {
  return (statement.all(...params) as Record<string, unknown>[]).map((row) => ({ ...row })) as T[];
}

export function row<T>(statement: ReturnType<Db['prepare']>, ...params: SupportedParam[]): T | undefined {
  const result = statement.get(...params) as Record<string, unknown> | undefined;
  return result === undefined ? undefined : ({ ...result } as T);
}

export type SupportedParam = string | number | bigint | null | Uint8Array;

export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

export function toStringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
