import { describe, expect, it } from 'vitest';
import {
  alignStrata,
  buildHeadlineMetrics,
  formatDeltaNumber,
  formatDeltaPercent,
  formatMetricDelta,
  formatMetricValue,
  judgeDelta,
  unionServiceShareRows,
} from './compare';

describe('judgeDelta', () => {
  it('is neutral for a zero delta regardless of direction', () => {
    expect(judgeDelta(0, 'lower-better')).toBe('neutral');
    expect(judgeDelta(0, 'higher-better')).toBe('neutral');
  });

  it('treats a decrease as good when lower is better', () => {
    expect(judgeDelta(-5, 'lower-better')).toBe('good');
    expect(judgeDelta(5, 'lower-better')).toBe('bad');
  });

  it('treats an increase as good when higher is better', () => {
    expect(judgeDelta(5, 'higher-better')).toBe('good');
    expect(judgeDelta(-5, 'higher-better')).toBe('bad');
  });

  it('is always neutral for the neutral direction', () => {
    expect(judgeDelta(100, 'neutral')).toBe('neutral');
    expect(judgeDelta(-100, 'neutral')).toBe('neutral');
  });
});

describe('buildHeadlineMetrics', () => {
  const base = { segmentCount: 10, peakTokens: 2000, totalTokens: 1500, carryRatio: 0.4 };

  it('marks segments as neutral even when the count changes', () => {
    const metrics = buildHeadlineMetrics(base, { ...base, segmentCount: 20 });
    const segments = metrics.find((m) => m.label === 'Segments')!;
    expect(segments.delta).toBe(10);
    expect(segments.judgment).toBe('neutral');
  });

  it('marks fewer tokens in B as good (lower is better)', () => {
    const metrics = buildHeadlineMetrics(base, { ...base, peakTokens: 1000, totalTokens: 900 });
    expect(metrics.find((m) => m.label === 'Peak tokens')!.judgment).toBe('good');
    expect(metrics.find((m) => m.label === 'Latest tokens')!.judgment).toBe('good');
  });

  it('marks more tokens in B as bad', () => {
    const metrics = buildHeadlineMetrics(base, { ...base, peakTokens: 3000 });
    expect(metrics.find((m) => m.label === 'Peak tokens')!.judgment).toBe('bad');
  });

  it('expresses carry ratio as a percentage (0..1 -> 0..100)', () => {
    const metrics = buildHeadlineMetrics(base, { ...base, carryRatio: 0.6 });
    const carry = metrics.find((m) => m.label === 'Carry ratio')!;
    expect(carry.a).toBeCloseTo(40);
    expect(carry.b).toBeCloseTo(60);
    expect(carry.judgment).toBe('bad');
  });

  it('omits avg latency entirely when neither side recorded outcomes', () => {
    const metrics = buildHeadlineMetrics(base, base);
    expect(metrics.find((m) => m.label === 'Avg latency')).toBeUndefined();
  });

  it('includes avg latency when only one side has it, with an undefined delta', () => {
    const metrics = buildHeadlineMetrics(base, { ...base, avgLatencyMs: 1200 });
    const latency = metrics.find((m) => m.label === 'Avg latency')!;
    expect(latency).toBeDefined();
    expect(latency.a).toBeUndefined();
    expect(latency.b).toBe(1200);
    expect(latency.delta).toBeUndefined();
    expect(latency.judgment).toBe('neutral');
  });

  it('marks lower latency in B as good', () => {
    const metrics = buildHeadlineMetrics({ ...base, avgLatencyMs: 2000 }, { ...base, avgLatencyMs: 1000 });
    expect(metrics.find((m) => m.label === 'Avg latency')!.judgment).toBe('good');
  });
});

describe('formatDeltaNumber', () => {
  it('formats zero as a plus-minus sign', () => {
    expect(formatDeltaNumber(0)).toBe('±0');
  });

  it('prefixes a plus sign for positive deltas', () => {
    expect(formatDeltaNumber(120)).toBe('+120');
  });

  it('lets the negative sign come from the numeral itself', () => {
    expect(formatDeltaNumber(-45)).toBe('-45');
  });

  it('rounds fractional deltas', () => {
    expect(formatDeltaNumber(2.6)).toBe('+3');
  });
});

describe('formatDeltaPercent', () => {
  it('formats zero with a plus-minus sign and "pp" suffix', () => {
    expect(formatDeltaPercent(0)).toBe('±0.0pp');
  });

  it('prefixes a plus sign for positive point deltas', () => {
    expect(formatDeltaPercent(4.25)).toBe('+4.3pp');
  });

  it('keeps the negative sign for negative point deltas', () => {
    expect(formatDeltaPercent(-1)).toBe('-1.0pp');
  });
});

