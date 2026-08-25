/**
 * Shared wire + trace types and pure utilities for context-trace.
 * This package is the contract between the SDK, the server, and the web app.
 * It must stay dependency-free and runtime-agnostic (Node + browser).
 */

// ---------------------------------------------------------------------------
// Wire model
// ---------------------------------------------------------------------------

export type ServiceKind =
  | 'system'
  | 'memory'
  | 'retrieval'
  | 'tool'
  | 'history'
  | 'user'
  | 'other';

export type SectionRole = 'system' | 'user' | 'assistant' | 'tool';

export type SegmentKind = 'llm_call' | 'turn' | 'custom';

export interface Session {
  id: string;
  name: string;
  agent?: string;
  metadata?: Record<string, unknown>;
  startedAt: string; // ISO 8601
  endedAt?: string;
}

export interface Segment {
  id: string;
  sessionId: string;
  /** 0-based, client-assigned, monotonic within a session. */
  index: number;
  label?: string;
  kind: SegmentKind;
  model?: string;
  timestamp: string; // ISO 8601
  metadata?: Record<string, unknown>;
}

export interface Section {
  /** Stable identity across segments, e.g. 'mem:user-profile'. */
  key: string;
  /** Contributor name, e.g. 'memory'. */
  service: string;
  serviceKind: ServiceKind;
  role?: SectionRole;
  /** 0-based order within the segment. */
  position: number;
  content?: string;
  /** fnv1a-64 hex of content. */
  contentHash: string;
  tokens: number;
  metadata?: Record<string, unknown>;
}

export type SegmentWithSections = Segment & { sections: Section[] };

export type IngestEvent =
  | { type: 'session.started'; data: Session }
  | { type: 'segment.recorded'; data: SegmentWithSections }
  | { type: 'session.ended'; data: { sessionId: string; endedAt: string } };

export interface IngestRequest {
  events: IngestEvent[];
}

export interface IngestResponse {
  accepted: number;
  rejected?: Array<{ index: number; reason: string }>;
}

// ---------------------------------------------------------------------------
// Query / trace model (server -> web)
// ---------------------------------------------------------------------------

export type SectionState = 'added' | 'changed' | 'carried';

export interface DeltaCounts {
  added: number;
  removed: number;
  changed: number;
  carried: number;
}

export interface SessionSummary extends Session {
  segmentCount: number;
  sectionCount: number;
  /** Token total of the latest segment. */
  totalTokens: number;
  peakTokens: number;
  services: string[];
  lastActivityAt: string;
}

export interface SegmentSummary {
  id: string;
  index: number;
  label?: string;
  kind: SegmentKind;
  model?: string;
  timestamp: string;
  totalTokens: number;
  sectionCount: number;
  delta: DeltaCounts;
}

export interface SessionDetail extends SessionSummary {
  segments: SegmentSummary[];
}

export interface TraceSegmentService {
  name: string;
  kind: ServiceKind;
  tokens: number;
  sectionCount: number;
}

export type TraceOpKind = 'add' | 'change' | 'remove' | 'carry';

export interface TraceOp {
  op: TraceOpKind;
  key: string;
  service: string;
  tokens: number;
}

export interface TraceSegment {
  id: string;
  index: number;
  label?: string;
  kind: SegmentKind;
  model?: string;
  timestamp: string;
  totalTokens: number;
  sectionCount: number;
  services: TraceSegmentService[];
  /** Ordered by section position; removals appended last. */
  ops: TraceOp[];
}

export interface TraceSpan {
  key: string;
  service: string;
  serviceKind: ServiceKind;
  firstIndex: number;
  lastIndex: number;
  /** Segment indexes where the section is present. */
  presence: number[];
  /** 1 + number of content changes while present. */
  versions: number;
  tokensByIndex: Record<number, number>;
}

export interface TraceService {
  name: string;
  kind: ServiceKind;
  totalTokens: number;
  /** Max fraction (0..1) of any single segment's tokens owned by this service. */
  maxShare: number;
  sectionKeys: string[];
}

export interface CompiledTrace {
  session: SessionSummary;
  segments: TraceSegment[];
  spans: TraceSpan[];
  services: TraceService[];
}

export interface AnnotatedSection extends Section {
  state: SectionState;
  /** Present when state === 'changed'. */
  prevContent?: string;
  prevTokens?: number;
}

export interface SegmentDetail {
  segment: SegmentSummary;
  sections: AnnotatedSection[];
  /** Sections present in the previous segment but absent here. */
  removed: Section[];
}

export interface Stats {
  sessions: number;
  segments: number;
  sections: number;
  totalTokens: number;
  lastIngestAt: string | null;
}

// ---------------------------------------------------------------------------
// Pure utilities
// ---------------------------------------------------------------------------

/**
 * FNV-1a 64-bit hash, hex-encoded (16 chars). Stable across JS runtimes.
 * Implemented on four 16-bit limbs instead of BigInt: the FNV prime is
 * 2^40 + 0x1b3, so v * prime mod 2^64 needs only the p0=0x1b3 and p2=0x100
 * limb products — every intermediate stays well inside double precision,
 * and this runs severalfold faster than the BigInt version on large inputs.
 */
export function fnv1a64(input: string): string {
  // offset basis 0xcbf29ce484222325 as limbs, least-significant first
  let v0 = 0x2325;
  let v1 = 0x8422;
  let v2 = 0x9ce4;
  let v3 = 0xcbf2;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i); // UTF-16 code unit, fits in limbs 0-1
    v0 ^= c & 0xffff;
    const t0 = v0 * 0x1b3;
    const t1 = v1 * 0x1b3;
    const t2 = v2 * 0x1b3 + v0 * 0x100;
    const t3 = v3 * 0x1b3 + v1 * 0x100;
    v0 = t0 & 0xffff;
    const c1 = t1 + (t0 >>> 16);
    v1 = c1 & 0xffff;
    const c2 = t2 + (c1 >>> 16);
    v2 = c2 & 0xffff;
    v3 = (t3 + (c2 >>> 16)) & 0xffff;
  }
  const hi = ((v3 << 16) | v2) >>> 0;
  const lo = ((v1 << 16) | v0) >>> 0;
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/** Rough token estimate: ceil(chars / 4). Good enough for budget visualization. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // crockford-ish, lowercase

/**
 * ULID-like sortable id: 9 chars of base32 timestamp + 14 chars of randomness.
 * No external deps; monotonic enough for trace ordering (ties broken by randomness).
 */
export function generateId(prefix?: string): string {
  let ts = Date.now();
  let time = '';
  for (let i = 0; i < 9; i++) {
    time = ID_ALPHABET[ts % 32] + time;
    ts = Math.floor(ts / 32);
  }
  let rand = '';
  for (let i = 0; i < 14; i++) {
    rand += ID_ALPHABET[Math.floor(Math.random() * 32)];
  }
  const id = time + rand;
  return prefix ? `${prefix}_${id}` : id;
}
