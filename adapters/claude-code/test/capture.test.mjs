import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextIndex, resolveCounterDir } from '../capture.mjs';

describe('resolveCounterDir', () => {
  it('honors an explicit env override first', () => {
    expect(resolveCounterDir({ CONTEXT_TRACE_CC_COUNTER_DIR: '/custom/dir' })).toBe('/custom/dir');
  });

  it('prefers a resolvable home directory over os.tmpdir()', () => {
    const dir = resolveCounterDir({}, { homedirFn: () => '/home/alice', tmpdirFn: () => '/tmp' });
    expect(dir).toBe(join('/home/alice', '.cache', 'context-trace-cc'));
  });

  it('falls back to os.tmpdir() when homedir() throws', () => {
    const dir = resolveCounterDir(
      {},
      {
        homedirFn: () => {
          throw new Error('no home directory in this sandbox');
        },
        tmpdirFn: () => '/tmp',
      },
    );
    expect(dir).toBe(join('/tmp', 'context-trace-cc'));
  });

  it('falls back to os.tmpdir() when homedir() returns an empty value', () => {
    const dir = resolveCounterDir({}, { homedirFn: () => '', tmpdirFn: () => '/tmp' });
    expect(dir).toBe(join('/tmp', 'context-trace-cc'));
  });
});

describe('nextIndex filesystem hardening', () => {
  let counterRoot;

  beforeEach(() => {
    counterRoot = mkdtempSync(join(tmpdir(), 'ct-cc-secure-test-'));
  });

  afterEach(() => {
    rmSync(counterRoot, { recursive: true, force: true });
  });

  function withCounterDir(counterDir, fn) {
    const prev = process.env.CONTEXT_TRACE_CC_COUNTER_DIR;
    process.env.CONTEXT_TRACE_CC_COUNTER_DIR = counterDir;
    return Promise.resolve()
      .then(fn)
      .finally(() => {
        if (prev === undefined) delete process.env.CONTEXT_TRACE_CC_COUNTER_DIR;
        else process.env.CONTEXT_TRACE_CC_COUNTER_DIR = prev;
      });
  }

  it('creates the counter dir with owner-only (0700) permissions', async () => {
    const counterDir = join(counterRoot, 'context-trace-cc');
    await withCounterDir(counterDir, () => nextIndex('a-normal-session-id'));

    expect(existsSync(counterDir)).toBe(true);
    if (process.platform !== 'win32') {
      const mode = statSync(counterDir).mode & 0o777;
      expect(mode).toBe(0o700);
    }
  });

  it('never writes a file literally named after a path-traversal session id, and stays inside the counter dir', async () => {
    const counterDir = join(counterRoot, 'context-trace-cc');
    const malicious = '../../../etc/evil-session';

    await withCounterDir(counterDir, () => nextIndex(malicious));

    // Nothing escaped counterRoot: only the one dir we asked for exists in it.
    expect(readdirSync(counterRoot)).toEqual(['context-trace-cc']);

    const entries = readdirSync(counterDir);
    // The sanitized (hashed) counter file is in there; nothing containing a
    // path separator or ".." ever made it into a filename.
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).not.toContain(sep);
      expect(entry).not.toContain('..');
    }
  });

  it('gives the same sanitized session id the same, incrementing counter across calls', async () => {
    const counterDir = join(counterRoot, 'context-trace-cc');
    const malicious = '../shared/../session';

    const first = await withCounterDir(counterDir, () => nextIndex(malicious));
    const second = await withCounterDir(counterDir, () => nextIndex(malicious));

    expect(first).toBe(0);
    expect(second).toBe(1);
  });
});
