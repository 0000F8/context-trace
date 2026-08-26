import { estimateTokens, fnv1a64 } from '@context-trace/types';
import type {
  AnnotatedSection,
  CompiledTrace,
  Section,
  SectionState,
  Segment,
  SegmentKind,
  SegmentOutcome,
  SegmentSummary,
  SegmentWithSections,
  SegmentDetail,
  SearchHit,
  ServiceKind,
  Session,
  SessionDetail,
  SessionExport,
  SessionSummary,
  Stats,
} from '@context-trace/types';
import type { Db } from './db.js';
import { hasFtsSupport } from './db.js';
import { compileTrace, deltaCounts, diffSections } from './trace/compile.js';
import type { TraceSourceSegment } from './trace/compile.js';

interface SessionRow {
  id: string;
  name: string;
  agent: string | null;
  metadata: string | null;
  started_at: string;
  ended_at: string | null;
}

interface SegmentRow {
  id: string;
  session_id: string;
  idx: number;
  label: string | null;
  kind: string;
  model: string | null;
  timestamp: string;
  metadata: string | null;
  outcome: string | null;
}

interface SectionRow {
  segment_id: string;
  key: string;
  service: string;
  service_kind: string;
  role: string | null;
  position: number;
  content: string | null;
  content_hash: string;
  tokens: number;
  metadata: string | null;
}

/** Section columns excluding `content` — used on paths that never render content, to avoid loading large blobs. */
interface SectionMetaRow {
  key: string;
  service: string;
  service_kind: string;
  position: number;
  content_hash: string;
  tokens: number;
}

function sessionRowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    name: row.name,
    agent: row.agent ?? undefined,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
  };
}

function segmentRowToSegment(row: SegmentRow): Segment {
  return {
    id: row.id,
    sessionId: row.session_id,
    index: row.idx,
    label: row.label ?? undefined,
    kind: row.kind as SegmentKind,
    model: row.model ?? undefined,
    timestamp: row.timestamp,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
  };
}

function parseOutcome(raw: string | null): SegmentOutcome | undefined {
  return raw ? (JSON.parse(raw) as SegmentOutcome) : undefined;
}

function sectionRowToSection(row: SectionRow): Section {
  return {
    key: row.key,
    service: row.service,
    serviceKind: row.service_kind as ServiceKind,
    role: (row.role ?? undefined) as Section['role'],
    position: row.position,
    content: row.content ?? undefined,
    contentHash: row.content_hash,
    tokens: row.tokens,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
  };
}

