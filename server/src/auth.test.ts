import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { bootstrapAuth, parseAuthMode } from './auth.js';
import { createApp } from './app.js';
import { DEFAULT_PROJECT_ID, openDb, type Db } from './db.js';
import { hashKey } from './keys.js';
import * as store from './store.js';

function baseUrl() {
  return 'http://localhost';
}

function ingestBody(sessionId: string) {
  return JSON.stringify({
    events: [{ type: 'session.started', data: { id: sessionId, name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() } }],
  });
}

async function ingest(app: Hono, apiKey: string | undefined, sessionId: string) {
  return app.request(`${baseUrl()}/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
    body: ingestBody(sessionId),
  });
}

// ---------------------------------------------------------------------------
// parseAuthMode
// ---------------------------------------------------------------------------

describe('parseAuthMode', () => {
  it('treats unset as none', () => {
    expect(parseAuthMode(undefined)).toBe('none');
  });

  it('treats an empty string as none', () => {
    expect(parseAuthMode('')).toBe('none');
  });

  it('accepts the literal "none"', () => {
    expect(parseAuthMode('none')).toBe('none');
  });

  it('accepts the literal "key"', () => {
    expect(parseAuthMode('key')).toBe('key');
  });

  it('fails fast on any other value rather than silently falling open', () => {
    expect(() => parseAuthMode('open')).toThrow(/invalid CT_AUTH/);
    expect(() => parseAuthMode('KEY')).toThrow(/invalid CT_AUTH/);
    expect(() => parseAuthMode('true')).toThrow(/invalid CT_AUTH/);
  });
});

// ---------------------------------------------------------------------------
// bootstrapAuth
// ---------------------------------------------------------------------------

describe('bootstrapAuth', () => {
  it('no-ops in none mode, even with CT_API_KEY set', () => {
    const db = openDb(':memory:');
    const result = bootstrapAuth(db, { authMode: 'none', apiKey: 'secret' });
    expect(result).toEqual({ legacyApiKeyIgnored: false });
    expect(store.hasActiveAdminKey(db)).toBe(false);
  });

  it('mints and returns a fresh admin key when none exists yet in key mode', () => {
    const db = openDb(':memory:');
    const result = bootstrapAuth(db, { authMode: 'key' });
    expect(result.generatedAdminKey).toMatch(/^cta_/);
    expect(store.hasActiveAdminKey(db)).toBe(true);
  });

  it('does not mint a second admin key on a later boot once one already exists', () => {
    const db = openDb(':memory:');
    const first = bootstrapAuth(db, { authMode: 'key' });
    expect(first.generatedAdminKey).toBeDefined();
    const second = bootstrapAuth(db, { authMode: 'key' });
    expect(second.generatedAdminKey).toBeUndefined();
    expect(store.listProjectKeys(db, DEFAULT_PROJECT_ID).filter((k) => k.role === 'admin')).toHaveLength(1);
  });

  it('hashes CT_ADMIN_KEY instead of generating one, and never re-inserts it across restarts', async () => {
    const db = openDb(':memory:');
    const result = bootstrapAuth(db, { authMode: 'key', adminKeyEnv: 'cta_my-fixed-admin-key' });
    expect(result.generatedAdminKey).toBeUndefined();

    const app = createApp(db, { authMode: 'key' });
    const res = await app.request(`${baseUrl()}/v1/admin/projects`, { headers: { 'x-api-key': 'cta_my-fixed-admin-key' } });
    expect(res.status).toBe(200);

    // Re-running boot with the same env key must not create a duplicate row.
    bootstrapAuth(db, { authMode: 'key', adminKeyEnv: 'cta_my-fixed-admin-key' });
    expect(store.listProjectKeys(db, DEFAULT_PROJECT_ID).filter((k) => k.role === 'admin')).toHaveLength(1);
  });

  it('reports legacyApiKeyIgnored when CT_API_KEY is set alongside CT_AUTH=key', () => {
    const db = openDb(':memory:');
    const result = bootstrapAuth(db, { authMode: 'key', apiKey: 'legacy-secret' });
    expect(result.legacyApiKeyIgnored).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth matrix (spec3.md §J)
// ---------------------------------------------------------------------------

describe('none mode (open) — no behavior change', () => {
  it('admin routes are entirely absent (404), not just unauthorized', async () => {
    const app = createApp(openDb(':memory:'));
    expect((await app.request(`${baseUrl()}/v1/admin/projects`)).status).toBe(404);
    expect((await app.request(`${baseUrl()}/v1/admin/projects`, { method: 'POST' })).status).toBe(404);
  });
});

describe('none mode + CT_API_KEY (legacy write-key) — exactly v0.2', () => {
  it('admin routes stay 404 even though a legacy key is configured', async () => {
    const app = createApp(openDb(':memory:'), { apiKey: 'secret' });
    expect((await app.request(`${baseUrl()}/v1/admin/projects`)).status).toBe(404);
  });

  it('reads stay open and writes require the legacy key, exactly like v0.2', async () => {
    const app = createApp(openDb(':memory:'), { apiKey: 'secret' });
    expect((await app.request(`${baseUrl()}/v1/stats`)).status).toBe(200);
    expect((await ingest(app, undefined, 's1')).status).toBe(401);
    expect((await ingest(app, 'secret', 's1')).status).toBe(200);
  });
});

describe('key mode', () => {
  let db: Db;
  let app: Hono;
  let projectA: { id: string };
  let readKey: string;
  let writeKey: string;
  let adminKey: string;

  beforeEach(() => {
    db = openDb(':memory:');
    const project = store.createProject(db, 'Project A');
    projectA = project;
    readKey = store.createProjectKey(db, project.id, 'reader', 'read')!.key;
    writeKey = store.createProjectKey(db, project.id, 'writer', 'write')!.key;
    adminKey = store.createProjectKey(db, project.id, 'admin', 'admin')!.key;
    app = createApp(db, { authMode: 'key' });
  });

  it('answers /healthz without any key', async () => {
    expect((await app.request(`${baseUrl()}/healthz`)).status).toBe(200);
  });

  it('401s every other /v1/* route with no key at all', async () => {
    expect((await app.request(`${baseUrl()}/v1/stats`)).status).toBe(401);
    expect((await app.request(`${baseUrl()}/v1/sessions`)).status).toBe(401);
  });

  it('401s on an unknown/garbage key', async () => {
    const res = await app.request(`${baseUrl()}/v1/stats`, { headers: { 'x-api-key': 'ctr_not-a-real-key' } });
    expect(res.status).toBe(401);
  });

  it('ignores a legacy CT_API_KEY-style header value that is not a minted project key', async () => {
    const keyedApp = createApp(db, { authMode: 'key', apiKey: 'legacy-secret' });
    const res = await keyedApp.request(`${baseUrl()}/v1/stats`, { headers: { 'x-api-key': 'legacy-secret' } });
    expect(res.status).toBe(401);
  });

  it('a read key can GET but 401s on writes', async () => {
    expect((await app.request(`${baseUrl()}/v1/stats`, { headers: { 'x-api-key': readKey } })).status).toBe(200);
    expect((await ingest(app, readKey, 's1')).status).toBe(401);
    const delRes = await app.request(`${baseUrl()}/v1/sessions/s1`, { method: 'DELETE', headers: { 'x-api-key': readKey } });
    expect(delRes.status).toBe(401);
  });

  it('a write key can both read and write', async () => {
    expect((await app.request(`${baseUrl()}/v1/stats`, { headers: { 'x-api-key': writeKey } })).status).toBe(200);
    expect((await ingest(app, writeKey, 's1')).status).toBe(200);
    const delRes = await app.request(`${baseUrl()}/v1/sessions/s1`, { method: 'DELETE', headers: { 'x-api-key': writeKey } });
    expect(delRes.status).toBe(200);
  });

  it('an admin key can read, write, and reach admin routes', async () => {
    expect((await app.request(`${baseUrl()}/v1/stats`, { headers: { 'x-api-key': adminKey } })).status).toBe(200);
    expect((await ingest(app, adminKey, 's1')).status).toBe(200);
    expect((await app.request(`${baseUrl()}/v1/admin/projects`, { headers: { 'x-api-key': adminKey } })).status).toBe(200);
  });

  it('a revoked key 401s immediately', async () => {
    const created = store.createProjectKey(db, projectA.id, 'temp', 'write')!;
    expect((await app.request(`${baseUrl()}/v1/stats`, { headers: { 'x-api-key': created.key } })).status).toBe(200);
    store.revokeProjectKey(db, created.id);
    expect((await app.request(`${baseUrl()}/v1/stats`, { headers: { 'x-api-key': created.key } })).status).toBe(401);
  });

  it('accepts a key via ?key= on the live route only', async () => {
    await ingest(app, writeKey, 's1');
    const res = await app.request(`${baseUrl()}/v1/sessions/s1/live?key=${encodeURIComponent(readKey)}`);
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  it('does not accept ?key= on a non-live route', async () => {
    const res = await app.request(`${baseUrl()}/v1/stats?key=${encodeURIComponent(readKey)}`);
    expect(res.status).toBe(401);
  });

  it('export stays header-only: ?key= is rejected even though export is also a "download" endpoint', async () => {
    await ingest(app, writeKey, 's1');
    const viaQuery = await app.request(`${baseUrl()}/v1/sessions/s1/export?key=${encodeURIComponent(readKey)}`);
    expect(viaQuery.status).toBe(401);
    const viaHeader = await app.request(`${baseUrl()}/v1/sessions/s1/export`, { headers: { 'x-api-key': readKey } });
    expect(viaHeader.status).toBe(200);
  });
});

describe('cross-project isolation: 404, never 403 (spec3.md §B/§J)', () => {
  let db: Db;
  let app: Hono;
  let keyA: string;
  let keyB: string;
  let writeKeyB: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    const projectA = store.createProject(db, 'A');
    const projectB = store.createProject(db, 'B');
    keyA = store.createProjectKey(db, projectA.id, 'a-write', 'write')!.key;
    keyB = store.createProjectKey(db, projectB.id, 'b-read', 'read')!.key;
    writeKeyB = store.createProjectKey(db, projectB.id, 'b-write', 'write')!.key;
    app = createApp(db, { authMode: 'key' });

    await app.request(`${baseUrl()}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': keyA },
      body: JSON.stringify({
        events: [
          { type: 'session.started', data: { id: 'a-session', name: 'a', startedAt: new Date(2026, 0, 1).toISOString() } },
          {
            type: 'segment.recorded',
            data: {
              id: 'a-seg-0',
              sessionId: 'a-session',
              index: 0,
              kind: 'llm_call',
              timestamp: new Date(2026, 0, 1).toISOString(),
              sections: [{ key: 'notes', service: 'svc', serviceKind: 'memory', position: 0, content: 'secret content', tokens: 2 }],
            },
          },
        ],
      }),
    });
  });

  async function asB(path: string, init?: RequestInit) {
    return app.request(`${baseUrl()}${path}`, { ...init, headers: { ...init?.headers, 'x-api-key': keyB } });
  }

  it('session detail: 404', async () => {
    expect((await asB('/v1/sessions/a-session')).status).toBe(404);
  });

  it('trace: 404', async () => {
    expect((await asB('/v1/sessions/a-session/trace')).status).toBe(404);
  });

  it('analytics: 404', async () => {
    expect((await asB('/v1/sessions/a-session/trace/analytics')).status).toBe(404);
  });

  it('segment detail: 404', async () => {
    expect((await asB('/v1/sessions/a-session/segments/0')).status).toBe(404);
  });

  it('export: 404', async () => {
    expect((await asB('/v1/sessions/a-session/export')).status).toBe(404);
  });

  it('search results: another project session never appears', async () => {
    const res = await asB('/v1/search?q=secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[] };
    expect(body.hits).toEqual([]);
  });

  it('delete with a project-B write key: 404, and the session survives untouched', async () => {
    const res = await app.request(`${baseUrl()}/v1/sessions/a-session`, { method: 'DELETE', headers: { 'x-api-key': writeKeyB } });
    expect(res.status).toBe(404);

    const stillThere = await app.request(`${baseUrl()}/v1/sessions/a-session`, { headers: { 'x-api-key': keyA } });
    expect(stillThere.status).toBe(200);
  });

  it('live: 404 for a session owned by another project', async () => {
    const res = await asB('/v1/sessions/a-session/live');
    expect(res.status).toBe(404);
  });

  it('a session id that already belongs to another project cannot be hijacked by session.started', async () => {
    const hijack = await app.request(`${baseUrl()}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': writeKeyB },
      body: JSON.stringify({
        events: [{ type: 'session.started', data: { id: 'a-session', name: 'hijacked', startedAt: new Date(2026, 0, 1).toISOString() } }],
      }),
    });
    const body = (await hijack.json()) as { accepted: number; rejected?: Array<{ reason: string }> };
    expect(body.accepted).toBe(0);
    expect(body.rejected?.[0]?.reason).toBe('unknown session');

    // Project A's session must be entirely unaffected.
    const stillA = await app.request(`${baseUrl()}/v1/sessions/a-session`, { headers: { 'x-api-key': keyA } });
    const detail = (await stillA.json()) as { name: string };
    expect(detail.name).toBe('a');
  });

  it('a project-B write key cannot append a segment to project A\'s session', async () => {
    const res = await app.request(`${baseUrl()}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': writeKeyB },
      body: JSON.stringify({
        events: [
          {
            type: 'segment.recorded',
            data: {
              id: 'b-seg',
              sessionId: 'a-session',
              index: 1,
              kind: 'llm_call',
              timestamp: new Date(2026, 0, 1).toISOString(),
              sections: [],
            },
          },
        ],
      }),
    });
    const body = (await res.json()) as { accepted: number; rejected?: Array<{ reason: string }> };
    expect(body.accepted).toBe(0);
    expect(body.rejected?.[0]?.reason).toBe('unknown session');
  });
});

