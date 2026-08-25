import { estimateTokens, fnv1a64 } from '@context-trace/types';
import type {
  AnnotatedSection,
  CompiledTrace,
  Section,
  SectionState,
  Segment,
  SegmentKind,
  SegmentSummary,
  SegmentWithSections,
  SegmentDetail,
  ServiceKind,
  Session,
  SessionDetail,
  SessionSummary,
  Stats,
} from '@context-trace/types';
import type { Db } from './db.js';
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
  ensureStubSession(db, segment.sessionId, segment.timestamp);

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
  const deleteSectionsStmt = db.prepare('DELETE FROM sections WHERE segment_id = ?');
  const insertSectionStmt = db.prepare(
    `INSERT INTO sections (segment_id, key, service, service_kind, role, position, content, content_hash, tokens, metadata)
     VALUES (@segment_id, @key, @service, @service_kind, @role, @position, @content, @content_hash, @tokens, @metadata)`
  );

  const tx = db.transaction((seg: SegmentWithSections) => {
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
    for (const section of seg.sections) {
      const content = section.content ?? null;
      const tokens =
        typeof section.tokens === 'number' && Number.isFinite(section.tokens) && section.tokens >= 0
          ? Math.trunc(section.tokens)
          : estimateTokens(content ?? '');
      const contentHash =
        typeof section.contentHash === 'string' && section.contentHash.length > 0
          ? section.contentHash
          : fnv1a64(content ?? '');
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
    }
  });
  tx(segment);
}

export function endSession(db: Db, sessionId: string, endedAt: string): void {
  ensureStubSession(db, sessionId, endedAt);
  db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(endedAt, sessionId);
}

export function deleteSession(db: Db, id: string): boolean {
  const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function loadSegmentsWithSections(db: Db, sessionId: string): TraceSourceSegment[] {
  const segRows = db
    .prepare('SELECT * FROM segments WHERE session_id = ? ORDER BY idx ASC')
    .all(sessionId) as SegmentRow[];
  const sectionStmt = db.prepare('SELECT * FROM sections WHERE segment_id = ? ORDER BY position ASC');
  return segRows.map((row) => ({
    ...segmentRowToSegment(row),
    sections: (sectionStmt.all(row.id) as SectionRow[]).map(sectionRowToSection),
  }));
}

function summarizeSession(row: SessionRow, segments: TraceSourceSegment[]): SessionSummary {
  const session = sessionRowToSession(row);
  const sorted = [...segments].sort((a, b) => a.index - b.index);

  let sectionCount = 0;
  let peakTokens = 0;
  const servicesSet = new Set<string>();
  let lastActivityAt = session.startedAt;
  if (session.endedAt && session.endedAt > lastActivityAt) lastActivityAt = session.endedAt;

  for (const seg of sorted) {
    sectionCount += seg.sections.length;
    const segTokens = seg.sections.reduce((sum, s) => sum + s.tokens, 0);
    if (segTokens > peakTokens) peakTokens = segTokens;
    for (const s of seg.sections) servicesSet.add(s.service);
    if (seg.timestamp > lastActivityAt) lastActivityAt = seg.timestamp;
  }

  const last = sorted[sorted.length - 1];
  const totalTokens = last ? last.sections.reduce((sum, s) => sum + s.tokens, 0) : 0;

  return {
    ...session,
    segmentCount: sorted.length,
    sectionCount,
    totalTokens,
    peakTokens,
    services: [...servicesSet].sort(),
    lastActivityAt,
  };
}

export function getSessionSummary(db: Db, id: string): SessionSummary | undefined {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  if (!row) return undefined;
  const segments = loadSegmentsWithSections(db, id);
  return summarizeSession(row, segments);
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
  let idRows: Array<{ id: string }>;
  let total: number;

  if (q) {
    const like = `%${q.toLowerCase()}%`;
    total = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM sessions WHERE lower(name) LIKE ? OR lower(COALESCE(agent, '')) LIKE ?`)
        .get(like, like) as { c: number }
    ).c;
    idRows = db
      .prepare(
        `SELECT id FROM sessions WHERE lower(name) LIKE ? OR lower(COALESCE(agent, '')) LIKE ?
         ORDER BY started_at DESC LIMIT ? OFFSET ?`
      )
      .all(like, like, opts.limit, opts.offset) as Array<{ id: string }>;
  } else {
    total = (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;
    idRows = db
      .prepare('SELECT id FROM sessions ORDER BY started_at DESC LIMIT ? OFFSET ?')
      .all(opts.limit, opts.offset) as Array<{ id: string }>;
  }

  const sessions = idRows
    .map((row) => getSessionSummary(db, row.id))
    .filter((s): s is SessionSummary => s !== undefined);

  return { sessions, total };
}

export function getSessionDetail(db: Db, id: string): SessionDetail | undefined {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  if (!row) return undefined;

  const segments = loadSegmentsWithSections(db, id);
  const summary = summarizeSession(row, segments);
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
    });
    previous = seg;
  }

  return { ...summary, segments: segmentSummaries };
}

export function getSessionTrace(db: Db, id: string): CompiledTrace | undefined {
  const summary = getSessionSummary(db, id);
  if (!summary) return undefined;
  const segments = loadSegmentsWithSections(db, id);
  return compileTrace(summary, segments);
}

export function getSegmentDetail(db: Db, sessionId: string, index: number): SegmentDetail | undefined {
  const sessionExists = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId);
  if (!sessionExists) return undefined;

  const sorted = loadSegmentsWithSections(db, sessionId).sort((a, b) => a.index - b.index);
  const segIdx = sorted.findIndex((s) => s.index === index);
  if (segIdx === -1) return undefined;

  const seg = sorted[segIdx]!;
  const previous = segIdx > 0 ? sorted[segIdx - 1] : undefined;
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
    },
    sections,
    removed: diff.removed,
  };
}