/** Builds a `Section` without `content` (or `role`/`metadata`, not needed by diffing/compilation). */
function sectionMetaRowToSection(row: SectionMetaRow): Section {
  return {
    key: row.key,
    service: row.service,
    serviceKind: row.service_kind as ServiceKind,
    position: row.position,
    contentHash: row.content_hash,
    tokens: row.tokens,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function upsertSession(db: Db, session: Session): void {
  db.prepare(
    `INSERT INTO sessions (id, name, agent, metadata, started_at, ended_at)
     VALUES (@id, @name, @agent, @metadata, @started_at, @ended_at)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       agent = excluded.agent,
       metadata = excluded.metadata,
       started_at = excluded.started_at,
       ended_at = excluded.ended_at`
  ).run({
    id: session.id,
    name: session.name,
    agent: session.agent ?? null,
    metadata: session.metadata ? JSON.stringify(session.metadata) : null,
    started_at: session.startedAt,
    ended_at: session.endedAt ?? null,
  });
}

export function ensureStubSession(db: Db, sessionId: string, timestamp: string): void {
  const exists = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId);
  if (exists) return;
  db.prepare(
    `INSERT INTO sessions (id, name, agent, metadata, started_at, ended_at)
     VALUES (?, ?, NULL, NULL, ?, NULL)`
  ).run(sessionId, `stub-${sessionId}`, timestamp);
}

export function upsertSegment(db: Db, segment: SegmentWithSections): void {
  const upsertSegmentStmt = db.prepare(
    `INSERT INTO segments (id, session_id, idx, label, kind, model, timestamp, metadata)
     VALUES (@id, @session_id, @idx, @label, @kind, @model, @timestamp, @metadata)
     ON CONFLICT(id) DO UPDATE SET
       session_id = excluded.session_id,
       idx = excluded.idx,
       label = excluded.label,
       kind = excluded.kind,
       model = excluded.model,
       timestamp = excluded.timestamp,
       metadata = excluded.metadata`
  );
  // Note: outcome is deliberately never touched here — it's a separate event
  // (segment.outcome) applied later via applySegmentOutcome, and a re-recorded/updated
  // segment must not silently wipe out an outcome already attached to it.
  const deleteSectionsStmt = db.prepare('DELETE FROM sections WHERE segment_id = ?');
  const insertSectionStmt = db.prepare(
    `INSERT INTO sections (segment_id, key, service, service_kind, role, position, content, content_hash, tokens, metadata)
     VALUES (@segment_id, @key, @service, @service_kind, @role, @position, @content, @content_hash, @tokens, @metadata)`
  );
  const deleteFtsStmt = db.prepare('DELETE FROM sections_fts WHERE segment_id = ?');
  const insertFtsStmt = db.prepare(
    `INSERT INTO sections_fts (content, key, service, session_id, segment_id, segment_index)
     VALUES (@content, @key, @service, @session_id, @segment_id, @segment_index)`
  );
  const fts = hasFtsSupport(db);

  const tx = db.transaction((seg: SegmentWithSections) => {
    // Inside the transaction: if anything below throws (e.g. a constraint violation),
    // the stub-session insert rolls back too, instead of leaving a phantom empty session
    // behind for a segment that was ultimately rejected.
    ensureStubSession(db, seg.sessionId, seg.timestamp);
    upsertSegmentStmt.run({
      id: seg.id,
      session_id: seg.sessionId,
      idx: seg.index,
      label: seg.label ?? null,
      kind: seg.kind,
      model: seg.model ?? null,
      timestamp: seg.timestamp,
      metadata: seg.metadata ? JSON.stringify(seg.metadata) : null,
    });
    deleteSectionsStmt.run(seg.id);
    if (fts) deleteFtsStmt.run(seg.id);
    for (const section of seg.sections) {
      const content = section.content ?? null;
      const tokens =
        typeof section.tokens === 'number' && Number.isFinite(section.tokens) && section.tokens >= 0
          ? Math.trunc(section.tokens)
          : estimateTokens(content ?? '');
      // Content, when present, is the source of truth for its hash — recompute server-side
      // rather than trusting a client-supplied hash that could be stale or forged. A client
      // hash is only honored when content itself was omitted (a hash-only reference).
      const contentHash =
        content !== null
          ? fnv1a64(content)
          : typeof section.contentHash === 'string' && section.contentHash.length > 0
            ? section.contentHash
            : fnv1a64('');
      insertSectionStmt.run({
        segment_id: seg.id,
        key: section.key,
        service: section.service,
        service_kind: section.serviceKind,
        role: section.role ?? null,
        position: section.position,
        content,
        content_hash: contentHash,
        tokens,
        metadata: section.metadata ? JSON.stringify(section.metadata) : null,
      });
      if (fts && content !== null) {
        insertFtsStmt.run({
          content,
          key: section.key,
          service: section.service,
          session_id: seg.sessionId,
          segment_id: seg.id,
          segment_index: seg.index,
        });
      }
    }
  });
  tx(segment);
}

/**
 * Applies a `segment.outcome` event. Returns false when the segment doesn't exist
 * under that session — the caller (app.ts) turns that into a per-event rejection
 * rather than silently no-op-ing or fabricating a segment.
 */
export function applySegmentOutcome(db: Db, sessionId: string, segmentId: string, outcome: SegmentOutcome): boolean {
  const result = db
    .prepare('UPDATE segments SET outcome = ? WHERE id = ? AND session_id = ?')
    .run(JSON.stringify(outcome), segmentId, sessionId);
  return result.changes > 0;
}

/** Looks up a segment's index by id, scoped to a session — used to shape live `outcome` events. */
export function getSegmentIndexById(db: Db, sessionId: string, segmentId: string): number | undefined {
  const row = db.prepare('SELECT idx FROM segments WHERE id = ? AND session_id = ?').get(segmentId, sessionId) as
    | { idx: number }
    | undefined;
  return row?.idx;
}

/**
 * Ends an existing session. Unlike segment.recorded, this never fabricates a stub session:
 * an unknown sessionId is a no-op, returning false so callers can reject the event instead
 * of silently creating (or resurrecting a just-deleted) session from an end event alone.
 */
export function endSession(db: Db, sessionId: string, endedAt: string): boolean {
  const result = db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(endedAt, sessionId);
  return result.changes > 0;
}

export function deleteSession(db: Db, id: string): boolean {
  // sections_fts is a virtual table: the sessions/segments/sections FK cascade
  // (ON DELETE CASCADE) never reaches it, so it needs its own explicit cleanup.
  const tx = db.transaction((sessionId: string) => {
    if (hasFtsSupport(db)) {
      db.prepare(
        `DELETE FROM sections_fts WHERE segment_id IN (SELECT id FROM segments WHERE session_id = ?)`
      ).run(sessionId);
    }
    return db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  });
  const result = tx(id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Loads every segment's sections *without content* — safe for paths that never render
 * section text (list/summary aggregates, delta counts, trace compilation), since content
 * can be arbitrarily large and multiplies out across every segment in a session.
 */
function loadSegmentsWithSectionMeta(db: Db, sessionId: string): TraceSourceSegment[] {
  const segRows = db
    .prepare('SELECT * FROM segments WHERE session_id = ? ORDER BY idx ASC')
    .all(sessionId) as SegmentRow[];
  const sectionStmt = db.prepare(
    'SELECT key, service, service_kind, position, content_hash, tokens FROM sections WHERE segment_id = ? ORDER BY position ASC'
  );
  return segRows.map((row) => ({
    ...segmentRowToSegment(row),
    sections: (sectionStmt.all(row.id) as SectionMetaRow[]).map(sectionMetaRowToSection),
    outcome: parseOutcome(row.outcome),
  }));
}

/** Loads a single segment's sections *with* content — for the one endpoint that renders it. */
function loadSingleSegmentWithSections(db: Db, row: SegmentRow): TraceSourceSegment {
  const sectionRows = db
    .prepare('SELECT * FROM sections WHERE segment_id = ? ORDER BY position ASC')
    .all(row.id) as SectionRow[];
  return { ...segmentRowToSegment(row), sections: sectionRows.map(sectionRowToSection), outcome: parseOutcome(row.outcome) };
}

/**
 * Builds a session summary entirely from SQL aggregates (counts, sums, distinct services,
 * max timestamp) — never selects the `content` column, so summary/list paths don't pay for
 * every section's text just to report counts and token totals.
 */
function buildSessionSummary(db: Db, row: SessionRow): SessionSummary {
  const session = sessionRowToSession(row);

  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM segments WHERE session_id = ?) AS segment_count,
         (SELECT COUNT(*) FROM sections sec JOIN segments seg ON seg.id = sec.segment_id WHERE seg.session_id = ?) AS section_count`
    )
    .get(row.id, row.id) as { segment_count: number; section_count: number };

  const latest = db
    .prepare(
      `SELECT COALESCE(SUM(sec.tokens), 0) AS total
       FROM segments seg
       LEFT JOIN sections sec ON sec.segment_id = seg.id
       WHERE seg.session_id = ?
         AND seg.idx = (SELECT MAX(idx) FROM segments WHERE session_id = ?)`
    )
    .get(row.id, row.id) as { total: number | null };

  const peak = db
    .prepare(
      `SELECT MAX(seg_tokens) AS peak FROM (
         SELECT COALESCE(SUM(sec.tokens), 0) AS seg_tokens
         FROM segments seg
         LEFT JOIN sections sec ON sec.segment_id = seg.id
         WHERE seg.session_id = ?
         GROUP BY seg.id
       )`
    )
    .get(row.id) as { peak: number | null };

  const serviceRows = db
    .prepare(
      `SELECT DISTINCT sec.service AS service
       FROM sections sec JOIN segments seg ON seg.id = sec.segment_id
       WHERE seg.session_id = ?
       ORDER BY sec.service ASC`
    )
    .all(row.id) as Array<{ service: string }>;

  const lastActivity = db
    .prepare(
      `SELECT MAX(ts) AS last FROM (
         SELECT timestamp AS ts FROM segments WHERE session_id = ?
         UNION ALL SELECT started_at AS ts FROM sessions WHERE id = ?
         UNION ALL SELECT ended_at AS ts FROM sessions WHERE id = ? AND ended_at IS NOT NULL
       )`
    )
    .get(row.id, row.id, row.id) as { last: string | null };

  return {
    ...session,
    segmentCount: counts.segment_count,
    sectionCount: counts.section_count,
    totalTokens: latest.total ?? 0,
    peakTokens: peak.peak ?? 0,
    services: serviceRows.map((r) => r.service),
    lastActivityAt: lastActivity.last ?? session.startedAt,
  };
}

export function sessionExists(db: Db, id: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id));
}

export function getSessionSummary(db: Db, id: string): SessionSummary | undefined {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  if (!row) return undefined;
  return buildSessionSummary(db, row);
}

export function getStats(db: Db): Stats {
  const sessions = (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;
  const segments = (db.prepare('SELECT COUNT(*) AS c FROM segments').get() as { c: number }).c;
  const sections = (db.prepare('SELECT COUNT(*) AS c FROM sections').get() as { c: number }).c;
  const totalTokens = (db.prepare('SELECT COALESCE(SUM(tokens), 0) AS t FROM sections').get() as { t: number }).t;
  const lastRow = db
    .prepare(
      `SELECT MAX(ts) AS last FROM (
         SELECT timestamp AS ts FROM segments
         UNION ALL
         SELECT started_at AS ts FROM sessions
         UNION ALL
         SELECT ended_at AS ts FROM sessions WHERE ended_at IS NOT NULL
       )`
    )
    .get() as { last: string | null };

  return {
    sessions,
    segments,
    sections,
    totalTokens,
    lastIngestAt: lastRow.last ?? null,
  };
}

export interface ListSessionsOptions {
  limit: number;
  offset: number;
  q?: string;
}

export function listSessions(db: Db, opts: ListSessionsOptions): { sessions: SessionSummary[]; total: number } {
  const q = opts.q?.trim();
  let rows: SessionRow[];
  let total: number;

  if (q) {
    const like = `%${q.toLowerCase()}%`;
    total = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM sessions WHERE lower(name) LIKE ? OR lower(COALESCE(agent, '')) LIKE ?`)
        .get(like, like) as { c: number }
    ).c;
    rows = db
      .prepare(
        `SELECT * FROM sessions WHERE lower(name) LIKE ? OR lower(COALESCE(agent, '')) LIKE ?
         ORDER BY started_at DESC LIMIT ? OFFSET ?`
      )
      .all(like, like, opts.limit, opts.offset) as SessionRow[];
  } else {
    total = (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;
    rows = db
      .prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ? OFFSET ?')
      .all(opts.limit, opts.offset) as SessionRow[];
  }

  const sessions = rows.map((row) => buildSessionSummary(db, row));
  return { sessions, total };
}

