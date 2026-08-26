import { describe, expect, it } from 'vitest';
import { buildPromptMarkdown, buildPromptMessages } from './prompt';
import type { AnnotatedSection, SegmentDetail } from '@context-trace/types';

function section(overrides: Partial<AnnotatedSection>): AnnotatedSection {
  return {
    key: 'k',
    service: 'memory',
    serviceKind: 'memory',
    position: 0,
    contentHash: 'h',
    tokens: 1,
    state: 'added',
    ...overrides,
  };
}

function detail(sections: AnnotatedSection[]): SegmentDetail {
  return {
    segment: {
      id: 's0',
      index: 0,
      kind: 'llm_call',
      timestamp: '2026-01-01T00:00:00Z',
      totalTokens: 0,
      sectionCount: sections.length,
      delta: { added: 0, removed: 0, changed: 0, carried: 0 },
    },
    sections,
    removed: [],
  };
}

describe('buildPromptMarkdown', () => {
  it('orders blocks by position and formats the header', () => {
    const d = detail([
      section({ key: 'b', service: 'retrieval', position: 1, content: 'second' }),
      section({ key: 'a', service: 'memory', position: 0, content: 'first' }),
    ]);
    expect(buildPromptMarkdown(d)).toBe('## a (memory)\n\nfirst\n\n## b (retrieval)\n\nsecond');
  });

  it('falls back to empty content', () => {
    const d = detail([section({ key: 'a', content: undefined })]);
    expect(buildPromptMarkdown(d)).toBe('## a (memory)\n\n');
  });
});

describe('buildPromptMessages', () => {
  it('maps sections to role/name/content in position order, defaulting role to user', () => {
    const d = detail([
      section({ key: 'sys', role: 'system', position: 0, content: 'be nice' }),
      section({ key: 'q', position: 1, content: 'hello' }),
    ]);
    expect(buildPromptMessages(d)).toEqual([
      { role: 'system', name: 'sys', content: 'be nice' },
      { role: 'user', name: 'q', content: 'hello' },
    ]);
  });

  it('falls back to empty content', () => {
    const d = detail([section({ key: 'a', content: undefined })]);
    expect(buildPromptMessages(d)).toEqual([{ role: 'user', name: 'a', content: '' }]);
  });
});
