import { describe, expect, it } from 'vitest';
import { formatCompactTokens, formatLatency, formatPercent } from './format';

describe('formatCompactTokens', () => {
  it('leaves sub-thousand values as whole numbers', () => {
    expect(formatCompactTokens(0)).toBe('0');
    expect(formatCompactTokens(400)).toBe('400');
    expect(formatCompactTokens(999.6)).toBe('1000');
  });

  it('formats thousands with one decimal below 10k', () => {
    expect(formatCompactTokens(8192)).toBe('8.2k');
    expect(formatCompactTokens(1000)).toBe('1k');
  });

  it('rounds to whole thousands at or above 10k', () => {
    expect(formatCompactTokens(180000)).toBe('180k');
    expect(formatCompactTokens(12400)).toBe('12k');
  });
});

describe('formatPercent', () => {
  it('rounds a 0..1 ratio to a whole-number percentage', () => {
    expect(formatPercent(0.624)).toBe('62%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(1)).toBe('100%');
  });

  it('rounds .5 up', () => {
    expect(formatPercent(0.005)).toBe('1%');
  });
});

describe('formatLatency', () => {
  it('formats milliseconds as seconds with one decimal', () => {
    expect(formatLatency(1400)).toBe('1.4s');
    expect(formatLatency(800)).toBe('0.8s');
    expect(formatLatency(0)).toBe('0.0s');
  });
});
