import { describe, expect, it } from 'vitest';
import { fnv1a64 } from '@context-trace/types';
import type { Section, SessionSummary } from '@context-trace/types';
import { compileTrace, type TraceSourceSegment } from './compile.js';

function section(overrides: Partial<Section> & { key: string; content: string }): Section {
  return {
    service: 'svc',
    serviceKind: 'other',
    position: 0,
    tokens: overrides.content.length,
    contentHash: fnv1a64(overrides.content),
    ...overrides,
  };
}

function segment(overrides: Partial<TraceSourceSegment> & { id: string; index: number; sections: Section[] }): TraceSourceSegment {
  return {
    sessionId: 'sess-1',
    kind: 'llm_call',
    timestamp: new Date(2026, 0, 1, 0, overrides.index ?? 0).toISOString(),
    ...overrides,
  };
}

const EMPTY_SUMMARY: SessionSummary = {
  id: 'sess-1',
  name: 'test session',
  startedAt: new Date(2026, 0, 1).toISOString(),
  segmentCount: 0,
  sectionCount: 0,
  totalTokens: 0,
  peakTokens: 0,
  services: [],
  lastActivityAt: new Date(2026, 0, 1).toISOString(),
};

describe('compileTrace', () => {
  it('handles an empty session (no segments)', () => {
    const trace = compileTrace(EMPTY_SUMMARY, []);
    expect(trace.segments).toEqual([]);
    expect(trace.spans).toEqual([]);
    expect(trace.services).toEqual([]);
    expect(trace.session).toBe(EMPTY_SUMMARY);
  });

  it('marks every section as added on a single first segment', () => {
    const seg = segment({
      id: 'seg-0',
      index: 0,
      sections: [
        section({ key: 'a', service: 'svc-a', serviceKind: 'system', position: 0, content: 'alpha' }),
        section({ key: 'b', service: 'svc-b', serviceKind: 'memory', position: 1, content: 'beta' }),
      ],
    });

    const trace = compileTrace(EMPTY_SUMMARY, [seg]);
    expect(trace.segments).toHaveLength(1);
    const ops = trace.segments[0]!.ops;
    expect(ops).toEqual([
      { op: 'add', key: 'a', service: 'svc-a', tokens: 5 },
      { op: 'add', key: 'b', service: 'svc-b', tokens: 4 },
    ]);
  });

  it('distinguishes carried (same hash) from changed (different hash)', () => {
    const seg0 = segment({
      id: 'seg-0',
      index: 0,
      sections: [
        section({ key: 'a', service: 'svc', serviceKind: 'memory', position: 0, content: 'v1' }),
        section({ key: 'b', service: 'svc', serviceKind: 'memory', position: 1, content: 'same' }),
      ],
    });
    const seg1 = segment({
      id: 'seg-1',
      index: 1,
      sections: [
        section({ key: 'a', service: 'svc', serviceKind: 'memory', position: 0, content: 'v2' }),
        section({ key: 'b', service: 'svc', serviceKind: 'memory', position: 1, content: 'same' }),
      ],
    });

    const trace = compileTrace(EMPTY_SUMMARY, [seg0, seg1]);
    const ops = trace.segments[1]!.ops;
    expect(ops).toEqual([
      { op: 'change', key: 'a', service: 'svc', tokens: 2 },
      { op: 'carry', key: 'b', service: 'svc', tokens: 4 },
    ]);
  });

  it('reports a key dropped from the previous segment as removed, appended last', () => {
    const seg0 = segment({
      id: 'seg-0',
      index: 0,
      sections: [
        section({ key: 'a', service: 'svc', serviceKind: 'memory', position: 0, content: 'keep' }),
        section({ key: 'b', service: 'svc', serviceKind: 'memory', position: 1, content: 'drop-me' }),
      ],
    });
    const seg1 = segment({
      id: 'seg-1',
      index: 1,
      sections: [section({ key: 'a', service: 'svc', serviceKind: 'memory', position: 0, content: 'keep' })],
    });

    const trace = compileTrace(EMPTY_SUMMARY, [seg0, seg1]);
    const ops = trace.segments[1]!.ops;
    expect(ops).toEqual([
      { op: 'carry', key: 'a', service: 'svc', tokens: 4 },
      { op: 'remove', key: 'b', service: 'svc', tokens: 7 },
    ]);
  });

  it('handles a key re-added after removal: presence has a gap and versions count correctly', () => {
    const seg0 = segment({
      id: 'seg-0',
      index: 0,
      sections: [section({ key: 'k', service: 'svc', serviceKind: 'tool', position: 0, content: 'first' })],
    });
    const seg1 = segment({ id: 'seg-1', index: 1, sections: [] });
    const seg2 = segment({
      id: 'seg-2',
      index: 2,
      sections: [section({ key: 'k', service: 'svc', serviceKind: 'tool', position: 0, content: 'second' })],
    });

    const trace = compileTrace(EMPTY_SUMMARY, [seg0, seg1, seg2]);
    const span = trace.spans.find((s) => s.key === 'k')!;
    expect(span.presence).toEqual([0, 2]);
    expect(span.firstIndex).toBe(0);
    expect(span.lastIndex).toBe(2);
    // content differs across the gap ('first' -> 'second'), so this counts as a new version.
    expect(span.versions).toBe(2);

    // At the segment level, re-appearing after a gap is an 'add' (previous segment, index 1, didn't have it).
    expect(trace.segments[2]!.ops).toEqual([{ op: 'add', key: 'k', service: 'svc', tokens: 6 }]);
  });

  it('does not increment versions when a key re-appears with identical content after a gap', () => {
    const seg0 = segment({
      id: 'seg-0',
      index: 0,
      sections: [section({ key: 'k', service: 'svc', serviceKind: 'tool', position: 0, content: 'stable' })],
    });
    const seg1 = segment({ id: 'seg-1', index: 1, sections: [] });
    const seg2 = segment({
      id: 'seg-2',
      index: 2,
      sections: [section({ key: 'k', service: 'svc', serviceKind: 'tool', position: 0, content: 'stable' })],
    });

    const trace = compileTrace(EMPTY_SUMMARY, [seg0, seg1, seg2]);
    const span = trace.spans.find((s) => s.key === 'k')!;
    expect(span.presence).toEqual([0, 2]);
    expect(span.versions).toBe(1);
  });

  it('computes per-segment service token totals and section counts', () => {
    const seg = segment({
      id: 'seg-0',
      index: 0,
      sections: [
        section({ key: 'a', service: 'memory-svc', serviceKind: 'memory', position: 0, content: '12345678' }), // 8 tokens
        section({ key: 'b', service: 'memory-svc', serviceKind: 'memory', position: 1, content: 'ab' }), // 2 tokens
        section({ key: 'c', service: 'retrieval-svc', serviceKind: 'retrieval', position: 2, content: 'xy' }), // 2 tokens
      ],
    });

    const trace = compileTrace(EMPTY_SUMMARY, [seg]);
    const services = trace.segments[0]!.services;
    expect(services).toEqual([
      { name: 'memory-svc', kind: 'memory', tokens: 10, sectionCount: 2 },
      { name: 'retrieval-svc', kind: 'retrieval', tokens: 2, sectionCount: 1 },
    ]);
  });

  it('computes maxShare as the largest fraction of a segment a service ever owns', () => {
    const seg0 = segment({
      id: 'seg-0',
      index: 0,
      sections: [
        section({ key: 'a', service: 'svc-a', serviceKind: 'memory', position: 0, content: 'aaaa' }), // 4 tokens
        section({ key: 'b', service: 'svc-b', serviceKind: 'tool', position: 1, content: 'bbbb' }), // 4 tokens -> 50%
      ],
    });
    const seg1 = segment({
      id: 'seg-1',
      index: 1,
      sections: [
        section({ key: 'a', service: 'svc-a', serviceKind: 'memory', position: 0, content: 'aaaaaaaaaaaaaaaaaaaa' }), // 20 tokens
        section({ key: 'b', service: 'svc-b', serviceKind: 'tool', position: 1, content: 'bb' }), // 2 tokens -> ~9%
      ],
    });

    const trace = compileTrace(EMPTY_SUMMARY, [seg0, seg1]);
    const svcA = trace.services.find((s) => s.name === 'svc-a')!;
    const svcB = trace.services.find((s) => s.name === 'svc-b')!;
    expect(svcA.maxShare).toBeCloseTo(20 / 22, 5);
    expect(svcB.maxShare).toBeCloseTo(4 / 8, 5);
  });

  it('orders ops by position, with removals appended last regardless of their old position', () => {
    const seg0 = segment({
      id: 'seg-0',
      index: 0,
      sections: [
        section({ key: 'a', service: 'svc', serviceKind: 'other', position: 0, content: 'A' }),
        section({ key: 'b', service: 'svc', serviceKind: 'other', position: 1, content: 'B' }),
        section({ key: 'c', service: 'svc', serviceKind: 'other', position: 2, content: 'C' }),
      ],
    });
    const seg1 = segment({
      id: 'seg-1',
      index: 1,
      sections: [
        // 'b' dropped (was at position 1); 'c' and a new 'd' reordered.
        section({ key: 'c', service: 'svc', serviceKind: 'other', position: 0, content: 'C' }),
        section({ key: 'd', service: 'svc', serviceKind: 'other', position: 1, content: 'D' }),
        section({ key: 'a', service: 'svc', serviceKind: 'other', position: 2, content: 'A2' }),
      ],
    });

    const trace = compileTrace(EMPTY_SUMMARY, [seg0, seg1]);
    const ops = trace.segments[1]!.ops;
    expect(ops.map((o) => o.key)).toEqual(['c', 'd', 'a', 'b']);
    expect(ops.map((o) => o.op)).toEqual(['carry', 'add', 'change', 'remove']);
  });

  it('builds tokensByIndex per span across the segments where the key is present', () => {
    const seg0 = segment({
      id: 'seg-0',
      index: 0,
      sections: [section({ key: 'k', service: 'svc', serviceKind: 'memory', position: 0, content: 'ab' })], // 2 tokens
    });
    const seg1 = segment({
      id: 'seg-1',
      index: 1,
      sections: [section({ key: 'k', service: 'svc', serviceKind: 'memory', position: 0, content: 'abcdefgh' })], // 8 tokens
    });

    const trace = compileTrace(EMPTY_SUMMARY, [seg0, seg1]);
    const span = trace.spans.find((s) => s.key === 'k')!;
    expect(span.tokensByIndex).toEqual({ 0: 2, 1: 8 });
  });
});
