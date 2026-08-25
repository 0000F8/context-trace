import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import type { IngestEvent, IngestResponse } from '@context-trace/types';
import type { Db } from './db.js';
import * as store from './store.js';

const MAX_BATCH = 500;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const SESSION_KINDS = new Set(['llm_call', 'turn', 'custom']);
const SERVICE_KINDS = new Set(['system', 'memory', 'retrieval', 'tool', 'history', 'user', 'other']);
const SECTION_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

export interface AppOptions {
  apiKey?: string;
  corsOrigin?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validates one raw ingest event; returns a rejection reason, or null if valid. */
function validateEvent(raw: unknown): string | null {
  if (!isRecord(raw)) return 'event must be an object';
  const type = raw.type;
  if (type !== 'session.started' && type !== 'segment.recorded' && type !== 'session.ended') {
    return `unknown event type: ${String(type)}`;
  }
  const data = raw.data;
  if (!isRecord(data)) return 'event.data must be an object';

  if (type === 'session.started') {
    if (typeof data.id !== 'string' || data.id.length === 0) return 'session.id is required';
    if (typeof data.name !== 'string' || data.name.length === 0) return 'session.name is required';
    if (typeof data.startedAt !== 'string' || data.startedAt.length === 0) return 'session.startedAt is required';
    if (data.agent !== undefined && typeof data.agent !== 'string') return 'session.agent must be a string';
    return null;
  }

  if (type === 'session.ended') {
    if (typeof data.sessionId !== 'string' || data.sessionId.length === 0) return 'sessionId is required';
    if (typeof data.endedAt !== 'string' || data.endedAt.length === 0) return 'endedAt is required';
    return null;
  }

  // segment.recorded
  if (typeof data.id !== 'string' || data.id.length === 0) return 'segment.id is required';
  if (typeof data.sessionId !== 'string' || data.sessionId.length === 0) return 'segment.sessionId is required';
  if (typeof data.index !== 'number' || !Number.isFinite(data.index) || data.index < 0) {
    return 'segment.index must be a number >= 0';
  }
  if (typeof data.kind !== 'string' || !SESSION_KINDS.has(data.kind)) return 'segment.kind is invalid';
  if (typeof data.timestamp !== 'string' || data.timestamp.length === 0) return 'segment.timestamp is required';
  if (!Array.isArray(data.sections)) return 'segment.sections must be an array';

  for (let i = 0; i < data.sections.length; i++) {
    const section = data.sections[i];
    if (!isRecord(section)) return `sections[${i}] must be an object`;
    if (typeof section.key !== 'string' || section.key.length === 0) return `sections[${i}].key is required`;
    if (typeof section.service !== 'string' || section.service.length === 0) {
      return `sections[${i}].service is required`;
    }
    if (typeof section.serviceKind !== 'string' || !SERVICE_KINDS.has(section.serviceKind)) {
      return `sections[${i}].serviceKind is invalid`;
    }
    if (typeof section.position !== 'number' || !Number.isFinite(section.position) || section.position < 0) {
      return `sections[${i}].position must be a number >= 0`;
    }
    if (section.content !== undefined && typeof section.content !== 'string') {
      return `sections[${i}].content must be a string`;
    }
    if (section.role !== undefined && !SECTION_ROLES.has(section.role as string)) {
      return `sections[${i}].role is invalid`;
    }
    if (section.tokens !== undefined && typeof section.tokens !== 'number') {
      return `sections[${i}].tokens must be a number`;
    }
  }

  return null;
}

function applyEvent(db: Db, event: IngestEvent): void {
  if (event.type === 'session.started') {
    store.upsertSession(db, event.data);
  } else if (event.type === 'segment.recorded') {
    store.upsertSegment(db, event.data);
  } else {
    store.endSession(db, event.data.sessionId, event.data.endedAt);
  }
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Builds the Hono app for the trace server, wired to `db`. */
export function createApp(db: Db, opts: AppOptions = {}): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.use('/v1/*', cors({ origin: opts.corsOrigin ?? '*' }));

  app.use('/v1/*', async (c, next) => {
    if (opts.apiKey) {
      const key = c.req.header('x-api-key');
      if (key !== opts.apiKey) {
        return c.json({ error: 'unauthorized' }, 401);
      }
    }
    await next();
  });

  app.post(
    '/v1/ingest',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: 'payload too large' }, 413),
    }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'malformed JSON body' }, 400);
      }

      if (!isRecord(body) || !Array.isArray(body.events)) {
        return c.json({ error: 'body must be { events: Event[] }' }, 400);
      }

      const events = body.events;
      if (events.length > MAX_BATCH) {
        return c.json({ error: `batch exceeds max size of ${MAX_BATCH}` }, 400);
      }

      let accepted = 0;
      const rejected: Array<{ index: number; reason: string }> = [];

      for (let i = 0; i < events.length; i++) {
        const reason = validateEvent(events[i]);
        if (reason) {
          rejected.push({ index: i, reason });
          continue;
        }
        try {
          applyEvent(db, events[i] as IngestEvent);
          accepted++;
        } catch (err) {
          rejected.push({ index: i, reason: err instanceof Error ? err.message : 'unknown error' });
        }
      }

      const response: IngestResponse = rejected.length > 0 ? { accepted, rejected } : { accepted };
      return c.json(response, 200);
    }
  );

  app.get('/v1/stats', (c) => c.json(store.getStats(db)));

  app.get('/v1/sessions', (c) => {
    const limit = clampInt(c.req.query('limit'), 20, 1, 200);
    const offset = clampInt(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const q = c.req.query('q');
    const result = store.listSessions(db, { limit, offset, q: q && q.length > 0 ? q : undefined });
    return c.json(result);
  });

  app.get('/v1/sessions/:id', (c) => {
    const detail = store.getSessionDetail(db, c.req.param('id'));
    if (!detail) return c.json({ error: 'not found' }, 404);
    return c.json(detail);
  });

  app.get('/v1/sessions/:id/trace', (c) => {
    const trace = store.getSessionTrace(db, c.req.param('id'));
    if (!trace) return c.json({ error: 'not found' }, 404);
    return c.json(trace);
  });

  app.get('/v1/sessions/:id/segments/:index', (c) => {
    const idx = Number.parseInt(c.req.param('index'), 10);
    if (!Number.isFinite(idx)) return c.json({ error: 'not found' }, 404);
    const detail = store.getSegmentDetail(db, c.req.param('id'), idx);
    if (!detail) return c.json({ error: 'not found' }, 404);
    return c.json(detail);
  });

  app.delete('/v1/sessions/:id', (c) => {
    const deleted = store.deleteSession(db, c.req.param('id'));
    if (!deleted) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  return app;
}