describe('admin routes (spec3.md §C)', () => {
  let db: Db;
  let app: Hono;
  let adminKey: string;
  let readKey: string;
  let writeKey: string;

  beforeEach(() => {
    db = openDb(':memory:');
    const project = store.createProject(db, 'Bootstrap');
    adminKey = store.createProjectKey(db, project.id, 'admin', 'admin')!.key;
    readKey = store.createProjectKey(db, project.id, 'reader', 'read')!.key;
    writeKey = store.createProjectKey(db, project.id, 'writer', 'write')!.key;
    app = createApp(db, { authMode: 'key' });
  });

  it('refuses a read-role key', async () => {
    const res = await app.request(`${baseUrl()}/v1/admin/projects`, { headers: { 'x-api-key': readKey } });
    expect(res.status).toBe(401);
  });

  it('refuses a write-role key', async () => {
    const res = await app.request(`${baseUrl()}/v1/admin/projects`, { headers: { 'x-api-key': writeKey } });
    expect(res.status).toBe(401);
  });

  it('creates and lists projects', async () => {
    const createRes = await app.request(`${baseUrl()}/v1/admin/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': adminKey },
      body: JSON.stringify({ name: 'New Co' }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; name: string; createdAt: string };
    expect(created.name).toBe('New Co');

    const listRes = await app.request(`${baseUrl()}/v1/admin/projects`, { headers: { 'x-api-key': adminKey } });
    const list = (await listRes.json()) as { projects: Array<{ id: string }> };
    expect(list.projects.some((p) => p.id === created.id)).toBe(true);
  });

  it('creates a key (plaintext once) and lists keys as metadata only', async () => {
    const projectRes = await app.request(`${baseUrl()}/v1/admin/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': adminKey },
      body: JSON.stringify({ name: 'Keyed' }),
    });
    const project = (await projectRes.json()) as { id: string };

    const keyRes = await app.request(`${baseUrl()}/v1/admin/projects/${project.id}/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': adminKey },
      body: JSON.stringify({ name: 'svc-key', role: 'write' }),
    });
    expect(keyRes.status).toBe(201);
    const created = (await keyRes.json()) as { key: string; prefix: string };
    expect(created.key).toMatch(/^ctw_/);

    const listRes = await app.request(`${baseUrl()}/v1/admin/projects/${project.id}/keys`, { headers: { 'x-api-key': adminKey } });
    const body = (await listRes.json()) as { keys: Array<Record<string, unknown>> };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).not.toHaveProperty('key');
    expect(body.keys[0]).not.toHaveProperty('keyHash');
    expect(body.keys[0]?.prefix).toBe(created.prefix);
  });

  it('revokes a key, which then 401s', async () => {
    const created = store.createProjectKey(db, store.listProjects(db)[0]!.id, 'to-revoke', 'read')!;
    expect((await app.request(`${baseUrl()}/v1/stats`, { headers: { 'x-api-key': created.key } })).status).toBe(200);

    const revokeRes = await app.request(`${baseUrl()}/v1/admin/keys/${created.id}/revoke`, {
      method: 'POST',
      headers: { 'x-api-key': adminKey },
    });
    expect(revokeRes.status).toBe(200);
    expect((await app.request(`${baseUrl()}/v1/stats`, { headers: { 'x-api-key': created.key } })).status).toBe(401);
  });

  it('deletes a project, cascading its keys and sessions', async () => {
    const projectRes = await app.request(`${baseUrl()}/v1/admin/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': adminKey },
      body: JSON.stringify({ name: 'Doomed' }),
    });
    const project = (await projectRes.json()) as { id: string };
    const doomedWrite = store.createProjectKey(db, project.id, 'doomed-write', 'write')!;
    await ingest(app, doomedWrite.key, 'doomed-session');
    expect(store.sessionExists(db, 'doomed-session', project.id)).toBe(true);

    const delRes = await app.request(`${baseUrl()}/v1/admin/projects/${project.id}`, {
      method: 'DELETE',
      headers: { 'x-api-key': adminKey },
    });
    expect(delRes.status).toBe(200);
    expect(store.getProject(db, project.id)).toBeUndefined();
    expect(store.listProjectKeys(db, project.id)).toEqual([]);
    expect(store.sessionExists(db, 'doomed-session', project.id)).toBe(false);
  });

  it('rate-limits admin traffic to 10 requests/minute/key', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await app.request(`${baseUrl()}/v1/admin/projects`, { headers: { 'x-api-key': adminKey } });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
  });
});

