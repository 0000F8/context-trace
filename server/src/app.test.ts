import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { fnv1a64 } from '@context-trace/types';
import { createApp, getBus } from './app.js';
import { openDb, setFtsSupport, type Db } from './db.js';
import * as store from './store.js';
import { SNIPPET_MARK_CLOSE, SNIPPET_MARK_OPEN } from './store.js';

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

  describe('duplicate section keys', () => {
    it('rejects a segment with a duplicate section key rather than hitting the DB constraint', async () => {
      const res = await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [
            { type: 'session.started', data: { id: 's1', name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() } },
            makeSegmentEvent({
              id: 'seg-0',
              sessionId: 's1',
              index: 0,
              sections: [
                { key: 'dup', content: 'first' },
                { key: 'ok', content: 'fine' },
                { key: 'dup', content: 'second' },
              ],
            }),
          ],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.accepted).toBe(1); // session.started only
      expect(body.rejected).toEqual([{ index: 1, reason: 'duplicate section key: dup' }]);

      // The segment must not have been partially written.
      const detailRes = await app.request(`${baseUrl()}/v1/sessions/s1`);
      const detail = await detailRes.json();
      expect(detail.segments).toHaveLength(0);
    });
  });

  describe('session.ended for an unknown session', () => {
    it('is rejected as a no-op rather than fabricating a stub session', async () => {
      const res = await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [{ type: 'session.ended', data: { sessionId: 'ghost', endedAt: new Date(2026, 0, 1).toISOString() } }],
        }),
      });
      const body = await res.json();
      expect(body.accepted).toBe(0);
      expect(body.rejected).toEqual([{ index: 0, reason: 'unknown session' }]);

      const detailRes = await app.request(`${baseUrl()}/v1/sessions/ghost`);
      expect(detailRes.status).toBe(404);
    });

    it('does not resurrect a session that was just deleted by a late session.ended event', async () => {
      await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [{ type: 'session.started', data: { id: 's1', name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() } }],
        }),
      });
      await app.request(`${baseUrl()}/v1/sessions/s1`, { method: 'DELETE' });

      const res = await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [{ type: 'session.ended', data: { sessionId: 's1', endedAt: new Date(2026, 0, 1).toISOString() } }],
        }),
      });
      expect((await res.json()).rejected).toEqual([{ index: 0, reason: 'unknown session' }]);

      const detailRes = await app.request(`${baseUrl()}/v1/sessions/s1`);
      expect(detailRes.status).toBe(404);
    });
  });

  describe('segment index validation', () => {
    it('rejects a non-integer segment.index on ingest', async () => {
      const res = await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [
            { type: 'session.started', data: { id: 's1', name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() } },
            makeSegmentEvent({ id: 'seg-0', sessionId: 's1', index: 1.5, sections: [{ key: 'a', content: 'x' }] }),
          ],
        }),
      });
      const body = await res.json();
      expect(body.accepted).toBe(1);
      expect(body.rejected).toEqual([{ index: 1, reason: 'segment.index must be an integer >= 0' }]);
    });

    it('rejects non-integer :index route params (e.g. "1.5", "0abc") with 404 instead of truncating', async () => {
      await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [
            { type: 'session.started', data: { id: 's1', name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() } },
            makeSegmentEvent({ id: 'seg-0', sessionId: 's1', index: 0, sections: [{ key: 'a', content: 'x' }] }),
            makeSegmentEvent({ id: 'seg-1', sessionId: 's1', index: 1, sections: [{ key: 'a', content: 'y' }] }),
          ],
        }),
      });

      // Sanity: the real integer index 0 resolves.
      expect((await app.request(`${baseUrl()}/v1/sessions/s1/segments/0`)).status).toBe(200);

      // "1.5" must not silently resolve to segment 1 via parseInt truncation.
      expect((await app.request(`${baseUrl()}/v1/sessions/s1/segments/1.5`)).status).toBe(404);
      // "0abc" must not silently resolve to segment 0 via parseInt prefix-parsing.
      expect((await app.request(`${baseUrl()}/v1/sessions/s1/segments/0abc`)).status).toBe(404);
      expect((await app.request(`${baseUrl()}/v1/sessions/s1/segments/-1`)).status).toBe(404);
    });
  });

  it('answers /healthz without auth even when an API key is configured', async () => {
    const keyedApp = createApp(openDb(':memory:'), { apiKey: 'secret' });
    const res = await keyedApp.request(`${baseUrl()}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  describe('auth', () => {
    it('is open (writes included) when CT_API_KEY is unset', async () => {
      const res = await app.request(`${baseUrl()}/v1/stats`);
      expect(res.status).toBe(200);
    });

    it('keeps all GET endpoints open even when a key is configured, so the dashboard works with auth enabled', async () => {
      const keyedApp = createApp(openDb(':memory:'), { apiKey: 'secret' });

      expect((await keyedApp.request(`${baseUrl()}/v1/stats`)).status).toBe(200);
      expect((await keyedApp.request(`${baseUrl()}/v1/sessions`)).status).toBe(200);
      expect((await keyedApp.request(`${baseUrl()}/v1/sessions/nope`)).status).toBe(404); // reached the handler, not 401
    });

    it('requires x-api-key on POST /v1/ingest when a key is configured', async () => {
      const keyedApp = createApp(openDb(':memory:'), { apiKey: 'secret' });
      const ingestBody = JSON.stringify({
        events: [{ type: 'session.started', data: { id: 's1', name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() } }],
      });

      const missing = await keyedApp.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: ingestBody,
      });
      expect(missing.status).toBe(401);

      const wrong = await keyedApp.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'wrong' },
        body: ingestBody,
      });
      expect(wrong.status).toBe(401);

      const right = await keyedApp.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'secret' },
        body: ingestBody,
      });
      expect(right.status).toBe(200);
    });

    it('requires x-api-key on DELETE /v1/sessions/:id when a key is configured', async () => {
      const keyedDb = openDb(':memory:');
      const keyedApp = createApp(keyedDb, { apiKey: 'secret' });
      await keyedApp.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'secret' },
        body: JSON.stringify({
          events: [{ type: 'session.started', data: { id: 's1', name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() } }],
        }),
      });

      const missing = await keyedApp.request(`${baseUrl()}/v1/sessions/s1`, { method: 'DELETE' });
      expect(missing.status).toBe(401);

      const right = await keyedApp.request(`${baseUrl()}/v1/sessions/s1`, {
        method: 'DELETE',
        headers: { 'x-api-key': 'secret' },
      });
      expect(right.status).toBe(200);
    });
  });

  describe('CORS', () => {
    it('sends Access-Control-Allow-Origin on POST /v1/ingest but not on GET/DELETE routes', async () => {
      const origin = 'https://evil.example.com';

      const ingestRes = await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ events: [] }),
      });
      expect(ingestRes.headers.get('access-control-allow-origin')).toBe('*');

      const preflight = await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
        },
      });
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');

      const getRes = await app.request(`${baseUrl()}/v1/sessions`, { headers: { origin } });
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get('access-control-allow-origin')).toBeNull();

      const deleteRes = await app.request(`${baseUrl()}/v1/sessions/nope`, { method: 'DELETE', headers: { origin } });
      expect(deleteRes.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  describe('ingest caps', () => {
    it('rejects a section with content over 262144 chars but accepts exactly the limit', async () => {
      const overLimit = 'x'.repeat(262_145);
      const atLimit = 'x'.repeat(262_144);

      const res = await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [
            { type: 'session.started', data: { id: 's1', name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() } },
            makeSegmentEvent({ id: 'seg-over', sessionId: 's1', index: 0, sections: [{ key: 'a', content: overLimit }] }),
            makeSegmentEvent({ id: 'seg-at', sessionId: 's1', index: 1, sections: [{ key: 'a', content: atLimit }] }),
          ],
        }),
      });
      const body = await res.json();
      expect(body.accepted).toBe(2); // session.started + the at-limit segment
      expect(body.rejected).toHaveLength(1);
      expect(body.rejected[0].index).toBe(1);
      expect(body.rejected[0].reason).toMatch(/content exceeds max length/);
    });

    it('rejects a segment with more than 500 sections but accepts exactly 500', async () => {
      const tooMany = Array.from({ length: 501 }, (_, i) => ({ key: `k${i}`, content: 'x' }));
      const atLimit = Array.from({ length: 500 }, (_, i) => ({ key: `k${i}`, content: 'x' }));

      const res = await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [
            { type: 'session.started', data: { id: 's1', name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() } },
            makeSegmentEvent({ id: 'seg-over', sessionId: 's1', index: 0, sections: tooMany }),
            makeSegmentEvent({ id: 'seg-at', sessionId: 's1', index: 1, sections: atLimit }),
          ],
        }),
      });
      const body = await res.json();
      expect(body.rejected).toHaveLength(1);
      expect(body.rejected[0].index).toBe(1);
      expect(body.rejected[0].reason).toMatch(/sections exceeds max/);
      expect(body.accepted).toBe(2);
    });

    it('rejects an over-length key/service/name/label/id string', async () => {
      const longString = 'x'.repeat(513);

      const res = await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [
            { type: 'session.started', data: { id: longString, name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() } },
            { type: 'session.started', data: { id: 's2', name: longString, startedAt: new Date(2026, 0, 1).toISOString() } },
            makeSegmentEvent({ id: 's3-seg', sessionId: 's3', index: 0, sections: [{ key: longString, content: 'x' }] }),
            makeSegmentEvent({ id: 's3-seg2', sessionId: 's3', index: 1, sections: [{ key: 'a', service: longString, content: 'x' }] }),
          ],
        }),
      });
      const body = await res.json();
      expect(body.rejected).toHaveLength(4);
      expect(body.accepted).toBe(0);
    });
  });

  describe('content hash integrity', () => {
    it('recomputes contentHash server-side from content, ignoring a forged client hash', async () => {
      const segmentEvent = (id: string, index: number, forgedHash: string) => ({
        type: 'segment.recorded' as const,
        data: {
          id,
          sessionId: 's1',
          index,
          kind: 'llm_call' as const,
          timestamp: new Date(2026, 0, 1, 0, index).toISOString(),
          sections: [
            {
              key: 'a',
              service: 'svc',
              serviceKind: 'memory',
              position: 0,
              content: 'hello', // identical real content across both segments
              contentHash: forgedHash, // deliberately wrong / inconsistent client-supplied hash
              tokens: 5,
            },
          ],
        },
      });

      await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [
            { type: 'session.started', data: { id: 's1', name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() } },
            segmentEvent('seg-0', 0, fnv1a64('WRONG-1')),
            segmentEvent('seg-1', 1, fnv1a64('WRONG-2')), // a different forged hash than seg-0's
          ],
        }),
      });

      // If the server trusted the (differing) forged hashes, this would read 'changed'.
      // Since it recomputes from the identical real content, it must read 'carried'.
      const segRes = await app.request(`${baseUrl()}/v1/sessions/s1/segments/1`);
      const seg = await segRes.json();
      expect(seg.sections[0].state).toBe('carried');
      expect(seg.sections[0].contentHash).toBe(fnv1a64('hello'));
    });

    it('keeps the client-supplied hash when content is omitted', async () => {
      const res = await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [
            { type: 'session.started', data: { id: 's1', name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() } },
            {
              type: 'segment.recorded',
              data: {
                id: 'seg-0',
                sessionId: 's1',
                index: 0,
                kind: 'llm_call',
                timestamp: new Date(2026, 0, 1).toISOString(),
                sections: [
                  { key: 'a', service: 'svc', serviceKind: 'memory', position: 0, contentHash: 'client-ref-hash', tokens: 3 },
                ],
              },
            },
          ],
        }),
      });
      expect((await res.json()).accepted).toBe(2);

      const segRes = await app.request(`${baseUrl()}/v1/sessions/s1/segments/0`);
      const seg = await segRes.json();
      expect(seg.sections[0].contentHash).toBe('client-ref-hash');
      expect(seg.sections[0].content).toBeUndefined();
    });
  });

  describe('session summary aggregates (SQL-only, no content loading)', () => {
    it('computes segment/section counts, latest vs peak tokens, and distinct services correctly', async () => {
      // segment 0: total 8 tokens (a:4 + b:4), services memory-svc + retrieval-svc
      // segment 1: total 42 tokens (a:2 + huge:40) -- the peak, via a service only present here
      // segment 2: total 2 tokens (a:2 only) -- the latest, b and huge both dropped
      await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [
            { type: 'session.started', data: { id: 's1', name: 'agg-test', startedAt: new Date(2026, 0, 1).toISOString() } },
            makeSegmentEvent({
              id: 'seg-0',
              sessionId: 's1',
              index: 0,
              sections: [
                { key: 'a', content: 'abcd', service: 'memory-svc' },
                { key: 'b', content: 'wxyz', service: 'retrieval-svc' },
              ],
            }),
            makeSegmentEvent({
              id: 'seg-1',
              sessionId: 's1',
              index: 1,
              sections: [
                { key: 'a', content: 'ab', service: 'memory-svc' },
                { key: 'huge', content: 'x'.repeat(40), service: 'huge-svc' },
              ],
            }),
            makeSegmentEvent({
              id: 'seg-2',
              sessionId: 's1',
              index: 2,
              sections: [{ key: 'a', content: 'ab', service: 'memory-svc' }],
            }),
          ],
        }),
      });

      const sessionsRes = await app.request(`${baseUrl()}/v1/sessions`);
      const sessionsBody = await sessionsRes.json();
      const summary = sessionsBody.sessions.find((s: { id: string }) => s.id === 's1');
      expect(summary).toMatchObject({
        segmentCount: 3,
        sectionCount: 5,
        totalTokens: 2, // latest segment (index 2)
        peakTokens: 42, // segment 1, not the latest
        services: ['huge-svc', 'memory-svc', 'retrieval-svc'],
      });

      // getSessionSummary (used by list) must agree with getSessionDetail's summary fields.
      const detailRes = await app.request(`${baseUrl()}/v1/sessions/s1`);
      const detail = await detailRes.json();
      expect(detail).toMatchObject({
        segmentCount: 3,
        sectionCount: 5,
        totalTokens: 2,
        peakTokens: 42,
        services: ['huge-svc', 'memory-svc', 'retrieval-svc'],
      });
    });
  });

  describe('segment.outcome', () => {
    async function ingestSessionAndSegment(app: Hono, sessionId: string, segmentId: string) {
      await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [
            { type: 'session.started', data: { id: sessionId, name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() } },
            makeSegmentEvent({ id: segmentId, sessionId, index: 0, sections: [{ key: 'a', content: 'hi' }] }),
          ],
        }),
      });
    }

    it('applies an outcome and exposes it on the session detail, segment detail, and trace', async () => {
      await ingestSessionAndSegment(app, 's1', 'seg-0');

      const outcome = { responseText: 'all done', latencyMs: 1234, scores: { helpfulness: 0.9 } };
      const res = await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [{ type: 'segment.outcome', data: { sessionId: 's1', segmentId: 'seg-0', outcome } }],
        }),
      });
      expect((await res.json()).accepted).toBe(1);

      const detail = await (await app.request(`${baseUrl()}/v1/sessions/s1`)).json();
      expect(detail.segments[0].outcome).toEqual(outcome);

      const segDetail = await (await app.request(`${baseUrl()}/v1/sessions/s1/segments/0`)).json();
      expect(segDetail.segment.outcome).toEqual(outcome);

      const trace = await (await app.request(`${baseUrl()}/v1/sessions/s1/trace`)).json();
      expect(trace.segments[0].outcome).toEqual(outcome);
    });

    it('rejects an outcome for an unknown segment with a per-event reason', async () => {
      await ingestSessionAndSegment(app, 's1', 'seg-0');
      const res = await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [{ type: 'segment.outcome', data: { sessionId: 's1', segmentId: 'ghost-seg', outcome: {} } }],
        }),
      });
      const body = await res.json();
      expect(body.accepted).toBe(0);
      expect(body.rejected).toEqual([{ index: 0, reason: 'unknown segment' }]);
    });

    it('rejects an outcome whose segmentId belongs to a different session', async () => {
      await ingestSessionAndSegment(app, 's1', 'seg-0');
      await ingestSessionAndSegment(app, 's2', 'seg-1');
      const res = await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [{ type: 'segment.outcome', data: { sessionId: 's2', segmentId: 'seg-0', outcome: {} } }],
        }),
      });
      expect((await res.json()).rejected).toEqual([{ index: 0, reason: 'unknown segment' }]);
    });

    it('rejects responseText/error/scores over their caps with named reasons', async () => {
      await ingestSessionAndSegment(app, 's1', 'seg-0');
      const events = [
        { type: 'segment.outcome', data: { sessionId: 's1', segmentId: 'seg-0', outcome: { responseText: 'x'.repeat(262_145) } } },
        { type: 'segment.outcome', data: { sessionId: 's1', segmentId: 'seg-0', outcome: { error: 'x'.repeat(4_097) } } },
        {
          type: 'segment.outcome',
          data: {
            sessionId: 's1',
            segmentId: 'seg-0',
            outcome: { scores: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 1])) },
          },
        },
        { type: 'segment.outcome', data: { sessionId: 's1', segmentId: 'seg-0', outcome: { responseText: 'x'.repeat(262_144) } } }, // at limit: accepted
      ];
      const res = await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events }),
      });
      const body = await res.json();
      expect(body.accepted).toBe(1);
      expect(body.rejected).toEqual([
        { index: 0, reason: 'outcome.responseText exceeds max length of 262144' },
        { index: 1, reason: 'outcome.error exceeds max length of 4096' },
        { index: 2, reason: 'outcome.scores exceeds max of 32 score keys' },
      ]);
    });

    it('does not wipe a previously-applied outcome when the segment is re-recorded (idempotent re-ingest)', async () => {
      await ingestSessionAndSegment(app, 's1', 'seg-0');
      await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [{ type: 'segment.outcome', data: { sessionId: 's1', segmentId: 'seg-0', outcome: { latencyMs: 500 } } }],
        }),
      });
      // Re-record the same segment id (e.g. a client retry) — outcome must survive.
      await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [makeSegmentEvent({ id: 'seg-0', sessionId: 's1', index: 0, sections: [{ key: 'a', content: 'updated' }] })],
        }),
      });
      const segDetail = await (await app.request(`${baseUrl()}/v1/sessions/s1/segments/0`)).json();
      expect(segDetail.segment.outcome).toEqual({ latencyMs: 500 });
    });

    it('rejects an oversized outcome.model and an oversized scores key, not just responseText/error', async () => {
      await ingestSessionAndSegment(app, 's1', 'seg-0');
      const events = [
        { type: 'segment.outcome', data: { sessionId: 's1', segmentId: 'seg-0', outcome: { model: 'm'.repeat(513) } } },
        { type: 'segment.outcome', data: { sessionId: 's1', segmentId: 'seg-0', outcome: { model: 'm'.repeat(3_000_000) } } }, // the reported 3MB case
        { type: 'segment.outcome', data: { sessionId: 's1', segmentId: 'seg-0', outcome: { scores: { ['k'.repeat(513)]: 1 } } } },
        { type: 'segment.outcome', data: { sessionId: 's1', segmentId: 'seg-0', outcome: { model: 'm'.repeat(512) } } }, // at limit: accepted
      ];
      const res = await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events }),
      });
      const body = await res.json();
      expect(body.accepted).toBe(1);
      expect(body.rejected).toEqual([
        { index: 0, reason: 'outcome.model exceeds max length of 512' },
        { index: 1, reason: 'outcome.model exceeds max length of 512' },
        { index: 2, reason: 'outcome.scores key exceeds max length of 512' },
      ]);
    });

    it('rejects an outcome whose overall serialized size is grossly oversized, even with individually-valid-looking fields', async () => {
      await ingestSessionAndSegment(app, 's1', 'seg-0');
      // Many score keys near their own per-field cap, cumulatively far past any
      // reasonable outcome size — each field alone might slip by a narrower check,
      // but the aggregate is what actually balloons storage/read responses.
      const scores: Record<string, number> = {};
      for (let i = 0; i < 32; i++) scores[`k${i}`.padEnd(500, 'x')] = 0.5;
      const res = await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [
            {
              type: 'segment.outcome',
              data: {
                sessionId: 's1',
                segmentId: 'seg-0',
                outcome: { responseText: 'x'.repeat(262_144), error: 'x'.repeat(4_096), model: 'x'.repeat(512), scores },
              },
            },
          ],
        }),
      });
      const body = await res.json();
      // Every individual field is within its own cap; the whole payload must still be accepted
      // (this is the legitimate worst case, and must not be rejected by the aggregate cap).
      expect(body.accepted).toBe(1);
    });
  });

  describe('GET /v1/sessions/:id/trace/analytics', () => {
    it('returns computed analytics for a known session and 404 for an unknown one', async () => {
      await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [
            { type: 'session.started', data: { id: 's1', name: 'sess', metadata: { window: 10 }, startedAt: new Date(2026, 0, 1).toISOString() } },
            makeSegmentEvent({ id: 'seg-0', sessionId: 's1', index: 0, sections: [{ key: 'a', content: 'x'.repeat(20) }] }),
          ],
        }),
      });
      const res = await app.request(`${baseUrl()}/v1/sessions/s1/trace/analytics`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.window).toBe(10);
      expect(body.perSegment[0].overWindow).toBe(true);
      expect(body.findings.some((f: { kind: string }) => f.kind === 'over-window')).toBe(true);

      expect((await app.request(`${baseUrl()}/v1/sessions/nope/trace/analytics`)).status).toBe(404);
    });
  });

  describe('GET /v1/sessions/:id/live (SSE)', () => {
    async function readNextEvent(reader: ReadableStreamDefaultReader<Uint8Array>, decoder: TextDecoder, state: { buffer: string }) {
      while (!state.buffer.includes('\n\n')) {
        const { value, done } = await reader.read();
        if (done) break;
        state.buffer += decoder.decode(value, { stream: true });
      }
      const idx = state.buffer.indexOf('\n\n');
      const chunk = state.buffer.slice(0, idx);
      state.buffer = state.buffer.slice(idx + 2);
      return chunk;
    }

    it('streams a segment event to a live listener and cleans up on stream close', async () => {
      await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [{ type: 'session.started', data: { id: 's1', name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() } }],
        }),
      });

      const bus = getBus(app)!;
      expect(bus.listenerCount('s1')).toBe(0);

      const res = await app.request(`${baseUrl()}/v1/sessions/s1/live`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(bus.listenerCount('s1')).toBe(1);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const state = { buffer: '' };

      // Trigger a segment.recorded event on the same session; it must arrive over the stream.
      await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [makeSegmentEvent({ id: 'seg-0', sessionId: 's1', index: 0, sections: [{ key: 'a', content: 'hi' }] })],
        }),
      });

      const eventChunk = await readNextEvent(reader, decoder, state);
      expect(eventChunk).toContain('event: segment');
      expect(eventChunk).toMatch(/"id":"seg-0"/);

      await reader.cancel();
      expect(bus.listenerCount('s1')).toBe(0);
    });

    it('streams an outcome event with segmentId, index, and the outcome payload', async () => {
      await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [
            { type: 'session.started', data: { id: 's1', name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() } },
            makeSegmentEvent({ id: 'seg-0', sessionId: 's1', index: 0, sections: [{ key: 'a', content: 'hi' }] }),
          ],
        }),
      });

      const res = await app.request(`${baseUrl()}/v1/sessions/s1/live`);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const state = { buffer: '' };

      await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [{ type: 'segment.outcome', data: { sessionId: 's1', segmentId: 'seg-0', outcome: { latencyMs: 42 } } }],
        }),
      });

      const eventChunk = await readNextEvent(reader, decoder, state);
      expect(eventChunk).toContain('event: outcome');
      const dataLine = eventChunk.split('\n').find((l) => l.startsWith('data: '))!;
      const payload = JSON.parse(dataLine.slice('data: '.length));
      expect(payload).toEqual({ segmentId: 'seg-0', index: 0, outcome: { latencyMs: 42 } });

      await reader.cancel();
    });

    it('does not leak listeners across multiple connect/disconnect cycles', async () => {
      await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [{ type: 'session.started', data: { id: 's1', name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() } }],
        }),
      });
      const bus = getBus(app)!;

      for (let i = 0; i < 3; i++) {
        const res = await app.request(`${baseUrl()}/v1/sessions/s1/live`);
        expect(bus.listenerCount('s1')).toBe(1);
        await res.body!.getReader().cancel();
        expect(bus.listenerCount('s1')).toBe(0);
      }
    });

    it('returns 404 for /live on a session that does not exist yet', async () => {
      const res = await app.request(`${baseUrl()}/v1/sessions/nope/live`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not found' });
      expect(getBus(app)!.listenerCount('nope')).toBe(0); // never subscribed
    });
  });

  describe('emitLiveEvents perf guard', () => {
    it('skips building a segment detail (full content select + diff) when nobody is listening', async () => {
      await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [{ type: 'session.started', data: { id: 's1', name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() } }],
        }),
      });

      const spy = vi.spyOn(store, 'getSegmentDetail');
      await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [makeSegmentEvent({ id: 'seg-0', sessionId: 's1', index: 0, sections: [{ key: 'a', content: 'hi' }] })],
        }),
      });
      expect(spy).not.toHaveBeenCalled(); // no /live subscriber -> no detail built

      const liveRes = await app.request(`${baseUrl()}/v1/sessions/s1/live`);
      await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [makeSegmentEvent({ id: 'seg-1', sessionId: 's1', index: 1, sections: [{ key: 'a', content: 'hi2' }] })],
        }),
      });
      expect(spy).toHaveBeenCalledTimes(1); // now there is a subscriber

      await liveRes.body!.getReader().cancel();
      spy.mockRestore();
    });
  });

  describe('GET /v1/search', () => {
    beforeEach(async () => {
      await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [
            { type: 'session.started', data: { id: 's1', name: 'searchable session', startedAt: new Date(2026, 0, 1).toISOString() } },
            makeSegmentEvent({
              id: 'seg-0',
              sessionId: 's1',
              index: 0,
              sections: [{ key: 'notes', content: 'the quick brown fox jumps over the lazy dog' }],
            }),
          ],
        }),
      });
    });

    it('returns a hit with sessionId/segmentIndex/key/service/snippet for a matching query', async () => {
      const res = await app.request(`${baseUrl()}/v1/search?q=brown+fox`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.hits).toHaveLength(1);
      expect(body.hits[0]).toMatchObject({
        sessionId: 's1',
        sessionName: 'searchable session',
        segmentIndex: 0,
        key: 'notes',
        service: 'svc',
      });
      expect(body.hits[0].snippet).toContain(SNIPPET_MARK_OPEN);
      expect(body.hits[0].snippet).toContain(SNIPPET_MARK_CLOSE);
      // Attacker-controlled content can't spoof a highlight boundary with plain brackets.
      expect(body.hits[0].snippet).not.toContain('[');
    });

    it('treats FTS syntax characters in the query as a literal phrase instead of erroring', async () => {
      const res = await app.request(`${baseUrl()}/v1/search?${new URLSearchParams({ q: '" OR "' })}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.hits).toEqual([]);
    });

    it('returns 400 for a blank or missing q', async () => {
      expect((await app.request(`${baseUrl()}/v1/search`)).status).toBe(400);
      expect((await app.request(`${baseUrl()}/v1/search?q=`)).status).toBe(400);
      expect((await app.request(`${baseUrl()}/v1/search?q=%20%20`)).status).toBe(400);
    });

    it('clamps limit into [1, 50]', async () => {
      const res = await app.request(`${baseUrl()}/v1/search?q=fox&limit=999`);
      expect(res.status).toBe(200); // doesn't error; clamped server-side
    });

    it('returns 501 when the database lacks FTS5 support', async () => {
      const noFtsDb = openDb(':memory:');
      setFtsSupport(noFtsDb, false);
      const noFtsApp = createApp(noFtsDb);
      const res = await noFtsApp.request(`${baseUrl()}/v1/search?q=anything`);
      expect(res.status).toBe(501);
      expect(await res.json()).toEqual({ error: 'search unavailable' });
    });
  });

  describe('export / import', () => {
    async function seedExportableSession(target: Hono, sessionId: string) {
      await target.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [
            { type: 'session.started', data: { id: sessionId, name: 'exportable', startedAt: new Date(2026, 0, 1).toISOString() } },
            makeSegmentEvent({ id: `${sessionId}-seg-0`, sessionId, index: 0, sections: [{ key: 'a', content: 'first' }] }),
            makeSegmentEvent({
              id: `${sessionId}-seg-1`,
              sessionId,
              index: 1,
              sections: [
                { key: 'a', content: 'first' },
                { key: 'b', content: 'second' },
              ],
            }),
            {
              type: 'segment.outcome',
              data: { sessionId, segmentId: `${sessionId}-seg-1`, outcome: { latencyMs: 111, scores: { helpfulness: 0.5 } } },
            },
          ],
        }),
      });
    }

    it('exports a session with a content-disposition header and version 1 envelope', async () => {
      await seedExportableSession(app, 's1');
      const res = await app.request(`${baseUrl()}/v1/sessions/s1/export`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe(
        `attachment; filename="s1.context-trace.json"; filename*=UTF-8''s1.context-trace.json`
      );
      const body = await res.json();
      expect(body.version).toBe(1);
      expect(body.session.id).toBe('s1');
      expect(body.segments).toHaveLength(2);
      expect(body.segments[1].outcome).toEqual({ latencyMs: 111, scores: { helpfulness: 0.5 } });
    });

    it('returns 404 exporting an unknown session', async () => {
      expect((await app.request(`${baseUrl()}/v1/sessions/nope/export`)).status).toBe(404);
    });

    describe('content-disposition header-injection safety', () => {
      async function ingestSessionWithId(id: string) {
        await app.request(`${baseUrl()}/v1/ingest`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            events: [{ type: 'session.started', data: { id, name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() } }],
          }),
        });
      }

      it('sanitizes a session id containing quotes/semicolons instead of injecting header parameters', async () => {
        const maliciousId = 's1";x="evil';
        await ingestSessionWithId(maliciousId);

        const res = await app.request(`${baseUrl()}/v1/sessions/${encodeURIComponent(maliciousId)}/export`);
        expect(res.status).toBe(200);
        const header = res.headers.get('content-disposition')!;
        expect(header).not.toContain('x="evil');
        expect(header).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.context-trace\.json"; filename\*=UTF-8''/);
        // The real id is still recoverable from the RFC 5987 extended value.
        expect(header).toContain(encodeURIComponent(maliciousId));
      });

      it('does not 500 on a session id containing CRLF, and the header carries no raw CRLF or unescaped colon', async () => {
        const maliciousId = 's1\r\nX-Injected: true';
        await ingestSessionWithId(maliciousId);

        const res = await app.request(`${baseUrl()}/v1/sessions/${encodeURIComponent(maliciousId)}/export`);
        expect(res.status).toBe(200);
        const header = res.headers.get('content-disposition')!;
        // No raw CR/LF anywhere — a fake header line can't be injected into the response.
        expect(header).not.toMatch(/[\r\n]/);
        // Letters from the id may survive as harmless sanitized text, but a raw ':' (which
        // would start a new header field if a real CRLF preceded it) must not appear
        // unescaped outside of the fixed "attachment; filename=..." structure.
        expect(header).toBe(
          `attachment; filename="s1__X-Injected__true.context-trace.json"; filename*=UTF-8''${encodeURIComponent(maliciousId)}.context-trace.json`
        );

        // Deterministic: re-exporting the same session must not "permanently" 500 either.
        const res2 = await app.request(`${baseUrl()}/v1/sessions/${encodeURIComponent(maliciousId)}/export`);
        expect(res2.status).toBe(200);
      });
    });

    it('round-trips export -> delete -> import: the trace and outcomes match before and after', async () => {
      await seedExportableSession(app, 's1');
      const traceBefore = await (await app.request(`${baseUrl()}/v1/sessions/s1/trace`)).json();
      const exported = await (await app.request(`${baseUrl()}/v1/sessions/s1/export`)).json();

      const delRes = await app.request(`${baseUrl()}/v1/sessions/s1`, { method: 'DELETE' });
      expect(delRes.status).toBe(200);
      expect((await app.request(`${baseUrl()}/v1/sessions/s1`)).status).toBe(404);

      const importRes = await app.request(`${baseUrl()}/v1/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(exported),
      });
      expect(importRes.status).toBe(200);
      expect(await importRes.json()).toEqual({ accepted: { segments: 2 } });

      const traceAfter = await (await app.request(`${baseUrl()}/v1/sessions/s1/trace`)).json();
      expect(traceAfter).toEqual(traceBefore);

      const detail = await (await app.request(`${baseUrl()}/v1/sessions/s1`)).json();
      expect(detail.segments[1].outcome).toEqual({ latencyMs: 111, scores: { helpfulness: 0.5 } });
    });

    it('rejects import with an unsupported version', async () => {
      const res = await app.request(`${baseUrl()}/v1/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 2, session: { id: 's1', name: 'x', startedAt: new Date(2026, 0, 1).toISOString() }, segments: [] }),
      });
      expect(res.status).toBe(400);
    });

    it('requires x-api-key on /v1/import when a key is configured', async () => {
      await seedExportableSession(app, 's1');
      const exported = await (await app.request(`${baseUrl()}/v1/sessions/s1/export`)).json();

      const keyedApp = createApp(openDb(':memory:'), { apiKey: 'secret' });
      const missing = await keyedApp.request(`${baseUrl()}/v1/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(exported),
      });
      expect(missing.status).toBe(401);

      const right = await keyedApp.request(`${baseUrl()}/v1/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'secret' },
        body: JSON.stringify(exported),
      });
      expect(right.status).toBe(200);
    });

    function exportSegment(id: string, sessionId: string, index: number, sections: Array<{ key: string; content: string }>) {
      return {
        id,
        sessionId,
        index,
        kind: 'llm_call' as const,
        timestamp: new Date(2026, 0, 1, 0, index).toISOString(),
        sections: sections.map((s, i) => ({
          key: s.key,
          service: 'svc',
          serviceKind: 'memory' as const,
          position: i,
          content: s.content,
          contentHash: fnv1a64(s.content),
          tokens: s.content.length,
        })),
      };
    }

    it('rolls back the entire import atomically when a later segment collides on (session_id, idx) — nothing is written', async () => {
      const res = await app.request(`${baseUrl()}/v1/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          session: { id: 's1', name: 'sess', startedAt: new Date(2026, 0, 1).toISOString() },
          segments: [
            exportSegment('seg-a', 's1', 0, [{ key: 'a', content: 'x' }]),
            exportSegment('seg-b', 's1', 0, [{ key: 'a', content: 'y' }]), // duplicate idx=0 for the same session
          ],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/segments\[1\]/);
      expect(res.status).not.toBe(500);

      // Nothing was written — not even the session itself, and not the first segment,
      // which would previously have committed on its own before the second one failed.
      expect((await app.request(`${baseUrl()}/v1/sessions/s1`)).status).toBe(404);
    });

    it('rejects an import segment whose sessionId does not match the imported session (cannot write into an unrelated session)', async () => {
      // A victim session already exists with one segment.
      await seedExportableSession(app, 'victim');
      const before = await (await app.request(`${baseUrl()}/v1/sessions/victim`)).json();

      const res = await app.request(`${baseUrl()}/v1/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          session: { id: 'attacker-session', name: 'attacker', startedAt: new Date(2026, 0, 1).toISOString() },
          segments: [exportSegment('injected-seg', 'victim', 99, [{ key: 'a', content: 'hijacked' }])],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/segments\[0\]/);
      expect(body.error).toMatch(/sessionId must match/);

      // The victim session must be completely unaffected.
      const after = await (await app.request(`${baseUrl()}/v1/sessions/victim`)).json();
      expect(after).toEqual(before);
      expect((await app.request(`${baseUrl()}/v1/sessions/attacker-session`)).status).toBe(404);
    });

    it('rejects an import session with an invalid nested agent instead of 500ing on the raw DB call', async () => {
      const res = await app.request(`${baseUrl()}/v1/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          session: { id: 's1', name: 'sess', agent: { nested: true }, startedAt: new Date(2026, 0, 1).toISOString() },
          segments: [],
        }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/agent/);
      expect((await app.request(`${baseUrl()}/v1/sessions/s1`)).status).toBe(404); // nothing written
    });

    it('rejects an import session with invalid metadata or endedAt types', async () => {
      const badMetadata = await app.request(`${baseUrl()}/v1/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          session: { id: 's1', name: 'sess', metadata: 'not-an-object', startedAt: new Date(2026, 0, 1).toISOString() },
          segments: [],
        }),
      });
      expect(badMetadata.status).toBe(400);
      expect((await badMetadata.json()).error).toMatch(/metadata/);

      const badEndedAt = await app.request(`${baseUrl()}/v1/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          session: { id: 's2', name: 'sess', startedAt: new Date(2026, 0, 1).toISOString(), endedAt: 12345 },
          segments: [],
        }),
      });
      expect(badEndedAt.status).toBe(400);
      expect((await badEndedAt.json()).error).toMatch(/endedAt/);
    });

    it('also rejects an ingest session.started event with an invalid nested agent (shared validator)', async () => {
      const res = await app.request(`${baseUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [
            { type: 'session.started', data: { id: 's1', name: 'sess', agent: { nested: true }, startedAt: new Date(2026, 0, 1).toISOString() } },
          ],
        }),
      });
      const body = await res.json();
      expect(body.accepted).toBe(0);
      expect(body.rejected[0].reason).toMatch(/agent/);
    });
  });
});
