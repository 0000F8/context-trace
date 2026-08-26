import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_TRANSCRIPT_CHARS, buildSections, parseTranscript } from '../lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixture-transcript.jsonl'), 'utf8');

describe('parseTranscript', () => {
  it('extracts messages, the latest user/assistant text, and the latest tool result by name', () => {
    const parsed = parseTranscript(fixture);

    expect(parsed.messages).toHaveLength(4);
    expect(parsed.lastUser).toBe("What's the weather in Paris right now?");
    expect(parsed.lastAssistant).toBe("It's sunny and 22°C in Paris right now.");
    expect(parsed.lastToolResult).toEqual({ name: 'get_weather', text: 'Sunny, 22C' });
  });

  it('tolerates blank lines and an unparsable trailing line', () => {
    const withNoise = `${fixture}\n\n  \nnot valid json{{{`;
    const parsed = parseTranscript(withNoise);
    expect(parsed.messages).toHaveLength(4);
  });

  it('returns undefined pointers for an empty transcript', () => {
    const parsed = parseTranscript('');
    expect(parsed.messages).toEqual([]);
    expect(parsed.lastUser).toBeUndefined();
    expect(parsed.lastAssistant).toBeUndefined();
    expect(parsed.lastToolResult).toBeUndefined();
  });
});

describe('buildSections', () => {
  it('produces hist:transcript, user:latest, assistant:latest, and tool:<name>, in that order', () => {
    const parsed = parseTranscript(fixture);
    const sections = buildSections(parsed);

    expect(sections.map((s) => [s.key, s.position, s.service, s.serviceKind, s.role])).toEqual([
      ['hist:transcript', 0, 'claude-code', 'history', undefined],
      ['user:latest', 1, 'claude-code', 'user', 'user'],
      ['assistant:latest', 2, 'claude-code', 'other', 'assistant'],
      ['tool:get_weather', 3, 'claude-code', 'tool', 'tool'],
    ]);

    const transcriptSection = sections[0];
    expect(transcriptSection.content).toContain('[user]');
    expect(transcriptSection.content).toContain('[assistant]');
    expect(transcriptSection.content).toContain("It's sunny and 22°C in Paris right now.");
    expect(typeof transcriptSection.contentHash).toBe('string');
    expect(transcriptSection.contentHash).toHaveLength(16);
    expect(transcriptSection.tokens).toBeGreaterThan(0);

    const userSection = sections.find((s) => s.key === 'user:latest');
    expect(userSection.content).toBe("What's the weather in Paris right now?");

    const assistantSection = sections.find((s) => s.key === 'assistant:latest');
    expect(assistantSection.content).toBe("It's sunny and 22°C in Paris right now.");

    const toolSection = sections.find((s) => s.key === 'tool:get_weather');
    expect(toolSection.content).toBe('Sunny, 22C');
  });

  it('omits user:latest/assistant:latest/tool:<name> sections when the transcript has none of them', () => {
    const parsed = { messages: [], lastUser: undefined, lastAssistant: undefined, lastToolResult: undefined };
    const sections = buildSections(parsed);
    expect(sections.map((s) => s.key)).toEqual(['hist:transcript']);
  });

  it('caps hist:transcript at MAX_TRANSCRIPT_CHARS', () => {
    const hugeText = 'x'.repeat(MAX_TRANSCRIPT_CHARS + 50_000);
    const parsed = {
      messages: [{ role: 'user', content: hugeText }],
      lastUser: hugeText,
      lastAssistant: undefined,
      lastToolResult: undefined,
    };
    const sections = buildSections(parsed);
    const transcriptSection = sections.find((s) => s.key === 'hist:transcript');
    expect(transcriptSection.content.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
  });
});
