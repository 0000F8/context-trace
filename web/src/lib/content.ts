/** Shown wherever a section's body would render but wasn't captured (hash-only content mode). */
export const HASH_ONLY_PLACEHOLDER = 'Content not captured (hash-only mode)';

/**
 * True when `content` was actually shipped by the SDK, as opposed to
 * hash-only capture (spec3 §D), where `content` is omitted from the wire
 * payload and only `contentHash`/`tokens` travel. An empty string still
 * counts as captured — it's `undefined`/`null` that means "not sent".
 */
export function hasContent(content: string | null | undefined): content is string {
  return content != null;
}

/** True when a changed section can be diffed — both sides need real content. */
export function canDiff(prev: string | null | undefined, next: string | null | undefined): boolean {
  return hasContent(prev) && hasContent(next);
}