export function getSessionDetail(db: Db, id: string): SessionDetail | undefined {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  if (!row) return undefined;

  const summary = buildSessionSummary(db, row);
  // Delta counts only need keys/hashes/tokens to diff consecutive segments, not content.
  const segments = loadSegmentsWithSectionMeta(db, id);
  const sorted = [...segments].sort((a, b) => a.index - b.index);

  const segmentSummaries: SegmentSummary[] = [];
  let previous: TraceSourceSegment | undefined;
  for (const seg of sorted) {
    const diff = diffSections(seg.sections, previous?.sections);
    segmentSummaries.push({
      id: seg.id,
      index: seg.index,
      label: seg.label,
      kind: seg.kind,
      model: seg.model,
      timestamp: seg.timestamp,
      totalTokens: seg.sections.reduce((sum, s) => sum + s.tokens, 0),
      sectionCount: seg.sections.length,
      delta: deltaCounts(diff),
      outcome: seg.outcome,
    });
    previous = seg;
  }

  return { ...summary, segments: segmentSummaries };
}

export function getSessionTrace(db: Db, id: string): CompiledTrace | undefined {
  const summary = getSessionSummary(db, id);
  if (!summary) return undefined;
  // The compiled trace never surfaces section content (ops/spans/services are all
  // key/token/hash based), so compile from the lightweight, content-free load.
  const segments = loadSegmentsWithSectionMeta(db, id);
  return compileTrace(summary, segments);
}

