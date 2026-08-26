import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import type { IngestEvent, IngestResponse, SegmentOutcome, SegmentWithSections, Session } from '@context-trace/types';
import type { Db } from './db.js';
import { hasFtsSupport } from './db.js';
import * as store from './store.js';
import { SessionBus } from './bus.js';
import { computeAnalytics } from './trace/analytics.js';

const MAX_BATCH = 500;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_STRING_LEN = 512;
const MAX_CONTENT_LEN = 262_144;
const MAX_SECTIONS_PER_SEGMENT = 500;
const MAX_OUTCOME_RESPONSE_LEN = 262_144;
const MAX_OUTCOME_ERROR_LEN = 4_096;
const MAX_OUTCOME_SCORE_KEYS = 32;
const MAX_METADATA_JSON_BYTES = 64 * 1024;
// Deliberately NOT 64KB: responseText alone is already spec'd up to 262144 chars, and
// with every character requiring JSON escaping (e.g. all `"`), a fully spec-compliant
// outcome (every field at its own individual cap) serializes to ~550KB. This cap exists
// as a safety net for fields that don't already have a tight per-field cap (or a future
// field that's missing one) — sized comfortably above that legitimate worst case so it
// never rejects a spec-compliant outcome, while still catching gross abuse (e.g. the
// reported multi-MB outcome.model, which the per-field cap above now also rejects
// directly).
const MAX_OUTCOME_JSON_BYTES = 600 * 1024;
const SSE_HEARTBEAT_MS = 25_000;

const SESSION_KINDS = new Set(['llm_call', 'turn', 'custom']);
const SERVICE_KINDS = new Set(['system', 'memory', 'retrieval', 'tool', 'history', 'user', 'other']);
const SECTION_ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const EVENT_TYPES = new Set(['session.started', 'segment.recorded', 'session.ended', 'segment.outcome']);

/** Constant-time string equality via fixed-length SHA-256 digests (safe even for unequal-length inputs). */
function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

export interface AppOptions {
  apiKey?: string;
  corsOrigin?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Caps the serialized size of a metadata/outcome blob. These are stored as opaque JSON
 * and re-serialized on every read; a type check alone (`is this an object?`) doesn't
 * bound size, so an attacker-controlled multi-MB value would otherwise sail straight
 * through and balloon every subsequent read response.
 */
function validateJsonSize(value: unknown, maxBytes: number, label: string): string | null {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > maxBytes) return `${label} exceeds max serialized size of ${maxBytes} bytes`;
  return null;
}

/** Validates an optional `metadata` field shared by session/segment/section payloads. */
function validateMetadataField(metadata: unknown, label: string): string | null {
  if (metadata === undefined) return null;
  if (!isRecord(metadata)) return `${label} must be an object`;
  return validateJsonSize(metadata, MAX_METADATA_JSON_BYTES, label);
}

/** Validates a `sections` array shared by segment.recorded and /v1/import. */
function validateSectionsArray(sections: unknown): string | null {
  if (!Array.isArray(sections)) return 'segment.sections must be an array';
  if (sections.length > MAX_SECTIONS_PER_SEGMENT) {
    return `segment.sections exceeds max of ${MAX_SECTIONS_PER_SEGMENT}`;
  }

  const seenKeys = new Set<string>();
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (!isRecord(section)) return `sections[${i}] must be an object`;
    if (typeof section.key !== 'string' || section.key.length === 0) return `sections[${i}].key is required`;
    if (section.key.length > MAX_STRING_LEN) return `sections[${i}].key exceeds max length`;
    if (seenKeys.has(section.key)) return `duplicate section key: ${section.key}`;
    seenKeys.add(section.key);
    if (typeof section.service !== 'string' || section.service.length === 0) {
      return `sections[${i}].service is required`;
    }
    if (section.service.length > MAX_STRING_LEN) return `sections[${i}].service exceeds max length`;
    if (typeof section.serviceKind !== 'string' || !SERVICE_KINDS.has(section.serviceKind)) {
      return `sections[${i}].serviceKind is invalid`;
    }
    if (typeof section.position !== 'number' || !Number.isFinite(section.position) || section.position < 0) {
      return `sections[${i}].position must be a number >= 0`;
    }
    if (section.content !== undefined && typeof section.content !== 'string') {
      return `sections[${i}].content must be a string`;
    }
    if (typeof section.content === 'string' && section.content.length > MAX_CONTENT_LEN) {
      return `sections[${i}].content exceeds max length of ${MAX_CONTENT_LEN}`;
    }
    if (section.role !== undefined && !SECTION_ROLES.has(section.role as string)) {
      return `sections[${i}].role is invalid`;
    }
    if (section.tokens !== undefined && typeof section.tokens !== 'number') {
      return `sections[${i}].tokens must be a number`;
    }
    const metadataReason = validateMetadataField(section.metadata, `sections[${i}].metadata`);
    if (metadataReason) return metadataReason;
  }

  return null;
}

