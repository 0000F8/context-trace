import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const workerPath = join(here, 'concurrent-counter-worker.mjs');

/**
 * These tests spawn real, separate `node` processes against a shared
 * counter directory, because the race this lock guards against is
 * inherently cross-process: Claude Code can launch two independent
 * `capture.mjs` invocations (e.g. PostToolUse for parallel tool calls)
 * whose file-system syscalls genuinely interleave at the OS level. Two
 * concurrent async calls *within one Node process* wouldn't reproduce this —
 * capture.mjs's counter read-modify-write is all synchronous fs calls, so
 * within a single process they can never interleave with each other.
 */
let counterDir;

beforeEach(() => {
  counterDir = mkdtempSync(join(tmpdir(), 'ct-cc-lock-test-'));
});

afterEach(() => {
  rmSync(counterDir, { recursive: true, force: true });
});

function runWorker(sessionId) {
  return execFileAsync('node', [workerPath, sessionId], {
    env: { ...process.env, CONTEXT_TRACE_CC_COUNTER_DIR: counterDir },
  });
}

describe('nextIndex counter lock (cross-process)', () => {
  it('serializes two concurrent hook invocations for the same session: no duplicate index', async () => {
    const sessionId = 'race-session';

    const [a, b] = await Promise.all([runWorker(sessionId), runWorker(sessionId)]);

    const indexA = JSON.parse(a.stdout).index;
    const indexB = JSON.parse(b.stdout).index;

    // Without the lock, both processes can read the same starting counter
    // value and both compute index 0 — the defect this test guards against.
    expect(indexA).not.toBe(indexB);
    expect(new Set([indexA, indexB])).toEqual(new Set([0, 1]));
  }, 10_000);

  it('assigns a gapless, unique index to every invocation under higher concurrency', async () => {
    const sessionId = 'race-session-many';

    const results = await Promise.all(Array.from({ length: 6 }, () => runWorker(sessionId)));
    const indexes = results.map((r) => JSON.parse(r.stdout).index).sort((x, y) => x - y);

    expect(indexes).toEqual([0, 1, 2, 3, 4, 5]);
  }, 15_000);

  it('does not serialize invocations for different sessions against each other', async () => {
    const [a, b] = await Promise.all([runWorker('session-a'), runWorker('session-b')]);

    // Independent sessions each start their own counter at 0 — the lock is
    // per-session (keyed by sessionId), not a single global mutex.
    expect(JSON.parse(a.stdout).index).toBe(0);
    expect(JSON.parse(b.stdout).index).toBe(0);
  }, 10_000);
});
