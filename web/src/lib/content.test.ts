import { describe, expect, it } from 'vitest';
import { canDiff, hasContent } from './content';

describe('hasContent', () => {
  it('is true for a real string, including an empty one', () => {
    expect(hasContent('hello')).toBe(true);
    expect(hasContent('')).toBe(true);
  });

  it('is false for undefined or null (hash-only, not captured)', () => {
    expect(hasContent(undefined)).toBe(false);
    expect(hasContent(null)).toBe(false);
  });
});

describe('canDiff', () => {
  it('is true only when both sides have content', () => {
    expect(canDiff('a', 'b')).toBe(true);
    expect(canDiff('', '')).toBe(true);
  });

  it('is false when either side is hash-only', () => {
    expect(canDiff(undefined, 'b')).toBe(false);
    expect(canDiff('a', undefined)).toBe(false);
    expect(canDiff(undefined, undefined)).toBe(false);
  });
});