/** Validates a `Session` payload — shared by the session.started ingest event and /v1/import. */
function validateSessionPayload(data: unknown): string | null {
  if (!isRecord(data)) return 'session must be an object';
  if (typeof data.id !== 'string' || data.id.length === 0) return 'session.id is required';
  if (data.id.length > MAX_STRING_LEN) return 'session.id exceeds max length';
  if (typeof data.name !== 'string' || data.name.length === 0) return 'session.name is required';
  if (data.name.length > MAX_STRING_LEN) return 'session.name exceeds max length';
  if (data.agent !== undefined && typeof data.agent !== 'string') return 'session.agent must be a string';
  if (typeof data.agent === 'string' && data.agent.length > MAX_STRING_LEN) return 'session.agent exceeds max length';
  const metadataReason = validateMetadataField(data.metadata, 'session.metadata');
  if (metadataReason) return metadataReason;
  if (typeof data.startedAt !== 'string' || data.startedAt.length === 0) return 'session.startedAt is required';
  if (data.startedAt.length > MAX_STRING_LEN) return 'session.startedAt exceeds max length';
  if (data.endedAt !== undefined) {
    if (typeof data.endedAt !== 'string') return 'session.endedAt must be a string';
    if (data.endedAt.length > MAX_STRING_LEN) return 'session.endedAt exceeds max length';
  }
  return null;
}

/** Validates a segment.recorded `data` payload — shared by ingest and /v1/import. */
function validateSegmentPayload(data: unknown): string | null {
  if (!isRecord(data)) return 'event.data must be an object';
  if (typeof data.id !== 'string' || data.id.length === 0) return 'segment.id is required';
  if (data.id.length > MAX_STRING_LEN) return 'segment.id exceeds max length';
  if (typeof data.sessionId !== 'string' || data.sessionId.length === 0) return 'segment.sessionId is required';
  if (data.sessionId.length > MAX_STRING_LEN) return 'segment.sessionId exceeds max length';
  if (data.label !== undefined && typeof data.label !== 'string') return 'segment.label must be a string';
  if (typeof data.label === 'string' && data.label.length > MAX_STRING_LEN) return 'segment.label exceeds max length';
  if (typeof data.index !== 'number' || !Number.isInteger(data.index) || data.index < 0) {
    return 'segment.index must be an integer >= 0';
  }
  if (typeof data.kind !== 'string' || !SESSION_KINDS.has(data.kind)) return 'segment.kind is invalid';
  if (typeof data.timestamp !== 'string' || data.timestamp.length === 0) return 'segment.timestamp is required';
  const metadataReason = validateMetadataField(data.metadata, 'segment.metadata');
  if (metadataReason) return metadataReason;
  return validateSectionsArray(data.sections);
}

/** Validates a `SegmentOutcome` payload — shared by segment.outcome events and /v1/import. */
function validateOutcomePayload(outcome: unknown): string | null {
  if (!isRecord(outcome)) return 'outcome must be an object';
  if (outcome.responseText !== undefined) {
    if (typeof outcome.responseText !== 'string') return 'outcome.responseText must be a string';
    if (outcome.responseText.length > MAX_OUTCOME_RESPONSE_LEN) {
      return `outcome.responseText exceeds max length of ${MAX_OUTCOME_RESPONSE_LEN}`;
    }
  }
  if (outcome.error !== undefined) {
    if (typeof outcome.error !== 'string') return 'outcome.error must be a string';
    if (outcome.error.length > MAX_OUTCOME_ERROR_LEN) {
      return `outcome.error exceeds max length of ${MAX_OUTCOME_ERROR_LEN}`;
    }
  }
  if (outcome.latencyMs !== undefined && typeof outcome.latencyMs !== 'number') {
    return 'outcome.latencyMs must be a number';
  }
  if (outcome.model !== undefined) {
    if (typeof outcome.model !== 'string') return 'outcome.model must be a string';
    if (outcome.model.length > MAX_STRING_LEN) return `outcome.model exceeds max length of ${MAX_STRING_LEN}`;
  }
  if (outcome.scores !== undefined) {
    if (!isRecord(outcome.scores)) return 'outcome.scores must be an object';
    const keys = Object.keys(outcome.scores);
    if (keys.length > MAX_OUTCOME_SCORE_KEYS) return `outcome.scores exceeds max of ${MAX_OUTCOME_SCORE_KEYS} score keys`;
    for (const k of keys) {
      if (k.length > MAX_STRING_LEN) return `outcome.scores key exceeds max length of ${MAX_STRING_LEN}`;
      if (typeof (outcome.scores as Record<string, unknown>)[k] !== 'number') return `outcome.scores.${k} must be a number`;
    }
  }
  // Defense in depth on top of the per-field caps above: bounds the whole serialized
  // blob, since it's stored and re-serialized as one opaque JSON column.
  const sizeReason = validateJsonSize(outcome, MAX_OUTCOME_JSON_BYTES, 'outcome');
  if (sizeReason) return sizeReason;
  return null;
}

