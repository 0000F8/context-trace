import type { SegmentDetail } from '@context-trace/types';

/**
 * "Copy as prompt" helpers (spec2.md section D). Pure functions over an
 * already-loaded SegmentDetail so they're trivially unit-testable and the
 * Inspector only has to wire them to the clipboard.
 */

/** `## <key> (<service>)` blocks, one per section, in position order. */
export function buildPromptMarkdown(detail: SegmentDetail): string {
  const ordered = [...detail.sections].sort((a, b) => a.position - b.position);
  return ordered.map((s) => `## ${s.key} (${s.service})\n\n${s.content ?? ''}`).join('\n\n');
}

export interface PromptMessage {
  role: string;
  name: string;
  content: string;
}

/** `[{ role: role ?? 'user', name: key, content }]`, in position order. */
export function buildPromptMessages(detail: SegmentDetail): PromptMessage[] {
  const ordered = [...detail.sections].sort((a, b) => a.position - b.position);
  return ordered.map((s) => ({ role: s.role ?? 'user', name: s.key, content: s.content ?? '' }));
}
