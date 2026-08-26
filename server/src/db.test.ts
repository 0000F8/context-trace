import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { fnv1a64 } from '@context-trace/types';
import { hasFtsSupport, openDb } from './db.js';
import { upsertSegment, upsertSession } from './store.js';

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

  it('heals a partial sections_fts gap on reopen, not just a fully-empty table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-fts-heal-'));
    const path = join(dir, 'heal.db');
    try {
      let db = openDb(path);
      upsertSession(db, { id: 's1', name: 'sess', startedAt: '2026-01-01T00:00:00.000Z' });
      upsertSegment(db, {
        id: 'seg-0',
        sessionId: 's1',
        index: 0,
        kind: 'llm_call',
        timestamp: '2026-01-01T00:00:00.000Z',
        sections: [
          { key: 'a', service: 'svc', serviceKind: 'memory', position: 0, content: 'alpha', contentHash: fnv1a64('alpha'), tokens: 5 },
          { key: 'b', service: 'svc', serviceKind: 'memory', position: 1, content: 'beta', contentHash: fnv1a64('beta'), tokens: 4 },
        ],
      });

      const sectionsCount = (db.prepare('SELECT COUNT(*) AS c FROM sections').get() as { c: number }).c;
      expect((db.prepare('SELECT COUNT(*) AS c FROM sections_fts').get() as { c: number }).c).toBe(sectionsCount);

      // Simulate a partial gap (e.g. rows written during a prior boot without FTS5
      // support) by deleting one fts row directly, leaving the `sections` row intact.
      db.prepare(`DELETE FROM sections_fts WHERE key = 'b'`).run();
      expect((db.prepare('SELECT COUNT(*) AS c FROM sections_fts').get() as { c: number }).c).toBe(sectionsCount - 1);
      db.close();

      db = openDb(path); // reopen: ftsCount < sectionsCount must trigger a full heal
      expect((db.prepare('SELECT COUNT(*) AS c FROM sections_fts').get() as { c: number }).c).toBe(sectionsCount);
      // The section that was never removed must not have been duplicated by the rebuild.
      expect((db.prepare(`SELECT COUNT(*) AS c FROM sections_fts WHERE key = 'a'`).get() as { c: number }).c).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