/** Validates one raw ingest event; returns a rejection reason, or null if valid. */
function validateEvent(raw: unknown): string | null {
  if (!isRecord(raw)) return 'event must be an object';
  const type = raw.type;
  if (typeof type !== 'string' || !EVENT_TYPES.has(type)) {
    return `unknown event type: ${String(type)}`;
  }
  const data = raw.data;
  if (!isRecord(data)) return 'event.data must be an object';

  if (type === 'session.started') {
    return validateSessionPayload(data);
  }

  if (type === 'session.ended') {
    if (typeof data.sessionId !== 'string' || data.sessionId.length === 0) return 'sessionId is required';
    if (data.sessionId.length > MAX_STRING_LEN) return 'sessionId exceeds max length';
    if (typeof data.endedAt !== 'string' || data.endedAt.length === 0) return 'endedAt is required';
    return null;
  }

  if (type === 'segment.outcome') {
    if (typeof data.sessionId !== 'string' || data.sessionId.length === 0) return 'sessionId is required';
    if (data.sessionId.length > MAX_STRING_LEN) return 'sessionId exceeds max length';
    if (typeof data.segmentId !== 'string' || data.segmentId.length === 0) return 'segmentId is required';
    if (data.segmentId.length > MAX_STRING_LEN) return 'segmentId exceeds max length';
    return validateOutcomePayload(data.outcome);
  }

  // segment.recorded
  return validateSegmentPayload(data);
}

function applyEvent(db: Db, event: IngestEvent): void {
  if (event.type === 'session.started') {
    store.upsertSession(db, event.data);
  } else if (event.type === 'segment.recorded') {
    store.upsertSegment(db, event.data);
  } else if (event.type === 'segment.outcome') {
    const updated = store.applySegmentOutcome(db, event.data.sessionId, event.data.segmentId, event.data.outcome);
    if (!updated) throw new Error('unknown segment');
  } else {
    // Unlike segment.recorded, session.ended never fabricates a stub session: an unknown
    // sessionId here (already deleted, or ended before it ever started) is rejected rather
    // than silently resurrecting/creating a session.
    const updated = store.endSession(db, event.data.sessionId, event.data.endedAt);
    if (!updated) throw new Error('unknown session');
  }
}

function liveSessionIdFor(event: IngestEvent): string {
  return event.type === 'session.started' ? event.data.id : event.data.sessionId;
}

/**
 * Emits the corresponding live-tail bus message for a successfully-applied event.
 * Bails out before touching the DB when nobody is listening on this session — building
 * a `segment` message means a full-content select + diff (measured ~3.6ms/event), which
 * is wasted work on every single ingest event for the overwhelmingly common case of no
 * open /live connection.
 */
function emitLiveEvents(db: Db, bus: SessionBus, event: IngestEvent): void {
  const sessionId = liveSessionIdFor(event);
  if (bus.listenerCount(sessionId) === 0) return;

  if (event.type === 'session.started' || event.type === 'session.ended') {
    const summary = store.getSessionSummary(db, sessionId);
    if (summary) bus.emit(sessionId, { event: 'session', data: summary });
  } else if (event.type === 'segment.recorded') {
    const detail = store.getSegmentDetail(db, sessionId, event.data.index);
    if (detail) bus.emit(sessionId, { event: 'segment', data: detail.segment });
  } else if (event.type === 'segment.outcome') {
    const index = store.getSegmentIndexById(db, sessionId, event.data.segmentId);
    if (index !== undefined) {
      bus.emit(sessionId, { event: 'outcome', data: { segmentId: event.data.segmentId, index, outcome: event.data.outcome } });
    }
  }
}

