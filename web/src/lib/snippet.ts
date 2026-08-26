/**
 * Parses an FTS5 `snippet()` result into alternating plain/matched runs. The
 * server wraps matches in U+0001 (open) / U+0002 (close) control characters
 * rather than printable brackets (spec2 section G1) so attacker-controlled
 * section content can't inject its own bracket characters to spoof or break
 * match highlighting. Built via String.fromCharCode rather than \u escapes
 * so the marker bytes never sit literally in this source file.
 * Pure string splitting so it's unit-testable without a real search backend.
 */
export interface SnippetPart {
  text: string;
  match: boolean;
}

const OPEN = String.fromCharCode(1);
const CLOSE = String.fromCharCode(2);
const MATCH_RE = new RegExp(OPEN + '([^' + CLOSE + ']*)' + CLOSE, 'g');
const STRAY_MARKER_RE = new RegExp('[' + OPEN + CLOSE + ']', 'g');

/** Strips any marker character that survived outside (or inside) a well-formed pair -- e.g. one planted by an attacker in section content. */
function stripStrayMarkers(text: string): string {
  return text.replace(STRAY_MARKER_RE, '');
}

export function parseSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MATCH_RE.exec(snippet)) !== null) {
    if (m.index > lastIndex) parts.push({ text: stripStrayMarkers(snippet.slice(lastIndex, m.index)), match: false });
    parts.push({ text: stripStrayMarkers(m[1]!), match: true });
    lastIndex = MATCH_RE.lastIndex;
  }
  if (lastIndex < snippet.length) parts.push({ text: stripStrayMarkers(snippet.slice(lastIndex)), match: false });
  return parts;
}
