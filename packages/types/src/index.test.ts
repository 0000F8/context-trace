import { describe, expect, it } from 'vitest';
import { estimateTokens, fnv1a64, generateId } from './index.js';

describe('fnv1a64', () => {
  it('matches known FNV-1a 64 vectors', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });

  it('differs for different content', () => {
    expect(fnv1a64('hello')).not.toBe(fnv1a64('hello '));
  });
});

describe('estimateTokens', () => {
  it('returns 0 for empty', () => {
    expect(estimateTokens('')).toBe(0);
  });
  it('rounds up chars/4', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('generateId', () => {
  it('is sortable by creation time and unique-ish', () => {
    const a = generateId();
    const b = generateId();
    expect(a).toHaveLength(23);
    expect(a).not.toBe(b);
    expect(generateId('ses')).toMatch(/^ses_[0-9a-z]{23}$/);
  });
});