/** Percent-encodes a string per RFC 5987 `attr-char`, for a `filename*=` extended value. */
function encodeRfc5987ValueChars(value: string): string {
  return encodeURIComponent(value)
    .replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, '%2A');
}

/**
 * Builds a `content-disposition` header value that can't be used for header/CRLF
 * injection: session ids are attacker-controlled (client-assigned), and neither the
 * quoted `filename` nor the header as a whole may contain raw `"`, `;`, CR, or LF from
 * that id. The quoted `filename` is reduced to a conservative ASCII-safe charset (any
 * other character, including quotes/semicolons/CR/LF, becomes '_'); the real id
 * (unicode included) is carried in the RFC 5987 `filename*` extension instead, which is
 * percent-encoded and so can't contain a literal CR/LF either.
 */
function exportContentDisposition(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_') || 'export';
  const encoded = encodeRfc5987ValueChars(id);
  return `attachment; filename="${safe}.context-trace.json"; filename*=UTF-8''${encoded}.context-trace.json`;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Parses a route param as a non-negative integer, strictly — unlike `Number.parseInt`,
 * "1.5" and "0abc" are rejected (parseInt would silently truncate/prefix-parse them into
 * a valid-looking index) rather than accepted.
 */
function parseStrictNonNegativeInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) ? n : null;
}

// Test-only registry mapping an app instance to its live-tail bus, so tests can assert
// listener counts without changing createApp's public (Hono-returning) signature.
const busRegistry = new WeakMap<Hono, SessionBus>();

/** Retrieves the live-tail bus wired to `app` by `createApp`. Exported for tests only. */
export function getBus(app: Hono): SessionBus | undefined {
  return busRegistry.get(app);
}