export function getSegmentDetail(db: Db, sessionId: string, index: number): SegmentDetail | undefined {
  const sessionExists = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId);
  if (!sessionExists) return undefined;

  const segRow = db.prepare('SELECT * FROM segments WHERE session_id = ? AND idx = ?').get(sessionId, index) as
    | SegmentRow
    | undefined;
  if (!segRow) return undefined;

  // Only the current + immediately previous segment ever need full content here — load
  // just those two rather than every segment in the session.
  const seg = loadSingleSegmentWithSections(db, segRow);
  const prevRow = db
    .prepare('SELECT * FROM segments WHERE session_id = ? AND idx < ? ORDER BY idx DESC LIMIT 1')
    .get(sessionId, index) as SegmentRow | undefined;
  const previous = prevRow ? loadSingleSegmentWithSections(db, prevRow) : undefined;

  const diff = diffSections(seg.sections, previous?.sections);

  const stateByKey = new Map<string, SectionState>();
  const prevByKey = new Map<string, Section>();
  for (const s of diff.added) stateByKey.set(s.key, 'added');
  for (const { current, previous: prevSection } of diff.changed) {
    stateByKey.set(current.key, 'changed');
    prevByKey.set(current.key, prevSection);
  }
  for (const s of diff.carried) stateByKey.set(s.key, 'carried');

  const sections: AnnotatedSection[] = [...seg.sections]
    .sort((a, b) => a.position - b.position)
    .map((s) => {
      const state = stateByKey.get(s.key)!;
      const prev = prevByKey.get(s.key);
      return {
        ...s,
        state,
        prevContent: prev?.content,
        prevTokens: prev?.tokens,
      };
    });

  return {
    segment: {
      id: seg.id,
      index: seg.index,
      label: seg.label,
      kind: seg.kind,
      model: seg.model,
      timestamp: seg.timestamp,
      totalTokens: seg.sections.reduce((sum, s) => sum + s.tokens, 0),
      sectionCount: seg.sections.length,
      delta: deltaCounts(diff),
      outcome: seg.outcome,
    },
    sections,
    removed: diff.removed,
  };
}