describe('last_used_at throttling (spec3.md §B)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates at most once per minute per key', async () => {
    vi.useFakeTimers();
    const db = openDb(':memory:');
    const project = store.createProject(db, 'Timed');
    const created = store.createProjectKey(db, project.id, 'k', 'read')!;
    const app = createApp(db, { authMode: 'key' });

    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    await app.request(`${baseUrl()}/v1/stats`, { headers: { 'x-api-key': created.key } });
    expect(store.listProjectKeys(db, project.id)[0]?.lastUsedAt).toBe('2026-01-01T00:00:00.000Z');

    vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'));
    await app.request(`${baseUrl()}/v1/stats`, { headers: { 'x-api-key': created.key } });
    expect(store.listProjectKeys(db, project.id)[0]?.lastUsedAt).toBe('2026-01-01T00:00:00.000Z');

    vi.setSystemTime(new Date('2026-01-01T00:01:05.000Z'));
    await app.request(`${baseUrl()}/v1/stats`, { headers: { 'x-api-key': created.key } });
    expect(store.listProjectKeys(db, project.id)[0]?.lastUsedAt).toBe('2026-01-01T00:01:05.000Z');
  });
});

// ---------------------------------------------------------------------------
// CLI (spec3.md §C) — a real subprocess against a real CT_DB file, no server running.
// ---------------------------------------------------------------------------