/** Builds the Hono app for the trace server, wired to `db`. */
export function createApp(db: Db, opts: AppOptions = {}): Hono {
  const app = new Hono();
  const bus = new SessionBus();
  busRegistry.set(app, bus);
  const ftsAvailable = hasFtsSupport(db);

  app.get('/healthz', (c) => c.json({ ok: true }));

  // Writes only require x-api-key; reads stay open even when a key is configured
  // so the dashboard keeps working (read privacy is a network-level concern).
  const requireApiKey: MiddlewareHandler = async (c, next) => {
    if (opts.apiKey) {
      const provided = c.req.header('x-api-key');
      if (!provided || !constantTimeEqual(provided, opts.apiKey)) {
        return c.json({ error: 'unauthorized' }, 401);
      }
    }
    await next();
  };

  // CORS applies only to the ingest endpoint (including its OPTIONS preflight) —
  // the SPA is same-origin via proxy and read/delete routes never need it.
  app.use('/v1/ingest', cors({ origin: opts.corsOrigin ?? '*' }));

  app.post(
    '/v1/ingest',
    requireApiKey,
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
          const event = events[i] as IngestEvent;
          applyEvent(db, event);
          accepted++;
          emitLiveEvents(db, bus, event);
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

  app.get('/v1/search', (c) => {
    if (!ftsAvailable) return c.json({ error: 'search unavailable' }, 501);
    const q = c.req.query('q');
    if (!q || q.trim().length === 0) return c.json({ error: 'q is required' }, 400);
    const limit = clampInt(c.req.query('limit'), 20, 1, 50);
    const hits = store.searchSections(db, { q, limit });
    return c.json({ hits });
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

  app.get('/v1/sessions/:id/trace/analytics', (c) => {
    const trace = store.getSessionTrace(db, c.req.param('id'));
    if (!trace) return c.json({ error: 'not found' }, 404);
    return c.json(computeAnalytics(trace));
  });

  app.get('/v1/sessions/:id/export', (c) => {
    const id = c.req.param('id');
    const exported = store.exportSession(db, id);
    if (!exported) return c.json({ error: 'not found' }, 404);
    c.header('content-disposition', exportContentDisposition(id));
    return c.json(exported);
  });

  app.get('/v1/sessions/:id/segments/:index', (c) => {
    const idx = parseStrictNonNegativeInt(c.req.param('index'));
    if (idx === null) return c.json({ error: 'not found' }, 404);
    const detail = store.getSegmentDetail(db, c.req.param('id'), idx);
    if (!detail) return c.json({ error: 'not found' }, 404);
    return c.json(detail);
  });

  app.get('/v1/sessions/:id/live', (c) => {
    const sessionId = c.req.param('id');
    // A session that doesn't exist yet (e.g. session.started hasn't arrived) is a
    // legitimate 404 rather than a stream that silently sits open forever — clients
    // should open /live only after the session is known to exist.
    if (!store.sessionExists(db, sessionId)) return c.json({ error: 'not found' }, 404);
    return streamSSE(c, async (stream) => {
      let closed = false;
      const unsubscribe = bus.subscribe(sessionId, (msg) => {
        void stream.writeSSE({ event: msg.event, data: JSON.stringify(msg.data) });
      });
      const heartbeat = setInterval(() => {
        if (!closed) void stream.write(': heartbeat\n\n');
      }, SSE_HEARTBEAT_MS);
      stream.onAbort(() => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      });
      while (!closed) {
        await stream.sleep(250);
      }
    });
  });

  app.delete('/v1/sessions/:id', requireApiKey, (c) => {
    const deleted = store.deleteSession(db, c.req.param('id'));
    if (!deleted) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  app.post(
    '/v1/import',
    requireApiKey,
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
      if (!isRecord(body)) return c.json({ error: 'body must be an object' }, 400);
      if (body.version !== 1) return c.json({ error: 'unsupported version' }, 400);

      const session = body.session;
      const sessionReason = validateSessionPayload(session);
      if (sessionReason) return c.json({ error: `session: ${sessionReason}` }, 400);

      const segmentsRaw = body.segments;
      if (!Array.isArray(segmentsRaw)) return c.json({ error: 'segments must be an array' }, 400);
      if (segmentsRaw.length > MAX_BATCH) {
        return c.json({ error: `segments exceeds max size of ${MAX_BATCH}` }, 400);
      }

      const sessionId = (session as Record<string, unknown>).id as string;
      for (let i = 0; i < segmentsRaw.length; i++) {
        const seg = segmentsRaw[i];
        const reason = validateSegmentPayload(seg);
        if (reason) return c.json({ error: `segments[${i}]: ${reason}` }, 400);
        // An import envelope carries exactly one session; a segment claiming a
        // different sessionId would otherwise let one exported file write into (or
        // hijack) an unrelated session.
        if (isRecord(seg) && seg.sessionId !== sessionId) {
          return c.json({ error: `segments[${i}]: sessionId must match the imported session's id` }, 400);
        }
        if (isRecord(seg) && seg.outcome !== undefined) {
          const outcomeReason = validateOutcomePayload(seg.outcome);
          if (outcomeReason) return c.json({ error: `segments[${i}].outcome: ${outcomeReason}` }, 400);
        }
      }

      // Everything below is one atomic write: a failure partway through (e.g. two
      // segments that pass schema validation individually but collide on the
      // (session_id, idx) unique constraint) must leave nothing written, not a
      // half-imported session. store.upsertSegment's own internal transaction nests as
      // a savepoint here (better-sqlite3 supports this natively), so a failure inside it
      // still rolls back everything from this outer transaction, including segments
      // already committed earlier in the loop.
      let failingLabel: string | undefined;
      try {
        const importTx = db.transaction(() => {
          failingLabel = 'session';
          store.upsertSession(db, session as unknown as Session);
          const segments = segmentsRaw as Array<Record<string, unknown>>;
          for (let i = 0; i < segments.length; i++) {
            const seg = segments[i]!;
            failingLabel = `segments[${i}]`;
            store.upsertSegment(db, seg as unknown as SegmentWithSections);
            if (seg.outcome !== undefined) {
              store.applySegmentOutcome(db, seg.sessionId as string, seg.id as string, seg.outcome as SegmentOutcome);
            }
          }
          failingLabel = undefined;
          const s = session as Record<string, unknown>;
          if (typeof s.endedAt === 'string' && s.endedAt.length > 0) {
            store.endSession(db, s.id as string, s.endedAt);
          }
        });
        importTx();
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown error';
        return c.json({ error: `import failed at ${failingLabel ?? 'session'}: ${reason}` }, 400);
      }

      return c.json({ accepted: { segments: segmentsRaw.length } }, 200);
    }
  );

  return app;
}