// ---------------------------------------------------------------------------
// Search (FTS5)
// ---------------------------------------------------------------------------

export interface SearchOptions {
  q: string;
  limit: number;
}

// Snippet highlight markers, pinned to control chars U+0001/U+0002 (not literal '[' /
// ']') so attacker-controlled section content can't inject characters that spoof a
// highlight boundary in the rendered snippet. Built via fromCharCode so no transport
// step can silently mangle them. The web client's snippet parser (web/src/lib/snippet.ts)
// is pinned to these same exact codepoints.
export const SNIPPET_MARK_OPEN = String.fromCharCode(1);
export const SNIPPET_MARK_CLOSE = String.fromCharCode(2);

/**
 * Full-text search over section content. `q` is passed as a bound parameter but still
 * wrapped as a quoted FTS5 phrase (embedded `"` doubled) so that FTS query-syntax
 * characters in user input (`OR`, unbalanced quotes, `-`, `*`, ...) can't produce a
 * syntax error or silently widen the query — the whole string is always matched as a
 * literal phrase, never parsed as an FTS5 expression.
 */
export function searchSections(db: Db, opts: SearchOptions): SearchHit[] {
  const phrase = `"${opts.q.replace(/"/g, '""')}"`;
  const rows = db
    .prepare(
      `SELECT f.session_id AS session_id, s.name AS session_name, f.segment_index AS segment_index,
              f.key AS key, f.service AS service,
              snippet(sections_fts, 0, '${SNIPPET_MARK_OPEN}', '${SNIPPET_MARK_CLOSE}', '…', 12) AS snippet
       FROM sections_fts f
       JOIN sessions s ON s.id = f.session_id
       WHERE sections_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(phrase, opts.limit) as Array<{
    session_id: string;
    session_name: string;
    segment_index: number;
    key: string;
    service: string;
    snippet: string;
  }>;

  return rows.map((r) => ({
    sessionId: r.session_id,
    sessionName: r.session_name,
    segmentIndex: r.segment_index,
    key: r.key,
    service: r.service,
    snippet: r.snippet,
  }));
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function exportSession(db: Db, id: string): SessionExport | undefined {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  if (!row) return undefined;

  const session = sessionRowToSession(row);
  const segRows = db.prepare('SELECT * FROM segments WHERE session_id = ? ORDER BY idx ASC').all(id) as SegmentRow[];
  const segments = segRows.map((segRow) => {
    const seg = loadSingleSegmentWithSections(db, segRow);
    return {
      id: seg.id,
      sessionId: seg.sessionId,
      index: seg.index,
      label: seg.label,
      kind: seg.kind,
      model: seg.model,
      timestamp: seg.timestamp,
      metadata: seg.metadata,
      sections: seg.sections,
      outcome: seg.outcome,
    };
  });

  return { version: 1, exportedAt: new Date().toISOString(), session, segments };
}
