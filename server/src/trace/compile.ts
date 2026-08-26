/**
 * Pure trace compilation: turns a session's segments (each a full snapshot of
 * sections) into the compiled temporal + procedural trace. No DB or HTTP
 * imports here — everything operates on plain in-memory structures so this
 * module is unit-testable in isolation.
 */
import type {
  CompiledTrace,
  DeltaCounts,
  Section,
  SectionState,
  Segment,
  SegmentOutcome,
  ServiceKind,
  SessionSummary,
  TraceOp,
  TraceOpKind,
  TraceSegment,
  TraceSegmentService,
  TraceService,
  TraceSpan,
} from '@context-trace/types';

/** A segment plus the sections that make up its snapshot. */
export interface TraceSourceSegment extends Segment {
  sections: Section[];
  outcome?: SegmentOutcome;
}

export interface DiffResult {
  added: Section[];
  changed: Array<{ current: Section; previous: Section }>;
  carried: Section[];
  removed: Section[];
}

/**
 * Diffs `current` sections against `previous` sections (or `undefined` when
 * there is no previous segment), keyed by section `key`.
 */
export function diffSections(current: Section[], previous: Section[] | undefined): DiffResult {
  const prevByKey = new Map<string, Section>();
  for (const s of previous ?? []) prevByKey.set(s.key, s);

  const currentKeys = new Set<string>();
  const added: Section[] = [];
  const changed: Array<{ current: Section; previous: Section }> = [];
  const carried: Section[] = [];

  for (const section of current) {
    currentKeys.add(section.key);
    const prev = prevByKey.get(section.key);
    if (!prev) {
      added.push(section);
    } else if (prev.contentHash !== section.contentHash) {
      changed.push({ current: section, previous: prev });
    } else {
      carried.push(section);
    }
  }

  const removed: Section[] = [];
  for (const s of previous ?? []) {
    if (!currentKeys.has(s.key)) removed.push(s);
  }

  return { added, changed, carried, removed };
}

export function deltaCounts(diff: DiffResult): DeltaCounts {
  return {
    added: diff.added.length,
    removed: diff.removed.length,
    changed: diff.changed.length,
    carried: diff.carried.length,
  };
}

const OP_KIND_BY_STATE: Record<SectionState, TraceOpKind> = {
  added: 'add',
  changed: 'change',
  carried: 'carry',
};

/** Compiles the full temporal + procedural trace for a session. */
export function compileTrace(session: SessionSummary, segments: TraceSourceSegment[]): CompiledTrace {
  const sorted = [...segments].sort((a, b) => a.index - b.index);

  interface SpanAcc {
    key: string;
    service: string;
    serviceKind: ServiceKind;
    indexes: number[];
    tokensByIndex: Record<number, number>;
    hashByIndex: Record<number, string>;
  }
  const spanAccByKey = new Map<string, SpanAcc>();

  interface ServiceAcc {
    name: string;
    kind: ServiceKind;
    totalTokens: number;
    maxShare: number;
    sectionKeys: Set<string>;
  }
  const serviceAccByName = new Map<string, ServiceAcc>();

  const traceSegments: TraceSegment[] = [];
  let previous: TraceSourceSegment | undefined;

  for (const seg of sorted) {
    const diff = diffSections(seg.sections, previous?.sections);

    const stateByKey = new Map<string, SectionState>();
    for (const s of diff.added) stateByKey.set(s.key, 'added');
    for (const { current } of diff.changed) stateByKey.set(current.key, 'changed');
    for (const s of diff.carried) stateByKey.set(s.key, 'carried');

    const currentOps: TraceOp[] = [...seg.sections]
      .sort((a, b) => a.position - b.position)
      .map((s) => {
        const state = stateByKey.get(s.key)!;
        return { op: OP_KIND_BY_STATE[state], key: s.key, service: s.service, tokens: s.tokens };
      });

    const removedOps: TraceOp[] = [...diff.removed]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ op: 'remove' as const, key: s.key, service: s.service, tokens: s.tokens }));

    const ops = [...currentOps, ...removedOps];

    const svcMap = new Map<string, { kind: ServiceKind; tokens: number; count: number }>();
    for (const s of seg.sections) {
      const entry = svcMap.get(s.service) ?? { kind: s.serviceKind, tokens: 0, count: 0 };
      entry.tokens += s.tokens;
      entry.count += 1;
      svcMap.set(s.service, entry);
    }
    const services: TraceSegmentService[] = [...svcMap.entries()]
      .map(([name, v]) => ({ name, kind: v.kind, tokens: v.tokens, sectionCount: v.count }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const totalTokens = seg.sections.reduce((sum, s) => sum + s.tokens, 0);

    traceSegments.push({
      id: seg.id,
      index: seg.index,
      label: seg.label,
      kind: seg.kind,
      model: seg.model,
      timestamp: seg.timestamp,
      totalTokens,
      sectionCount: seg.sections.length,
      services,
      ops,
      outcome: seg.outcome,
    });

    for (const s of seg.sections) {
      let acc = spanAccByKey.get(s.key);
      if (!acc) {
        acc = {
          key: s.key,
          service: s.service,
          serviceKind: s.serviceKind,
          indexes: [],
          tokensByIndex: {},
          hashByIndex: {},
        };
        spanAccByKey.set(s.key, acc);
      }
      acc.service = s.service;
      acc.serviceKind = s.serviceKind;
      acc.indexes.push(seg.index);
      acc.tokensByIndex[seg.index] = s.tokens;
      acc.hashByIndex[seg.index] = s.contentHash;
    }

    for (const [name, v] of svcMap.entries()) {
      let sacc = serviceAccByName.get(name);
      if (!sacc) {
        sacc = { name, kind: v.kind, totalTokens: 0, maxShare: 0, sectionKeys: new Set() };
        serviceAccByName.set(name, sacc);
      }
      sacc.kind = v.kind;
      sacc.totalTokens += v.tokens;
      const share = totalTokens > 0 ? v.tokens / totalTokens : 0;
      if (share > sacc.maxShare) sacc.maxShare = share;
    }
    for (const s of seg.sections) {
      serviceAccByName.get(s.service)?.sectionKeys.add(s.key);
    }

    previous = seg;
  }

  const spans: TraceSpan[] = [...spanAccByKey.values()]
    .map((acc): TraceSpan => {
      const indexes = [...acc.indexes].sort((a, b) => a - b);
      let versions = indexes.length > 0 ? 1 : 0;
      for (let i = 1; i < indexes.length; i++) {
        const prevHash = acc.hashByIndex[indexes[i - 1]!]!;
        const curHash = acc.hashByIndex[indexes[i]!]!;
        if (prevHash !== curHash) versions++;
      }
      return {
        key: acc.key,
        service: acc.service,
        serviceKind: acc.serviceKind,
        firstIndex: indexes[0] ?? 0,
        lastIndex: indexes[indexes.length - 1] ?? 0,
        presence: indexes,
        versions,
        tokensByIndex: acc.tokensByIndex,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  const services: TraceService[] = [...serviceAccByName.values()]
    .map((s): TraceService => ({
      name: s.name,
      kind: s.kind,
      totalTokens: s.totalTokens,
      maxShare: s.maxShare,
      sectionKeys: [...s.sectionKeys].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { session, segments: traceSegments, spans, services };
}