describe('formatMetricValue / formatMetricDelta', () => {
  it('renders an em dash for a missing value or delta', () => {
    expect(formatMetricValue(undefined, 'tokens')).toBe('—');
    expect(formatMetricDelta(undefined, 'tokens')).toBe('—');
  });

  it('formats percent values with one decimal and a % suffix', () => {
    expect(formatMetricValue(42.36, 'percent')).toBe('42.4%');
  });

  it('formats ms values and deltas with an "ms" suffix', () => {
    expect(formatMetricValue(1234, 'ms')).toBe('1,234 ms');
    expect(formatMetricDelta(-300, 'ms')).toBe('-300 ms');
  });

  it('formats percent deltas via formatDeltaPercent', () => {
    expect(formatMetricDelta(2, 'percent')).toBe('+2.0pp');
  });
});

describe('unionServiceShareRows', () => {
  it('computes each service share as a fraction of that session\'s total tokens', () => {
    const rows = unionServiceShareRows(
      [
        { name: 'memory', totalTokens: 300 },
        { name: 'retrieval', totalTokens: 100 },
      ],
      [
        { name: 'memory', totalTokens: 200 },
        { name: 'retrieval', totalTokens: 200 },
      ],
    );
    const memory = rows.find((r) => r.name === 'memory')!;
    expect(memory.shareA).toBeCloseTo(0.75);
    expect(memory.shareB).toBeCloseTo(0.5);
    expect(memory.deltaPoints).toBeCloseTo(-25);
  });

  it('treats a service missing from one side as a zero share there', () => {
    const rows = unionServiceShareRows([{ name: 'memory', totalTokens: 100 }], [{ name: 'tools', totalTokens: 50 }]);
    const memory = rows.find((r) => r.name === 'memory')!;
    const tools = rows.find((r) => r.name === 'tools')!;
    expect(memory.shareA).toBe(1);
    expect(memory.shareB).toBe(0);
    expect(tools.shareA).toBe(0);
    expect(tools.shareB).toBe(1);
  });

  it('handles both sides empty without dividing by zero', () => {
    expect(unionServiceShareRows([], [])).toEqual([]);
  });

  it('sorts by the larger of the two shares, descending', () => {
    const rows = unionServiceShareRows(
      [
        { name: 'small', totalTokens: 10 },
        { name: 'big', totalTokens: 90 },
      ],
      [],
    );
    expect(rows.map((r) => r.name)).toEqual(['big', 'small']);
  });
});

describe('alignStrata', () => {
  function span(key: string, service: string, presence: number[], versions: number) {
    return { key, service, presence, versions };
  }

  it('unions keys from both sides and groups by service', () => {
    const groups = alignStrata(
      [span('mem:profile', 'memory', [0, 1], 1), span('r:doc0', 'retrieval', [0], 1)],
      [span('mem:profile', 'memory', [0, 1, 2], 2)],
    );
    expect(groups.map((g) => g.service)).toEqual(['memory', 'retrieval']);
    const memoryRow = groups.find((g) => g.service === 'memory')!.rows[0]!;
    expect(memoryRow.presenceA).toBe(2);
    expect(memoryRow.versionsA).toBe(1);
    expect(memoryRow.presenceB).toBe(3);
    expect(memoryRow.versionsB).toBe(2);
  });

  it('renders a key present only in A with nulls on the B side', () => {
    const groups = alignStrata([span('only-a', 'memory', [0], 1)], []);
    const row = groups[0]!.rows[0]!;
    expect(row.presenceA).toBe(1);
    expect(row.versionsA).toBe(1);
    expect(row.presenceB).toBeNull();
    expect(row.versionsB).toBeNull();
  });

  it('renders a key present only in B with nulls on the A side', () => {
    const groups = alignStrata([], [span('only-b', 'tools', [3], 1)]);
    const row = groups[0]!.rows[0]!;
    expect(row.presenceA).toBeNull();
    expect(row.versionsA).toBeNull();
    expect(row.presenceB).toBe(1);
  });

  it('sorts rows within a group by key', () => {
    const groups = alignStrata(
      [span('mem:zebra', 'memory', [0], 1), span('mem:alpha', 'memory', [0], 1)],
      [],
    );
    expect(groups[0]!.rows.map((r) => r.key)).toEqual(['mem:alpha', 'mem:zebra']);
  });

  it('returns no groups when both sides are empty', () => {
    expect(alignStrata([], [])).toEqual([]);
  });
});
