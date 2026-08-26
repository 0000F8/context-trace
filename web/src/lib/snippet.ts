/**
 * Parses an FTS5 `snippet()` result into alternating plain/matched runs. The
 * server wraps matches in literal `[` / `]` (spec2 §G1); this is pure string
 * splitting so it's unit-testable without a real search backend.
 */
export interface SnippetPart {
  text: string;
  match: boolean;
}

export function parseSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  const re = /\[([^\]]*)\]/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet)) !== null) {
    if (m.index > lastIndex) parts.push({ text: snippet.slice(lastIndex, m.index), match: false });
    parts.push({ text: m[1]!, match: true });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < snippet.length) parts.push({ text: snippet.slice(lastIndex), match: false });
  return parts;
}
