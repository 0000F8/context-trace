import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { hasFtsSupport, openDb } from './db.js';

describe('openDb', () => {
  it('detects FTS5 support and creates sections_fts on a normal build', () => {
    const db = openDb(':memory:');
    expect(hasFtsSupport(db)).toBe(true);
    // sections_fts must be queryable (the guard actually created the table, not just
    // set the flag).
    expect(() => db.prepare('SELECT COUNT(*) FROM sections_fts').get()).not.toThrow();
    db.close();
  });

  it('migrates a pre-v0.2 db file by adding segments.outcome, preserving existing rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-migration-'));
    const path = join(dir, 'old.db');
    try {
      // Build the exact pre-v0.2 schema (no `outcome` column on segments) directly,
      // bypassing openDb, then insert a row that must survive the migration.
      const raw = new Database(path);
      raw.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT, metadata TEXT,
          started_at TEXT NOT NULL, ended_at TEXT
        );
        CREATE TABLE segments (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, idx INTEGER NOT NULL,
          label TEXT, kind TEXT NOT NULL, model TEXT, timestamp TEXT NOT NULL, metadata TEXT,
          UNIQUE(session_id, idx)
        );
        CREATE TABLE sections (
          segment_id TEXT NOT NULL, key TEXT NOT NULL, service TEXT NOT NULL,
          service_kind TEXT NOT NULL, role TEXT, position INTEGER NOT NULL,
          content TEXT, content_hash TEXT NOT NULL, tokens INTEGER NOT NULL, metadata TEXT,
          PRIMARY KEY (segment_id, key)
        );
      `);
      raw
        .prepare('INSERT INTO sessions (id, name, started_at) VALUES (?, ?, ?)')
        .run('s1', 'pre-existing session', '2026-01-01T00:00:00.000Z');
      raw
        .prepare('INSERT INTO segments (id, session_id, idx, kind, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run('seg-0', 's1', 0, 'llm_call', '2026-01-01T00:00:00.000Z');
      raw.close();

      const db = openDb(path);
      const cols = db.prepare('PRAGMA table_info(segments)').all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === 'outcome')).toBe(true);

      const row = db.prepare('SELECT * FROM segments WHERE id = ?').get('seg-0') as { session_id: string; outcome: unknown };
      expect(row.session_id).toBe('s1'); // pre-existing data survived the migration
      expect(row.outcome).toBeNull();

      // Re-opening an already-migrated file must not throw ("duplicate column").
      db.close();
      expect(() => openDb(path).close()).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
