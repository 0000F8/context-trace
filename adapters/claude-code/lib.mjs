/**
 * Pure transcript parsing + section building for the Claude Code adapter.
 * No I/O here on purpose — kept unit-testable without stdin/fs/fetch.
 *
 * Imports the built @context-trace/types package directly by its dist path
 * (rather than as a normal package dependency) so this adapter has zero
 * npm dependencies of its own and needs no build step: it runs as plain
 * Node ESM straight out of the repo, and the only requirement is that
 * `packages/types` has already been built (true after `npm run build` at
 * the repo root, which builds types first).
 */
import { estimateTokens, fnv1a64 } from '../../packages/types/dist/index.js';

/** Hard per-section content cap (applied to every section built here, not just the transcript) — see spec §E2. */
export const MAX_TRANSCRIPT_CHARS = 240_000;

const SAFE_FILENAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Reduces an untrusted `session_id` to something safe to use as a
 * filesystem path component. Claude Code's `session_id` is normally a UUID,
 * but it arrives via a hook payload we don't control — a hand-crafted or
 * corrupted value containing `/`, `..`, or other path metacharacters could
 * otherwise let the counter file/lock escape the counter directory (path
 * traversal) or collide with an unrelated file. Anything that isn't already
 * composed only of safe characters is replaced wholesale (not
 * escaped/stripped) by a stable hash of the original value, so the same
 * unsafe id always maps to the same filename — preserving per-session
 * counter continuity across hook invocations without ever emitting an
 * unsafe path segment.
 */
export function sanitizeSessionIdForFilename(sessionId) {
  if (typeof sessionId === 'string' && SAFE_FILENAME_RE.test(sessionId)) {
    return sessionId;
  }
  return fnv1a64(typeof sessionId === 'string' ? sessionId : String(sessionId));
}

/**
 * Cheap hardening on the hook payload's `transcript_path` before we read it:
 * Claude Code always points this at a `.jsonl` transcript file, so rejecting
 * anything else costs nothing and closes off reading an arbitrary file the
 * hook payload happened to name.
 */
export function looksLikeTranscriptPath(path) {
  return typeof path === 'string' && path.length > 0 && path.endsWith('.jsonl');
}

/**
 * Parses Claude Code's transcript JSONL format into a flat list of
 * user/assistant messages plus three convenience pointers: the latest plain
 * user message, the latest assistant message, and the latest tool result
 * (looked up by `tool_use_id` against the tool_use block that produced it,
 * so the result section can be keyed by tool name instead of a bare id).
 *
 * Tolerant of blank lines and a corrupt/partial trailing line (the hook can
 * fire while the transcript file is still being written).
 */
export function parseTranscript(jsonlText) {
  const entries = [];
  for (const line of jsonlText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Ignore an unparsable line rather than failing the whole parse.
    }
  }

  const toolNameById = new Map();
  const messages = [];
  let lastUser;
  let lastAssistant;
  let lastToolResult;

  for (const entry of entries) {
    const message = entry && entry.message;
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    messages.push(message);

    if (message.role === 'assistant') {
      const text = extractText(message.content);
      if (text) lastAssistant = text;
      for (const block of asBlocks(message.content)) {
        if (block && block.type === 'tool_use' && typeof block.id === 'string') {
          toolNameById.set(block.id, block.name);
        }
      }
      continue;
    }

    // message.role === 'user'
    const toolResultBlock = asBlocks(message.content).find((b) => b && b.type === 'tool_result');
    if (toolResultBlock) {
      lastToolResult = {
        name: toolNameById.get(toolResultBlock.tool_use_id) ?? 'unknown',
        text: extractText(toolResultBlock.content),
      };
      continue;
    }
    const text = extractText(message.content);
    if (text) lastUser = text;
  }

  return { messages, lastUser, lastAssistant, lastToolResult };
}

/**
 * Builds the wire-shaped Section objects for one segment snapshot from a
 * parsed transcript: `hist:transcript` (the full serialized conversation),
 * `user:latest`, `assistant:latest`, and `tool:<name>` for the most recent
 * tool result, when present. Positions are assigned in the order above.
 * Every section's content is capped at MAX_TRANSCRIPT_CHARS (see
 * `toSection`) — not just the transcript — so a single oversized message
 * (a giant tool result, say) can't get the whole segment rejected
 * server-side by the section content-size limit.
 */
export function buildSections(parsed) {
  const sections = [];

  sections.push(
    toSection({
      key: 'hist:transcript',
      service: 'claude-code',
      serviceKind: 'history',
      content: serializeTranscript(parsed.messages),
    }),
  );

  if (parsed.lastUser !== undefined) {
    sections.push(
      toSection({
        key: 'user:latest',
        service: 'claude-code',
        serviceKind: 'user',
        role: 'user',
        content: parsed.lastUser,
      }),
    );
  }

  if (parsed.lastAssistant !== undefined) {
    sections.push(
      toSection({
        key: 'assistant:latest',
        service: 'claude-code',
        serviceKind: 'other',
        role: 'assistant',
        content: parsed.lastAssistant,
      }),
    );
  }

  if (parsed.lastToolResult) {
    sections.push(
      toSection({
        key: `tool:${parsed.lastToolResult.name}`,
        service: 'claude-code',
        serviceKind: 'tool',
        role: 'tool',
        content: parsed.lastToolResult.text,
      }),
    );
  }

  return sections.map((section, position) => ({ ...section, position }));
}

function toSection({ key, service, serviceKind, role, content }) {
  // Keep the TAIL, not the head, when a section is over the cap: content
  // here only grows across a session (the transcript, and any of these
  // "latest" pointers can independently be huge — e.g. a giant tool
  // result), so slicing from the front would freeze a section's content the
  // moment it crosses the cap (every later turn truncates back to the same
  // leading bytes), which reads to context-trace as a section that's
  // present and unchanged forever — i.e. it would falsely trip the
  // dead-weight finding. The tail is also the more useful half to see.
  const text = (content ?? '').slice(-MAX_TRANSCRIPT_CHARS);
  return {
    key,
    service,
    serviceKind,
    role,
    content: text,
    contentHash: fnv1a64(text),
    tokens: estimateTokens(text),
  };
}

function serializeTranscript(messages) {
  return messages.map((message) => `[${message.role}] ${extractText(message.content)}`).join('\n\n');
}

function asBlocks(content) {
  return Array.isArray(content) ? content : [];
}

/**
 * A message's `content` is either a plain string or an array of content
 * blocks (text / tool_use / tool_result / ...). Only `text` blocks
 * contribute to the extracted text here — tool_use/tool_result blocks are
 * handled separately by their callers, since they need their own metadata
 * (tool id/name), not just text.
 */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
  }
  return '';
}
