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

/** Hard cap on the serialized transcript section — see spec §E2. */
export const MAX_TRANSCRIPT_CHARS = 240_000;

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
 * parsed transcript: `hist:transcript` (the full serialized conversation,
 * capped at MAX_TRANSCRIPT_CHARS), `user:latest`, `assistant:latest`, and
 * `tool:<name>` for the most recent tool result, when present. Positions
 * are assigned in the order above.
 */
export function buildSections(parsed) {
  const sections = [];

  sections.push(
    toSection({
      key: 'hist:transcript',
      service: 'claude-code',
      serviceKind: 'history',
      content: serializeTranscript(parsed.messages).slice(0, MAX_TRANSCRIPT_CHARS),
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
  const text = content ?? '';
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
