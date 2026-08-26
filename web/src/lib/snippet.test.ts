import { describe, expect, it } from 'vitest';
import { parseSnippet } from './snippet';

describe('parseSnippet', () => {
  it('splits a snippet with one match into plain/match/plain runs', () => {
    expect(parseSnippet('the [quick] fox')).toEqual([
      { text: 'the ', match: false },
      { text: 'quick', match: true },
      { text: ' fox', match: false },
    ]);
  });

  it('handles multiple matches', () => {
    expect(parseSnippet('[foo] and [bar]')).toEqual([
      { text: 'foo', match: true },
      { text: ' and ', match: false },
      { text: 'bar', match: true },
    ]);
  });

  it('handles no matches at all', () => {
    expect(parseSnippet('plain text')).toEqual([{ text: 'plain text', match: false }]);
  });

  it('handles a match at the very start or end', () => {
    expect(parseSnippet('[start] then end')).toEqual([
      { text: 'start', match: true },
      { text: ' then end', match: false },
    ]);
    expect(parseSnippet('start then [end]')).toEqual([
      { text: 'start then ', match: false },
      { text: 'end', match: true },
    ]);
  });

  it('handles an empty string', () => {
    expect(parseSnippet('')).toEqual([]);
  });
});
