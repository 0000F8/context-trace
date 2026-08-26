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
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSections, looksLikeTranscriptPath, parseTranscript, sanitizeSessionIdForFilename } from './lib.mjs';

const ENDPOINT = process.env.CONTEXT_TRACE_ENDPOINT ?? 'http://localhost:4720';
const API_KEY = process.env.CONTEXT_TRACE_API_KEY;
const LOG_PREFIX = 'context-trace-claude-code-adapter:';
/** Owner-only: the counter dir holds one file per Claude Code session id. */
const COUNTER_DIR_MODE = 0o700;

/**
 * Where the per-session counter files/locks live. Prefers `~/.cache` over
 * `os.tmpdir()`: `/tmp` is world-writable and shared across every user on
 * the machine, which makes it a target for a symlink race (pre-creating
 * `/tmp/context-trace-cc/<id>.json` as a symlink to something the attacker
 * wants overwritten, before this script ever runs) — a user-owned `~/.cache`
 * directory isn't exposed to other users the same way. Falls back to
 * `os.tmpdir()` when `homedir()` is unavailable (e.g. some restricted/
 * sandboxed environments), and to an explicit override for tests, which
 * exercise the counter lock against disposable temp dirs.
 *
 * Deliberately NOT cached at module scope: this script's own process only
 * ever calls it once anyway (one hook invocation = one process), and
 * resolving it fresh on every call lets tests flip
 * `CONTEXT_TRACE_CC_COUNTER_DIR` between calls within a single test process.
 */
export function resolveCounterDir(env = process.env, { homedirFn = homedir, tmpdirFn = tmpdir } = {}) {
  if (env.CONTEXT_TRACE_CC_COUNTER_DIR) return env.CONTEXT_TRACE_CC_COUNTER_DIR;
  try {
    const home = homedirFn();
    if (home) return join(home, '.cache', 'context-trace-cc');
  } catch {
    // homedir() can throw when the environment has no resolvable home dir.
  }
  return join(tmpdirFn(), 'context-trace-cc');
}

// A previous invocation that crashed while holding the lock (killed hook
// process, OOM, ...) must not wedge every future hook for this session
// forever — a lock dir older than this is assumed abandoned and broken.
const LOCK_STALE_MS = 5_000;
const LOCK_RETRY_DELAY_MS = 20;
const LOCK_MAX_WAIT_MS = 2_000;

async function main() {
  const payload = await readStdinJson();
  if (!payload) return;

  const sessionId = payload.session_id;
  const transcriptPath = payload.transcript_path;
  if (typeof sessionId !== 'string' || !sessionId || typeof transcriptPath !== 'string' || !transcriptPath) {
    console.error(`${LOG_PREFIX} hook payload missing session_id/transcript_path, skipping`);
    return;
  }
  if (!looksLikeTranscriptPath(transcriptPath)) {
    console.error(`${LOG_PREFIX} transcript_path is not a .jsonl file, skipping: ${transcriptPath}`);
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
  const index = await nextIndex(sessionId);

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
 * Segment index from a counter file under the counter dir (see
 * `resolveCounterDir`), named after the session id — each hook invocation is
 * a fresh process with no memory of prior invocations for the same Claude
 * Code session, so the per-session monotonic counter has to live on disk.
 *
 * `sessionId` is untrusted input from the hook payload, so it's reduced to a
 * safe filename via `sanitizeSessionIdForFilename` before touching the
 * filesystem — never used raw as a path component.
 *
 * Claude Code can fire two hooks for the same session in close succession
 * (e.g. PostToolUse events for parallel tool calls), so the read-modify-write
 * against that file is wrapped in a cross-process advisory lock — without
 * it, two hook processes can both read {next: 5}, both post index 5, and the
 * second upsert silently overwrites the first snapshot server-side (segments
 * are upserted by id, and both would compute the same id from the same
 * index).
 */
export async function nextIndex(sessionId) {
  const counterDir = resolveCounterDir();
  try {
    mkdirSync(counterDir, { recursive: true, mode: COUNTER_DIR_MODE });
  } catch (err) {
    console.error(`${LOG_PREFIX} could not create counter dir: ${err.message}`);
  }

  const fileKey = sanitizeSessionIdForFilename(sessionId);

  try {
    return await withCounterLock(counterDir, fileKey, () => readAndBumpCounter(counterDir, fileKey));
  } catch (err) {
    // Could not get the lock in time (contention, or a wedged stale lock we
    // couldn't clear). Fall back to an unlocked read-modify-write rather
    // than dropping the segment entirely: an occasional collision here is
    // better than never posting anything for this hook invocation.
    console.error(`${LOG_PREFIX} could not acquire counter lock for ${sessionId}, proceeding unlocked: ${err.message}`);
    return readAndBumpCounter(counterDir, fileKey);
  }
}

/**
 * Cross-process mutex over the counter file for one session, using an
 * `mkdir` as the lock primitive — directory creation is atomic at the OS
 * level (a single syscall), so it works as a lock across separate `node
 * capture.mjs` processes, unlike a plain read-then-write against the
 * counter file itself.
 */
async function withCounterLock(counterDir, fileKey, fn) {
  const lockDir = join(counterDir, `${fileKey}.lock`);
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;

  for (;;) {
    try {
      mkdirSync(lockDir, { mode: COUNTER_DIR_MODE });
      break; // lock acquired
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      breakStaleLock(lockDir);
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for counter lock at ${lockDir}`);
      }
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

  try {
    return fn();
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`${LOG_PREFIX} could not release counter lock at ${lockDir}: ${err.message}`);
    }
  }
}

/** Removes a lock dir older than LOCK_STALE_MS, left behind by a crashed hook process. */
function breakStaleLock(lockDir) {
  try {
    const stat = statSync(lockDir);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      rmSync(lockDir, { recursive: true, force: true });
    }
  } catch {
    // The lock dir may have vanished between our failed mkdir and this stat
    // (the holder released it) — nothing to break, just retry the mkdir.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readAndBumpCounter(counterDir, fileKey) {
  const counterFile = join(counterDir, `${fileKey}.json`);
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

// Only auto-run when invoked directly as a hook command (`node capture.mjs`),
// not when imported (e.g. by tests importing `nextIndex`).
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error(`${LOG_PREFIX} unexpected error: ${err && err.message ? err.message : err}`);
  });
}
