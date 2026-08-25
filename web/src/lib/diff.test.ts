import { describe, expect, it } from 'vitest';
import { diffLines } from './diff';

describe('diffLines', () => {
  it('returns all equal lines for identical content', () => {
    const result = diffLines('a\nb\nc', 'a\nb\nc');
    expect(result).toEqual([
      { type: 'equal', text: 'a' },
      { type: 'equal', text: 'b' },
      { type: 'equal', text: 'c' },
    ]);
  });

  it('detects a pure addition', () => {
    const result = diffLines('a\nb', 'a\nb\nc');
    expect(result).toEqual([
      { type: 'equal', text: 'a' },
      { type: 'equal', text: 'b' },
      { type: 'add', text: 'c' },
    ]);
  });

  it('detects a pure removal', () => {
    const result = diffLines('a\nb\nc', 'a\nb');
    expect(result).toEqual([
      { type: 'equal', text: 'a' },
      { type: 'equal', text: 'b' },
      { type: 'remove', text: 'c' },
    ]);
  });

  it('detects a change in the middle as remove+add', () => {
    const result = diffLines('a\nb\nc', 'a\nx\nc');
    expect(result).toEqual([
      { type: 'equal', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'add', text: 'x' },
      { type: 'equal', text: 'c' },
    ]);
  });

  it('handles both sides empty', () => {
    expect(diffLines('', '')).toEqual([]);
  });

  it('handles one side empty (all lines added)', () => {
    const result = diffLines('', 'a\nb');
    expect(result).toEqual([
      { type: 'add', text: 'a' },
      { type: 'add', text: 'b' },
    ]);
  });

  it('handles one side empty (all lines removed)', () => {
    const result = diffLines('a\nb', '');
    expect(result).toEqual([
      { type: 'remove', text: 'a' },
      { type: 'remove', text: 'b' },
    ]);
  });

  it('handles a single-line change', () => {
    const result = diffLines('hello', 'goodbye');
    expect(result).toEqual([
      { type: 'remove', text: 'hello' },
      { type: 'add', text: 'goodbye' },
    ]);
  });
});
