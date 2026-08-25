import { describe, expect, it } from 'vitest';
import { buildCellStates, findPreviousSegment, groupSpansByService } from './strata';
import type { CompiledTrace, TraceSegment, TraceSpan } from '@context-trace/types';

describe('buildCellStates', () => {
  it('maps add/change/carry/remove ops to cell states per segment', () => {
    const trace: Pick<CompiledTrace, 'segments'> = {
      segments: [
        {
          id: 's0',
          index: 0,
          kind: 'llm_call',
          timestamp: '2026-01-01T00:00:00Z',
          totalTokens: 10,
          sectionCount: 1,
          services: [],
          ops: [{ op: 'add', key: 'mem:profile', service: 'memory', tokens: 10 }],
        },
        {
          id: 's1',
          index: 1,
          kind: 'llm_call',
          timestamp: '2026-01-01T00:00:00Z',
          totalTokens: 12,
          sectionCount: 1,
          services: [],
          ops: [{ op: 'change', key: 'mem:profile', service: 'memory', tokens: 12 }],
        },
        {
          id: 's2',
          index: 2,
          kind: 'llm_call',
          timestamp: '2026-01-01T00:00:00Z',
          totalTokens: 12,
          sectionCount: 1,
          services: [],
          ops: [{ op: 'carry', key: 'mem:profile', service: 'memory', tokens: 12 }],
        },
        {
          id: 's3',
          index: 3,
          kind: 'llm_call',
          timestamp: '2026-01-01T00:00:00Z',
          totalTokens: 0,
          sectionCount: 0,
          services: [],
          ops: [{ op: 'remove', key: 'mem:profile', service: 'memory', tokens: 0 }],
        },
      ],
    };
    const cellStates = buildCellStates(trace);
    const byIndex = cellStates.get('mem:profile')!;
    expect(byIndex.get(0)).toBe('added');
    expect(byIndex.get(1)).toBe('changed');
    expect(byIndex.get(2)).toBe('carried');
    expect(byIndex.get(3)).toBe('removed');
    expect(byIndex.has(4)).toBe(false);
  });
});

describe('groupSpansByService', () => {
  function span(overrides: Partial<TraceSpan>): TraceSpan {
    return {
      key: 'k',
      service: 'memory',
      serviceKind: 'memory',
      firstIndex: 0,
      lastIndex: 0,
      presence: [0],
      versions: 1,
      tokensByIndex: {},
      ...overrides,
    };
  }

  it('groups rows by service in the given service order', () => {
    const spans = [
      span({ key: 'r:doc1', service: 'retrieval', firstIndex: 1 }),
      span({ key: 'mem:profile', service: 'memory', firstIndex: 0 }),
      span({ key: 'r:doc0', service: 'retrieval', firstIndex: 0 }),
    ];
    const groups = groupSpansByService(spans, ['memory', 'retrieval']);
    expect(groups.map((g) => g.service)).toEqual(['memory', 'retrieval']);
    expect(groups[1]!.rows.map((r) => r.span.key)).toEqual(['r:doc0', 'r:doc1']);
  });

  it('appends services missing from the order at the end, sorted', () => {
    const spans = [span({ key: 'k1', service: 'zeta' }), span({ key: 'k2', service: 'memory' })];
    const groups = groupSpansByService(spans, ['memory']);
    expect(groups.map((g) => g.service)).toEqual(['memory', 'zeta']);
  });
});

describe('findPreviousSegment', () => {
  function segment(index: number): TraceSegment {
    return {
      id: `s${index}`,
      index,
      kind: 'llm_call',
      timestamp: '2026-01-01T00:00:00Z',
      totalTokens: 0,
      sectionCount: 0,
      services: [],
      ops: [],
    };
  }

  it('finds the largest index strictly less than the target with sparse indexes', () => {
    const segments = [segment(0), segment(2), segment(5), segment(9)];
    expect(findPreviousSegment(segments, 9)!.index).toBe(5);
    expect(findPreviousSegment(segments, 5)!.index).toBe(2);
    expect(findPreviousSegment(segments, 2)!.index).toBe(0);
  });

  it('is order-independent (does not assume the array is pre-sorted)', () => {
    const segments = [segment(9), segment(0), segment(5), segment(2)];
    expect(findPreviousSegment(segments, 9)!.index).toBe(5);
  });

  it('returns null when the target is the first segment', () => {
    const segments = [segment(0), segment(2)];
    expect(findPreviousSegment(segments, 0)).toBeNull();
  });

  it('is not fooled by target - 1 when that index does not exist', () => {
    // target-1 (index 4) was never recorded; the true predecessor is index 2.
    const segments = [segment(0), segment(2), segment(5)];
    expect(findPreviousSegment(segments, 5)!.index).toBe(2);
  });
});
