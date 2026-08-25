import { describe, expect, it } from 'vitest';
import { fnv1a64 } from '@context-trace/types';
import type { SegmentWithSections } from '@context-trace/types';
import { openDb, type Db } from './db.js';
import { getSessionSummary, upsertSegment } from './store.js';

function section(key: string, content: string) {
  return {
    key,
    service: 'svc',
    serviceKind: 'memory' as const,
    position: 0,
    content,
    contentHash: fnv1a64(content),
    tokens: content.length,
  };
}

describe('upsertSegment stub-session rollback', () => {
  it('does not leave a phantom stub session when the transaction fails after ensureStubSession', () => {
    // app.ts's validation now rejects duplicate section keys before they ever reach the
    // store layer, but upsertSegment is exported and can still be called directly (as this
    // test does, and as any future caller might) with input that violates the sections table's
    // (segment_id, key) primary key. That must still fail atomically: the stub session created
    // for the unknown sessionId must roll back along with everything else in the transaction.
    const db: Db = openDb(':memory:');
    const segment: SegmentWithSections = {
      id: 'seg-0',
      sessionId: 'ghost-session',
      index: 0,
      kind: 'llm_call',
      timestamp: new Date(2026, 0, 1).toISOString(),
      sections: [section('dup', 'first'), section('dup', 'second')],
    };

    expect(() => upsertSegment(db, segment)).toThrow();

    // The stub session ensureStubSession would have created must not have survived the
    // rollback — getSessionSummary must report the session as not found.
    expect(getSessionSummary(db, 'ghost-session')).toBeUndefined();
  });

  it('still creates the stub session when the upsert actually succeeds', () => {
    const db: Db = openDb(':memory:');
    const segment: SegmentWithSections = {
      id: 'seg-0',
      sessionId: 'ghost-session',
      index: 0,
      kind: 'llm_call',
      timestamp: new Date(2026, 0, 1).toISOString(),
      sections: [section('a', 'ok')],
    };

    upsertSegment(db, segment);

    const summary = getSessionSummary(db, 'ghost-session');
    expect(summary).toBeDefined();
    expect(summary?.segmentCount).toBe(1);
  });
});
