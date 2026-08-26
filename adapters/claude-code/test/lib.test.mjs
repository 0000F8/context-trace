import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MAX_TRANSCRIPT_CHARS,
  buildSections,
  looksLikeTranscriptPath,
  parseTranscript,
  sanitizeSessionIdForFilename,
} from '../lib.mjs';

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

  it('keeps the TAIL of an over-cap transcript, not the head, so the section keeps changing as the conversation grows', () => {
    // A conversation only grows, so freezing on the oldest 240k chars would
    // make this section stop changing forever the moment it crosses the cap
    // (every later invocation slices back to the same leading bytes) — which
    // would falsely look like a dead-weight section to the analytics that
    // key off "present, unchanged, for many segments". Keeping the tail
    // instead means the section keeps reflecting the latest turns.
    const oldMarker = 'FIRST-TURN-MARKER';
    const newMarker = 'LATEST-TURN-MARKER';
    const messages = [
      { role: 'user', content: `${oldMarker} ${'a'.repeat(MAX_TRANSCRIPT_CHARS)}` },
      { role: 'assistant', content: `${newMarker} ${'b'.repeat(1000)}` },
    ];
    const parsed = { messages, lastUser: undefined, lastAssistant: undefined, lastToolResult: undefined };
    const sections = buildSections(parsed);
    const transcriptSection = sections.find((s) => s.key === 'hist:transcript');

    expect(transcriptSection.content.length).toBe(MAX_TRANSCRIPT_CHARS);
    expect(transcriptSection.content).toContain(newMarker);
    expect(transcriptSection.content).not.toContain(oldMarker);
  });

  it('caps user:latest, assistant:latest, and tool:<name> too, not just hist:transcript', () => {
    // A single oversized message (a giant tool result, say) must not be able
    // to get the whole segment rejected server-side by the per-section
    // content-size limit — every section this adapter builds needs its own
    // cap, not just the transcript.
    const hugeUser = `U-TAIL-MARKER ${'u'.repeat(MAX_TRANSCRIPT_CHARS)}`;
    const hugeAssistant = `A-TAIL-MARKER ${'a'.repeat(MAX_TRANSCRIPT_CHARS)}`;
    const hugeToolText = `T-TAIL-MARKER ${'t'.repeat(MAX_TRANSCRIPT_CHARS)}`;
    const parsed = {
      messages: [],
      lastUser: hugeUser,
      lastAssistant: hugeAssistant,
      lastToolResult: { name: 'big_tool', text: hugeToolText },
    };

    const sections = buildSections(parsed);
    const byKey = Object.fromEntries(sections.map((s) => [s.key, s]));

    for (const key of ['user:latest', 'assistant:latest', 'tool:big_tool']) {
      expect(byKey[key].content.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
    }
    // Tail-kept, same as hist:transcript: the marker was at the front, so an
    // untruncated (or head-truncated) section would still contain it.
    expect(byKey['user:latest'].content).not.toContain('U-TAIL-MARKER');
    expect(byKey['assistant:latest'].content).not.toContain('A-TAIL-MARKER');
    expect(byKey['tool:big_tool'].content).not.toContain('T-TAIL-MARKER');
  });
});

describe('sanitizeSessionIdForFilename', () => {
  it('passes through an already-safe session id unchanged', () => {
    expect(sanitizeSessionIdForFilename('abc123_session.ID-1')).toBe('abc123_session.ID-1');
  });

  it('falls back to a stable fnv1a64 hash for a session id with path-unsafe characters', () => {
    // A slash (or ../) anywhere must never survive into a path component —
    // this is what stands between an untrusted session_id and a path
    // traversal onto an arbitrary file under the counter dir's parent.
    const malicious = '../../etc/passwd';
    const sanitized = sanitizeSessionIdForFilename(malicious);

    expect(sanitized).not.toContain('/');
    expect(sanitized).not.toContain('.');
    expect(sanitized).toMatch(/^[0-9a-f]{16}$/);
    // Stable: the same unsafe id always maps to the same filename, so the
    // per-session counter still works correctly across hook invocations.
    expect(sanitizeSessionIdForFilename(malicious)).toBe(sanitized);
  });

  it('falls back for other unsafe inputs too (spaces, null bytes, empty string, non-strings)', () => {
    expect(sanitizeSessionIdForFilename('has space')).toMatch(/^[0-9a-f]{16}$/);
    expect(sanitizeSessionIdForFilename('null\0byte')).toMatch(/^[0-9a-f]{16}$/);
    expect(sanitizeSessionIdForFilename('')).toMatch(/^[0-9a-f]{16}$/);
    expect(sanitizeSessionIdForFilename(undefined)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('maps different unsafe inputs to different hashes', () => {
    const a = sanitizeSessionIdForFilename('../a');
    const b = sanitizeSessionIdForFilename('../b');
    expect(a).not.toBe(b);
  });
});

describe('looksLikeTranscriptPath', () => {
  it('accepts a .jsonl path and rejects anything else', () => {
    expect(looksLikeTranscriptPath('/a/b/session.jsonl')).toBe(true);
    expect(looksLikeTranscriptPath('/etc/passwd')).toBe(false);
    expect(looksLikeTranscriptPath('/a/b/session.jsonl.bak')).toBe(false);
    expect(looksLikeTranscriptPath('')).toBe(false);
    expect(looksLikeTranscriptPath(undefined)).toBe(false);
  });
});
