import { describe, expect, it } from 'vitest';
import { buildDeepLinkSearch, parseDeepLink } from './deep-link';

describe('parseDeepLink', () => {
  it('parses a valid segment and section', () => {
    expect(parseDeepLink('?segment=3&section=mem:profile')).toEqual({ segment: 3, section: 'mem:profile' });
  });

  it('returns nulls when params are absent', () => {
    expect(parseDeepLink('')).toEqual({ segment: null, section: null });
  });

  it('ignores a negative segment', () => {
    expect(parseDeepLink('?segment=-1')).toEqual({ segment: null, section: null });
  });

  it('ignores a non-numeric segment', () => {
    expect(parseDeepLink('?segment=abc')).toEqual({ segment: null, section: null });
  });

  it('ignores a decimal segment', () => {
    expect(parseDeepLink('?segment=1.5')).toEqual({ segment: null, section: null });
  });

  it('ignores an empty section', () => {
    expect(parseDeepLink('?segment=0&section=')).toEqual({ segment: 0, section: null });
  });

  it('accepts segment 0', () => {
    expect(parseDeepLink('?segment=0')).toEqual({ segment: 0, section: null });
  });
});

describe('buildDeepLinkSearch', () => {
  it('sets both params from empty', () => {
    expect(buildDeepLinkSearch('', { segment: 2, section: 'k' })).toBe('?segment=2&section=k');
  });

  it('clears both params when null', () => {
    expect(buildDeepLinkSearch('?segment=2&section=k', { segment: null, section: null })).toBe('');
  });

  it('preserves unrelated existing params', () => {
    expect(buildDeepLinkSearch('?foo=bar', { segment: 1, section: null })).toBe('?foo=bar&segment=1');
  });

  it('updates an existing segment value', () => {
    expect(buildDeepLinkSearch('?segment=1', { segment: 5, section: null })).toBe('?segment=5');
  });
});
