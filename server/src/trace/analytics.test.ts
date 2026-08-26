import { describe, expect, it } from 'vitest';
import { fnv1a64 } from '@context-trace/types';
import type { Section, SegmentOutcome, SessionSummary } from '@context-trace/types';
import { compileTrace, type TraceSourceSegment } from './compile.js';
import { computeAnalytics } from './analytics.js';

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

function segment(
  overrides: Partial<TraceSourceSegment> & { id: string; index: number; sections: Section[] } & {
    outcome?: SegmentOutcome;
  }
): TraceSourceSegment {
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

describe('computeAnalytics', () => {
  describe('over-window', () => {
    it('flags overWindow only when totalTokens strictly exceeds window (equal is not over)', () => {
      const summary = { ...EMPTY_SUMMARY, metadata: { window: 100 } };
      const seg0 = segment({ id: 's0', index: 0, sections: [section({ key: 'a', content: 'x'.repeat(100) })] });
      const seg1 = segment({ id: 's1', index: 1, sections: [section({ key: 'a', content: 'x'.repeat(101) })] });
      const analytics = computeAnalytics(compileTrace(summary, [seg0, seg1]));

      expect(analytics.window).toBe(100);
      expect(analytics.perSegment[0]!.overWindow).toBe(false);
      expect(analytics.perSegment[1]!.overWindow).toBe(true);
      const overWindowFindings = analytics.findings.filter((f) => f.kind === 'over-window');
      expect(overWindowFindings).toHaveLength(1);
      expect(overWindowFindings[0]!.severity).toBe('warning');
      expect(overWindowFindings[0]!.segmentIndex).toBe(1);
    });

    it('falls back to the window parameter when session.metadata.window is not numeric', () => {
      const seg0 = segment({ id: 's0', index: 0, sections: [section({ key: 'a', content: 'x'.repeat(50) })] });
      const analytics = computeAnalytics(compileTrace(EMPTY_SUMMARY, [seg0]), 40);
      expect(analytics.window).toBe(40);
      expect(analytics.perSegment[0]!.overWindow).toBe(true);
    });

    it('prefers session.metadata.window over the function parameter when both are present', () => {
      const summary = { ...EMPTY_SUMMARY, metadata: { window: 200 } };
      const seg0 = segment({ id: 's0', index: 0, sections: [section({ key: 'a', content: 'x'.repeat(50) })] });
      const analytics = computeAnalytics(compileTrace(summary, [seg0]), 40);
      expect(analytics.window).toBe(200);
      expect(analytics.perSegment[0]!.overWindow).toBe(false);
    });

    it('leaves window undefined and overWindow false when no window is known at all', () => {
      const seg0 = segment({ id: 's0', index: 0, sections: [section({ key: 'a', content: 'x'.repeat(999) })] });
      const analytics = computeAnalytics(compileTrace(EMPTY_SUMMARY, [seg0]));
      expect(analytics.window).toBeUndefined();
      expect(analytics.perSegment[0]!.overWindow).toBe(false);
    });
  });

  describe('thrash', () => {
    it('flags a removal/re-add at gap=5 but not at gap=6', () => {
      // presence [0, 6]: removedAt=1, readdedAt=6, gap=5 -> flagged
      const withGap5: TraceSourceSegment[] = [segment({ id: 'a0', index: 0, sections: [section({ key: 'k', content: 'v1' })] })];
      for (let i = 1; i < 6; i++) withGap5.push(segment({ id: `a${i}`, index: i, sections: [] }));
      withGap5.push(segment({ id: 'a6', index: 6, sections: [section({ key: 'k', content: 'v1' })] }));
      const analyticsGap5 = computeAnalytics(compileTrace(EMPTY_SUMMARY, withGap5));
      expect(analyticsGap5.thrash).toEqual([{ key: 'k', service: 'svc', removedAt: 1, readdedAt: 6, gap: 5 }]);
      expect(analyticsGap5.findings.filter((f) => f.kind === 'thrash')).toHaveLength(1);
      expect(analyticsGap5.findings.find((f) => f.kind === 'thrash')!.severity).toBe('warning');

      // presence [0, 7]: removedAt=1, readdedAt=7, gap=6 -> not flagged
      const withGap6: TraceSourceSegment[] = [segment({ id: 'b0', index: 0, sections: [section({ key: 'k', content: 'v1' })] })];
      for (let i = 1; i < 7; i++) withGap6.push(segment({ id: `b${i}`, index: i, sections: [] }));
      withGap6.push(segment({ id: 'b7', index: 7, sections: [section({ key: 'k', content: 'v1' })] }));
      const analyticsGap6 = computeAnalytics(compileTrace(EMPTY_SUMMARY, withGap6));
      expect(analyticsGap6.thrash).toEqual([]);
      expect(analyticsGap6.findings.some((f) => f.kind === 'thrash')).toBe(false);
    });
  });

  describe('dead-weight', () => {
    it('flags only when presence>=10, 0 changes, and tokens>=200 all hold', () => {
      const build = (presence: number, tokens: number) =>
        compileTrace(
          EMPTY_SUMMARY,
          Array.from({ length: presence }, (_, i) => segment({ id: `x${i}`, index: i, sections: [section({ key: 'k', content: 'v', tokens })] }))
        );

      expect(computeAnalytics(build(10, 200)).deadWeight).toEqual([{ key: 'k', service: 'svc', carriedSegments: 10, tokens: 200 }]);
      expect(computeAnalytics(build(9, 200)).deadWeight).toEqual([]); // presence below threshold
      expect(computeAnalytics(build(10, 199)).deadWeight).toEqual([]); // tokens below threshold
    });

    it('does not flag a key that changed even once, regardless of presence/tokens', () => {
      const segs = Array.from({ length: 10 }, (_, i) =>
        segment({ id: `y${i}`, index: i, sections: [section({ key: 'k', content: i === 9 ? 'changed' : 'v', tokens: 200 })] })
      );
      expect(computeAnalytics(compileTrace(EMPTY_SUMMARY, segs)).deadWeight).toEqual([]);
    });
  });

  describe('churn', () => {
    it('flags at presence=4 with a 0.5 churn rate (2 changes) but not at 0.25 (1 change)', () => {
      const highChurn = [
        segment({ id: 'c0', index: 0, sections: [section({ key: 'k', content: 'v1' })] }),
        segment({ id: 'c1', index: 1, sections: [section({ key: 'k', content: 'v2' })] }),
        segment({ id: 'c2', index: 2, sections: [section({ key: 'k', content: 'v2' })] }),
        segment({ id: 'c3', index: 3, sections: [section({ key: 'k', content: 'v3' })] }),
      ];
      const highAnalytics = computeAnalytics(compileTrace(EMPTY_SUMMARY, highChurn));
      expect(highAnalytics.churn).toEqual([{ key: 'k', service: 'svc', presence: 4, changes: 2, churnRate: 0.5 }]);
      expect(highAnalytics.findings.find((f) => f.kind === 'churn')?.severity).toBe('notice');

      const lowChurn = [
        segment({ id: 'd0', index: 0, sections: [section({ key: 'k', content: 'v1' })] }),
        segment({ id: 'd1', index: 1, sections: [section({ key: 'k', content: 'v1' })] }),
        segment({ id: 'd2', index: 2, sections: [section({ key: 'k', content: 'v1' })] }),
        segment({ id: 'd3', index: 3, sections: [section({ key: 'k', content: 'v2' })] }),
      ];
      expect(computeAnalytics(compileTrace(EMPTY_SUMMARY, lowChurn)).churn).toEqual([]);
    });

    it('does not flag a high churn rate when presence is below 4', () => {
      const segs = [
        segment({ id: 'e0', index: 0, sections: [section({ key: 'k', content: 'v1' })] }),
        segment({ id: 'e1', index: 1, sections: [section({ key: 'k', content: 'v2' })] }),
        segment({ id: 'e2', index: 2, sections: [section({ key: 'k', content: 'v3' })] }),
      ];
      expect(computeAnalytics(compileTrace(EMPTY_SUMMARY, segs)).churn).toEqual([]);
    });
  });

  it('computes carry-ratio math (per-segment and session-level) on a known 3-segment fixture', () => {
    const seg0 = segment({
      id: 'g0',
      index: 0,
      sections: [section({ key: 'a', content: 'A0', tokens: 10 }), section({ key: 'b', content: 'B0', tokens: 5 })],
    });
    const seg1 = segment({
      id: 'g1',
      index: 1,
      sections: [
        section({ key: 'a', content: 'A0', tokens: 10 }), // carried
        section({ key: 'b', content: 'B1', tokens: 7 }), // changed
        section({ key: 'c', content: 'C0', tokens: 3 }), // added
      ],
    });
    const seg2 = segment({
      id: 'g2',
      index: 2,
      sections: [
        section({ key: 'a', content: 'A0', tokens: 10 }), // carried
        section({ key: 'b', content: 'B1', tokens: 7 }), // carried
        // 'c' dropped -> removed, tokens 3
      ],
    });

    const analytics = computeAnalytics(compileTrace(EMPTY_SUMMARY, [seg0, seg1, seg2]));

    expect(analytics.perSegment[0]).toMatchObject({
      index: 0,
      totalTokens: 15,
      addedTokens: 15,
      changedTokens: 0,
      carriedTokens: 0,
      removedTokens: 0,
      carryRatio: 0,
    });
    expect(analytics.perSegment[1]).toMatchObject({
      index: 1,
      totalTokens: 20,
      addedTokens: 3,
      changedTokens: 7,
      carriedTokens: 10,
      removedTokens: 0,
      carryRatio: 0.5,
    });
    expect(analytics.perSegment[2]).toMatchObject({
      index: 2,
      totalTokens: 17,
      addedTokens: 0,
      changedTokens: 0,
      carriedTokens: 17,
      removedTokens: 3,
      carryRatio: 1,
    });

    // Session-level: Σcarried / Σtotal over segments with index > first: (10 + 17) / (20 + 17)
    expect(analytics.carryRatio).toBeCloseTo(27 / 37, 10);
  });

  describe('outcomes', () => {
    it('aggregates avgLatencyMs and per-key scoreAverages across segments that have an outcome', () => {
      const seg0 = segment({
        id: 'h0',
        index: 0,
        sections: [section({ key: 'a', content: 'x' })],
        outcome: { latencyMs: 1000, scores: { helpfulness: 0.8 } },
      });
      const seg1 = segment({
        id: 'h1',
        index: 1,
        sections: [section({ key: 'a', content: 'x' })],
        outcome: { latencyMs: 2000, scores: { helpfulness: 0.6, accuracy: 0.9 } },
      });
      const analytics = computeAnalytics(compileTrace(EMPTY_SUMMARY, [seg0, seg1]));

      expect(analytics.outcomes?.avgLatencyMs).toBe(1500);
      expect(analytics.outcomes?.scoreAverages?.helpfulness).toBeCloseTo(0.7, 10);
      expect(analytics.outcomes?.scoreAverages?.accuracy).toBe(0.9);
      expect(analytics.perSegment[0]!.latencyMs).toBe(1000);
      expect(analytics.perSegment[1]!.latencyMs).toBe(2000);
    });

    it('omits outcomes entirely when no segment has one', () => {
      const seg0 = segment({ id: 'i0', index: 0, sections: [section({ key: 'a', content: 'x' })] });
      const analytics = computeAnalytics(compileTrace(EMPTY_SUMMARY, [seg0]));
      expect(analytics.outcomes).toBeUndefined();
      expect(analytics.perSegment[0]!.latencyMs).toBeUndefined();
    });
  });

  it('sorts findings warnings-first: over-window and thrash before churn and dead-weight', () => {
    const segs: TraceSourceSegment[] = [];
    for (let i = 0; i < 12; i++) {
      const sections: Section[] = [section({ key: 'big', content: 'BIG', tokens: 250 })]; // dead-weight candidate
      if (i <= 3) sections.push(section({ key: 'churner', content: `c${i}`, tokens: 5 })); // churn candidate
      if (i === 0 || i === 5) sections.push(section({ key: 'flicker', content: 'f', tokens: 5 })); // thrash candidate
      segs.push(segment({ id: `w${i}`, index: i, sections }));
    }
    const summary = { ...EMPTY_SUMMARY, metadata: { window: 100 } }; // 'big' alone (250) always trips over-window
    const analytics = computeAnalytics(compileTrace(summary, segs));

    expect(analytics.findings.some((f) => f.kind === 'over-window')).toBe(true);
    expect(analytics.findings.some((f) => f.kind === 'thrash')).toBe(true);
    expect(analytics.findings.some((f) => f.kind === 'churn')).toBe(true);
    expect(analytics.findings.some((f) => f.kind === 'dead-weight')).toBe(true);

    const severities = analytics.findings.map((f) => f.severity);
    const lastWarningIdx = severities.lastIndexOf('warning');
    const firstNoticeIdx = severities.indexOf('notice');
    expect(lastWarningIdx).toBeLessThan(firstNoticeIdx);
  });
});
