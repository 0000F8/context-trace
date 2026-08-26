#!/usr/bin/env node
/**
 * Claude Code hook entrypoint. Reads a hook payload JSON object on stdin
 * (Claude Code invokes hook commands this way for Stop/PostToolUse/...),
 * snapshots the transcript at that moment, and posts it to context-trace as
 * one segment. See README.md for the exact settings.json wiring.
 *
 * Contract: this script must NEVER block or fail the hook. Every error path
 * below logs to stderr and simply returns — nothing here calls
 * `process.exit` with a non-zero code, and the top-level catch guarantees
 * that an unexpected throw can't turn into one either.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSections, parseTranscript } from './lib.mjs';

const ENDPOINT = process.env.CONTEXT_TRACE_ENDPOINT ?? 'http://localhost:4720';
const API_KEY = process.env.CONTEXT_TRACE_API_KEY;
const COUNTER_DIR = join(tmpdir(), 'context-trace-cc');
const LOG_PREFIX = 'context-trace-claude-code-adapter:';

async function main() {
  const payload = await readStdinJson();
  if (!payload) return;

  const sessionId = payload.session_id;
  const transcriptPath = payload.transcript_path;
  if (typeof sessionId !== 'string' || !sessionId || typeof transcriptPath !== 'string' || !transcriptPath) {
    console.error(`${LOG_PREFIX} hook payload missing session_id/transcript_path, skipping`);
    return;
  }

  let transcriptText;
  try {
    transcriptText = readFileSync(transcriptPath, 'utf8');
  } catch (err) {
    console.error(`${LOG_PREFIX} could not read transcript at ${transcriptPath}: ${err.message}`);
    return;
  }

  const parsed = parseTranscript(transcriptText);
  const sections = buildSections(parsed);
  const index = nextIndex(sessionId);

  const segment = {
    id: `seg_${sessionId}_${index}`,
    sessionId,
    index,
    kind: 'turn',
    label: typeof payload.hook_event_name === 'string' ? payload.hook_event_name : undefined,
    timestamp: new Date().toISOString(),
    sections,
  };

  await postEvents([{ type: 'segment.recorded', data: segment }]);
}

/**
 * Segment index from a counter file under os.tmpdir()/context-trace-cc/
 * <session_id>.json — each hook invocation is a fresh process with no
 * memory of prior invocations for the same Claude Code session, so the
 * per-session monotonic counter has to live on disk.
 */
function nextIndex(sessionId) {
  try {
    mkdirSync(COUNTER_DIR, { recursive: true });
  } catch (err) {
    console.error(`${LOG_PREFIX} could not create counter dir: ${err.message}`);
  }

  const counterFile = join(COUNTER_DIR, `${sessionId}.json`);
  let index = 0;
  try {
    if (existsSync(counterFile)) {
      const raw = JSON.parse(readFileSync(counterFile, 'utf8'));
      if (typeof raw.next === 'number' && Number.isFinite(raw.next) && raw.next >= 0) {
        index = raw.next;
      }
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} could not read counter file, restarting at 0: ${err.message}`);
  }

  try {
    writeFileSync(counterFile, JSON.stringify({ next: index + 1 }));
  } catch (err) {
    // Best effort: a failed write just risks a duplicate/colliding index on
    // the next invocation, which is not worth failing the hook over.
    console.error(`${LOG_PREFIX} could not persist counter file: ${err.message}`);
  }
  return index;
}

async function readStdinJson() {
  try {
    if (process.stdin.isTTY) return undefined;
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return undefined;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`${LOG_PREFIX} could not parse hook payload from stdin: ${err.message}`);
    return undefined;
  }
}

async function postEvents(events) {
  try {
    const headers = { 'content-type': 'application/json' };
    if (API_KEY) headers['x-api-key'] = API_KEY;
    const res = await fetch(`${ENDPOINT}/v1/ingest`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ events }),
    });
    if (!res.ok) {
      console.error(`${LOG_PREFIX} ingest request failed with status ${res.status}`);
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} ingest request failed: ${err.message}`);
  }
}

main().catch((err) => {
  console.error(`${LOG_PREFIX} unexpected error: ${err && err.message ? err.message : err}`);
});
