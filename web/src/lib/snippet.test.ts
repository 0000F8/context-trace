import { describe, expect, it } from 'vitest';
import { parseSnippet } from './snippet';

const OPEN = String.fromCharCode(1);
const CLOSE = String.fromCharCode(2);

describe('parseSnippet', () => {
  it('splits a snippet with one match into plain/match/plain runs', () => {
    expect(parseSnippet('the ' + OPEN + 'quick' + CLOSE + ' fox')).toEqual([
      { text: 'the ', match: false },
      { text: 'quick', match: true },
      { text: ' fox', match: false },
    ]);
  });

  it('handles multiple matches', () => {
    expect(parseSnippet(OPEN + 'foo' + CLOSE + ' and ' + OPEN + 'bar' + CLOSE)).toEqual([
      { text: 'foo', match: true },
      { text: ' and ', match: false },
      { text: 'bar', match: true },
    ]);
  });

  it('handles no matches at all', () => {
    expect(parseSnippet('plain text')).toEqual([{ text: 'plain text', match: false }]);
  });

  it('handles a match at the very start or end', () => {
    expect(parseSnippet(OPEN + 'start' + CLOSE + ' then end')).toEqual([
      { text: 'start', match: true },
      { text: ' then end', match: false },
    ]);
    expect(parseSnippet('start then ' + OPEN + 'end' + CLOSE)).toEqual([
      { text: 'start then ', match: false },
      { text: 'end', match: true },
    ]);
  });

  it('handles an empty string', () => {
    expect(parseSnippet('')).toEqual([]);
  });

  it('strips a stray open marker planted in unmatched content', () => {
    expect(parseSnippet('before ' + OPEN + 'after')).toEqual([{ text: 'before after', match: false }]);
  });

  it('strips a stray close marker planted in unmatched content', () => {
    expect(parseSnippet('before ' + CLOSE + 'after')).toEqual([{ text: 'before after', match: false }]);
  });

  it('does not let stray markers outside a pair fake a match', () => {
    // A lone OPEN with no matching CLOSE anywhere must not swallow the rest
    // of the string into a fake "match" run.
    expect(parseSnippet('plain ' + OPEN + ' still plain')).toEqual([{ text: 'plain  still plain', match: false }]);
  });

  it('strips a stray marker that ends up inside a real match run', () => {
    expect(parseSnippet(OPEN + 'foo' + CLOSE + 'bar' + CLOSE + 'baz')).toEqual([
      { text: 'foo', match: true },
      { text: 'barbaz', match: false },
    ]);
  });
});
