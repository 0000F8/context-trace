import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { fnv1a64 } from '@context-trace/types';
import { createApp } from './app.js';
import { openDb, type Db } from './db.js';

function baseUrl() {
  return 'http://localhost';
}

function makeSegmentEvent(overrides: {
  id: string;
  sessionId: string;
  index: number;
  sections: Array<{ key: string; content: string; service?: string; serviceKind?: string; position?: number }>;
}) {
  return {
    type: 'segment.recorded' as const,
    data: {
      id: overrides.id,
      sessionId: overrides.sessionId,
      index: overrides.index,
      kind: 'llm_call' as const,
      timestamp: new Date(2026, 0, 1, 0, overrides.index).toISOString(),
      sections: overrides.sections.map((s, i) => ({
        key: s.key,
        service: s.service ?? 'svc',
        serviceKind: s.serviceKind ?? 'memory',
        position: s.position ?? i,
        content: s.content,
        contentHash: fnv1a64(s.content),
        tokens: s.content.length,
      })),
    },
  };
}

describe('app', () => {
  let db: Db;
  let app: Hono;

  beforeEach(() => {
    db = openDb(':memory:');
    app = createApp(db);
  });

  it('ingests a session + segment then reads them back', async () => {
    const res = await app.request(`${baseUrl()}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [
          { type: 'session.started', data: { id: 's1', name: 'test session', startedAt: new Date(2026, 0, 1).toISOString() } },
          makeSegmentEvent({ id: 'seg-0', sessionId: 's1', index: 0, sections: [{ key: 'a', content: 'hello' }] }),
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 2 });

    const sessionsRes = await app.request(`${baseUrl()}/v1/sessions`);
    expect(sessionsRes.status).toBe(200);
    const sessionsBody = await sessionsRes.json();
    expect(sessionsBody.total).toBe(1);
    expect(sessionsBody.sessions[0].id).toBe('s1');
    expect(sessionsBody.sessions[0].segmentCount).toBe(1);

    const detailRes = await app.request(`${baseUrl()}/v1/sessions/s1`);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.segments).toHaveLength(1);
    expect(detail.segments[0].delta).toEqual({ added: 1, removed: 0, changed: 0, carried: 0 });

    const traceRes = await app.request(`${baseUrl()}/v1/sessions/s1/trace`);
    expect(traceRes.status).toBe(200);
    const trace = await traceRes.json();
    expect(trace.segments).toHaveLength(1);
    expect(trace.segments[0].ops).toEqual([{ op: 'add', key: 'a', service: 'svc', tokens: 5 }]);

    const segRes = await app.request(`${baseUrl()}/v1/sessions/s1/segments/0`);
    expect(segRes.status).toBe(200);
    const seg = await segRes.json();
    expect(seg.sections).toHaveLength(1);
    expect(seg.sections[0]).toMatchObject({ key: 'a', state: 'added', content: 'hello' });
    expect(seg.removed).toEqual([]);
  });

  it('is idempotent: re-ingesting an existing segment id replaces its sections', async () => {
    await app.request(`${baseUrl()}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [
          { type: 'session.started', data: { id: 's1', name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() } },
          makeSegmentEvent({ id: 'seg-0', sessionId: 's1', index: 0, sections: [{ key: 'a', content: 'v1' }, { key: 'b', content: 'stays' }] }),
        ],
      }),
    });

    // Re-ingest the same segment id with different sections.
    await app.request(`${baseUrl()}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [makeSegmentEvent({ id: 'seg-0', sessionId: 's1', index: 0, sections: [{ key: 'a', content: 'v2' }] })],
      }),
    });

    const segRes = await app.request(`${baseUrl()}/v1/sessions/s1/segments/0`);
    const seg = await segRes.json();
    expect(seg.sections).toHaveLength(1);
    expect(seg.sections[0].key).toBe('a');
    expect(seg.sections[0].content).toBe('v2');
    // Since this is the (only) first segment, it should still read as 'added', not 'changed'.
    expect(seg.sections[0].state).toBe('added');
  });

  it('auto-creates a stub session when segment.recorded references an unknown sessionId', async () => {
    const res = await app.request(`${baseUrl()}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [makeSegmentEvent({ id: 'seg-0', sessionId: 'ghost-session', index: 0, sections: [{ key: 'a', content: 'x' }] })],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1 });

    const detailRes = await app.request(`${baseUrl()}/v1/sessions/ghost-session`);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.id).toBe('ghost-session');
    expect(detail.segments).toHaveLength(1);
  });

  it('partially accepts a batch, reporting rejected indexes with reasons', async () => {
    const res = await app.request(`${baseUrl()}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [
          { type: 'session.started', data: { id: 's1', name: 'ok', startedAt: new Date(2026, 0, 1).toISOString() } },
          { type: 'session.started', data: { name: 'missing id' } }, // bad: no id
          makeSegmentEvent({ id: 'seg-0', sessionId: 's1', index: 0, sections: [{ key: 'a', content: 'ok' }] }),
          makeSegmentEvent({ id: 'seg-1', sessionId: 's1', index: -1, sections: [{ key: 'a', content: 'ok' }] }), // bad: negative index
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(2);
    expect(body.rejected).toHaveLength(2);
    expect(body.rejected.map((r: { index: number }) => r.index)).toEqual([1, 3]);
  });

  it('rejects batches over the 500-event limit', async () => {
    const events = Array.from({ length: 501 }, (_, i) => ({
      type: 'session.started' as const,
      data: { id: `s${i}`, name: `s${i}`, startedAt: new Date(2026, 0, 1).toISOString() },
    }));
    const res = await app.request(`${baseUrl()}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await app.request(`${baseUrl()}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('reports stats', async () => {
    await app.request(`${baseUrl()}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [
          { type: 'session.started', data: { id: 's1', name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() } },
          makeSegmentEvent({ id: 'seg-0', sessionId: 's1', index: 0, sections: [{ key: 'a', content: 'hello' }] }),
        ],
      }),
    });
    const res = await app.request(`${baseUrl()}/v1/stats`);
    const stats = await res.json();
    expect(stats.sessions).toBe(1);
    expect(stats.segments).toBe(1);
    expect(stats.sections).toBe(1);
    expect(stats.totalTokens).toBe(5);
    expect(stats.lastIngestAt).not.toBeNull();
  });

  it('deletes a session and cascades to segments/sections', async () => {
    await app.request(`${baseUrl()}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [
          { type: 'session.started', data: { id: 's1', name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() } },
          makeSegmentEvent({ id: 'seg-0', sessionId: 's1', index: 0, sections: [{ key: 'a', content: 'hello' }] }),
        ],
      }),
    });

    const delRes = await app.request(`${baseUrl()}/v1/sessions/s1`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);

    const getRes = await app.request(`${baseUrl()}/v1/sessions/s1`);
    expect(getRes.status).toBe(404);
    expect(await getRes.json()).toEqual({ error: 'not found' });

    const statsRes = await app.request(`${baseUrl()}/v1/stats`);
    const stats = await statsRes.json();
    expect(stats.segments).toBe(0);
    expect(stats.sections).toBe(0);
  });

  it('returns 404 for unknown sessions, traces, and segments', async () => {
    expect((await app.request(`${baseUrl()}/v1/sessions/nope`)).status).toBe(404);
    expect((await app.request(`${baseUrl()}/v1/sessions/nope/trace`)).status).toBe(404);
    expect((await app.request(`${baseUrl()}/v1/sessions/nope/segments/0`)).status).toBe(404);
    expect((await app.request(`${baseUrl()}/v1/sessions/nope`, { method: 'DELETE' })).status).toBe(404);
  });

  it('answers /healthz without auth even when an API key is configured', async () => {
    const keyedApp = createApp(openDb(':memory:'), { apiKey: 'secret' });
    const res = await keyedApp.request(`${baseUrl()}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  describe('auth', () => {
    it('is open when CT_API_KEY is unset', async () => {
      const res = await app.request(`${baseUrl()}/v1/stats`);
      expect(res.status).toBe(200);
    });

    it('returns 401 when a key is required and missing or wrong', async () => {
      const keyedApp = createApp(openDb(':memory:'), { apiKey: 'secret' });

      const missing = await keyedApp.request(`${baseUrl()}/v1/stats`);
      expect(missing.status).toBe(401);

      const wrong = await keyedApp.request(`${baseUrl()}/v1/stats`, { headers: { 'x-api-key': 'wrong' } });
      expect(wrong.status).toBe(401);
    });

    it('returns 200 when the correct key is provided', async () => {
      const keyedApp = createApp(openDb(':memory:'), { apiKey: 'secret' });
      const res = await keyedApp.request(`${baseUrl()}/v1/stats`, { headers: { 'x-api-key': 'secret' } });
      expect(res.status).toBe(200);
    });
  });
});