describe('keys CLI', () => {
  function resolveTsxBin(): string {
    const local = join(process.cwd(), 'node_modules', '.bin', 'tsx');
    if (existsSync(local)) return local;
    return join(process.cwd(), '..', 'node_modules', '.bin', 'tsx');
  }

  it('round-trips create-project + create-key, and that key authenticates a real app instance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-cli-'));
    const dbPath = join(dir, 'cli.db');
    const tsxBin = resolveTsxBin();
    const cliPath = join(process.cwd(), 'src', 'keys-cli.ts');
    const env = { ...process.env, CT_DB: dbPath };

    try {
      const projectOut = execFileSync(tsxBin, [cliPath, 'create-project', 'Acme'], { env, encoding: 'utf8' });
      const projectId = /created project (\S+)/.exec(projectOut)?.[1];
      expect(projectId).toBeTruthy();

      const keyOut = execFileSync(tsxBin, [cliPath, 'create-key', projectId!, 'ci-key', 'write'], { env, encoding: 'utf8' });
      const key = keyOut
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('ctw_'));
      expect(key).toBeTruthy();

      const listOut = execFileSync(tsxBin, [cliPath, 'list-keys', projectId!], { env, encoding: 'utf8' });
      expect(listOut).toContain('ci-key');
      expect(listOut).not.toContain(key!); // plaintext must never appear in a listing

      const listProjectsOut = execFileSync(tsxBin, [cliPath, 'list-projects'], { env, encoding: 'utf8' });
      expect(listProjectsOut).toContain('Acme');

      // The minted key must authenticate against a real server instance on the same DB file.
      const db = openDb(dbPath);
      const app = createApp(db, { authMode: 'key' });
      const res = await app.request(`${baseUrl()}/v1/stats`, { headers: { 'x-api-key': key! } });
      expect(res.status).toBe(200);

      const keyId = store.findActiveKeyByHash(db, hashKey(key!))!.id;
      const revokeOut = execFileSync(tsxBin, [cliPath, 'revoke-key', keyId], { env, encoding: 'utf8' });
      expect(revokeOut).toMatch(/revoked key/);
      const afterRevoke = await app.request(`${baseUrl()}/v1/stats`, { headers: { 'x-api-key': key! } });
      expect(afterRevoke.status).toBe(401);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a flag-shaped argument instead of silently storing it as a value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-cli-flags-'));
    const dbPath = join(dir, 'cli.db');
    const tsxBin = resolveTsxBin();
    const cliPath = join(process.cwd(), 'src', 'keys-cli.ts');
    const env = { ...process.env, CT_DB: dbPath };

    try {
      const result = spawnSync(tsxBin, [cliPath, 'create-project', '--name', 'ProjA'], { env, encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/unrecognized option "--name"/);
      expect(result.stderr).toMatch(/keys create-project <name>/);

      // Validation happens before the DB is even opened — a rejected invocation must
      // not create the file, let alone a project literally named "--name".
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a flag-shaped role in create-key without creating a key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-cli-flags2-'));
    const dbPath = join(dir, 'cli.db');
    const tsxBin = resolveTsxBin();
    const cliPath = join(process.cwd(), 'src', 'keys-cli.ts');
    const env = { ...process.env, CT_DB: dbPath };

    try {
      const projectOut = execFileSync(tsxBin, [cliPath, 'create-project', 'RealProj'], { env, encoding: 'utf8' });
      const projectId = /created project (\S+)/.exec(projectOut)?.[1]!;
      expect(projectId).toBeTruthy();

      const result = spawnSync(tsxBin, [cliPath, 'create-key', projectId, 'svc', '--role', 'write'], { env, encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/unrecognized option "--role"/);

      const listOut = execFileSync(tsxBin, [cliPath, 'list-keys', projectId], { env, encoding: 'utf8' });
      expect(listOut).toContain('(no keys)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('create-key against a nonexistent project errors clearly without creating an orphan key row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-cli-noproj-'));
    const dbPath = join(dir, 'cli.db');
    const tsxBin = resolveTsxBin();
    const cliPath = join(process.cwd(), 'src', 'keys-cli.ts');
    const env = { ...process.env, CT_DB: dbPath };

    try {
      const result = spawnSync(tsxBin, [cliPath, 'create-key', 'nonexistent-project', 'svc', 'write'], {
        env,
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/no such project: nonexistent-project/);

      const db = openDb(dbPath);
      const row = db.prepare('SELECT COUNT(*) AS c FROM project_keys').get() as { c: number };
      expect(row.c).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
