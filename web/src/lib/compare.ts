/**
 * Pure helpers for the cross-session comparison page (spec2 §F). Kept
 * independent of React/DOM so they're unit-testable with plain object
 * fixtures instead of full CompiledTrace/SessionAnalytics payloads.
 */
import type { TraceSpan, TraceService } from '@context-trace/types';
import { formatTokens } from './format';

// ---------------------------------------------------------------------------
// Headline metric strip
// ---------------------------------------------------------------------------

export type MetricFormat = 'count' | 'tokens' | 'percent' | 'ms';
export type MetricJudgment = 'good' | 'bad' | 'neutral';
export type MetricDirection = 'lower-better' | 'higher-better' | 'neutral';

export interface HeadlineMetric {
  label: string;
  format: MetricFormat;
  a: number | undefined;
  b: number | undefined;
  /** b - a; undefined when either side is missing (e.g. no outcomes recorded). */
  delta: number | undefined;
  judgment: MetricJudgment;
}

/** Whether a delta reads as an improvement, a regression, or neither (see design-brief: "fewer tokens & lower latency = teal"). */
export function judgeDelta(delta: number, direction: MetricDirection): MetricJudgment {
  if (direction === 'neutral' || delta === 0) return 'neutral';
  if (direction === 'lower-better') return delta < 0 ? 'good' : 'bad';
  return delta > 0 ? 'good' : 'bad';
}

function makeMetric(label: string, a: number | undefined, b: number | undefined, direction: MetricDirection, format: MetricFormat): HeadlineMetric {
  const delta = a != null && b != null ? b - a : undefined;
  return { label, format, a, b, delta, judgment: delta != null ? judgeDelta(delta, direction) : 'neutral' };
}

export interface HeadlineSessionInput {
  segmentCount: number;
  peakTokens: number;
  totalTokens: number;
  /** 0..1 */
  carryRatio: number;
  avgLatencyMs?: number;
}

/** Builds the A|B|Δ rows for the headline strip. Avg latency is omitted entirely when neither side recorded outcomes. */
export function buildHeadlineMetrics(a: HeadlineSessionInput, b: HeadlineSessionInput): HeadlineMetric[] {
  const metrics: HeadlineMetric[] = [
    makeMetric('Segments', a.segmentCount, b.segmentCount, 'neutral', 'count'),
    makeMetric('Peak tokens', a.peakTokens, b.peakTokens, 'lower-better', 'tokens'),
    makeMetric('Latest tokens', a.totalTokens, b.totalTokens, 'lower-better', 'tokens'),
    makeMetric('Carry ratio', a.carryRatio * 100, b.carryRatio * 100, 'lower-better', 'percent'),
  ];
  if (a.avgLatencyMs != null || b.avgLatencyMs != null) {
    metrics.push(makeMetric('Avg latency', a.avgLatencyMs, b.avgLatencyMs, 'lower-better', 'ms'));
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// Delta / value formatting (mono numerals, explicit sign)
// ---------------------------------------------------------------------------

export function formatDeltaNumber(n: number): string {
  const rounded = Math.round(n);
  if (rounded === 0) return '±0';
  return rounded > 0 ? `+${formatTokens(rounded)}` : formatTokens(rounded);
}

/** Delta expressed in percentage points, e.g. "+4.2pp" / "-1.0pp" / "±0.0pp". */
export function formatDeltaPercent(n: number, digits = 1): string {
  const rounded = Number(n.toFixed(digits));
  if (rounded === 0) return `±${rounded.toFixed(digits)}pp`;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(digits)}pp`;
}

export function formatMetricValue(value: number | undefined, format: MetricFormat): string {
  if (value == null) return '—';
  switch (format) {
    case 'percent':
      return `${value.toFixed(1)}%`;
    case 'ms':
      return `${formatTokens(Math.round(value))} ms`;
    case 'count':
    case 'tokens':
    default:
      return formatTokens(Math.round(value));
  }
}

export function formatMetricDelta(delta: number | undefined, format: MetricFormat): string {
  if (delta == null) return '—';
  switch (format) {
    case 'percent':
      return formatDeltaPercent(delta);
    case 'ms':
      return `${formatDeltaNumber(Math.round(delta))} ms`;
    case 'count':
    case 'tokens':
    default:
      return formatDeltaNumber(delta);
  }
}

// ---------------------------------------------------------------------------
// Per-service token share
// ---------------------------------------------------------------------------

export interface ServiceShareRow {
  name: string;
  /** 0..1 */
  shareA: number;
  /** 0..1 */
  shareB: number;
  /** (shareB - shareA) * 100, in percentage points. */
  deltaPoints: number;
}

type ServiceTotals = Pick<TraceService, 'name' | 'totalTokens'>;

function computeServiceShares(services: ServiceTotals[]): Map<string, number> {
  const total = services.reduce((sum, s) => sum + s.totalTokens, 0);
  const shares = new Map<string, number>();
  for (const s of services) shares.set(s.name, total > 0 ? s.totalTokens / total : 0);
  return shares;
}

/** Union of services from both sessions, sorted by whichever side's share is larger (biggest contributors first). */
export function unionServiceShareRows(servicesA: ServiceTotals[], servicesB: ServiceTotals[]): ServiceShareRow[] {
  const sharesA = computeServiceShares(servicesA);
  const sharesB = computeServiceShares(servicesB);
  const names = new Set<string>([...sharesA.keys(), ...sharesB.keys()]);
  const rows: ServiceShareRow[] = [...names].map((name) => {
    const shareA = sharesA.get(name) ?? 0;
    const shareB = sharesB.get(name) ?? 0;
    return { name, shareA, shareB, deltaPoints: (shareB - shareA) * 100 };
  });
  rows.sort((x, y) => Math.max(y.shareA, y.shareB) - Math.max(x.shareA, x.shareB) || x.name.localeCompare(y.name));
  return rows;
}

// ---------------------------------------------------------------------------
// Aligned strata summary
// ---------------------------------------------------------------------------

export interface AlignedStrataRow {
  key: string;
  service: string;
  presenceA: number | null;
  versionsA: number | null;
  presenceB: number | null;
  versionsB: number | null;
}

export interface AlignedStrataGroup {
  service: string;
  rows: AlignedStrataRow[];
}

type SpanLike = Pick<TraceSpan, 'key' | 'service' | 'presence' | 'versions'>;

/**
 * Union of section keys across both traces, grouped by service (group order
 * = first appearance walking A's keys then B's; rows within a group sorted
 * by key). The side missing a key gets nulls, rendered as an em dash by the
 * caller — this is a summary grid, not per-segment cells.
 */
export function alignStrata(spansA: SpanLike[], spansB: SpanLike[]): AlignedStrataGroup[] {
  const byKeyA = new Map(spansA.map((s) => [s.key, s]));
  const byKeyB = new Map(spansB.map((s) => [s.key, s]));
  const allKeys = [...new Set([...byKeyA.keys(), ...byKeyB.keys()])];

  const groupOrder: string[] = [];
  const rowsByService = new Map<string, AlignedStrataRow[]>();

  for (const key of allKeys) {
    const a = byKeyA.get(key);
    const b = byKeyB.get(key);
    const service = (a ?? b)!.service;
    let rows = rowsByService.get(service);
    if (!rows) {
      rows = [];
      rowsByService.set(service, rows);
      groupOrder.push(service);
    }
    rows.push({
      key,
      service,
      presenceA: a ? a.presence.length : null,
      versionsA: a ? a.versions : null,
      presenceB: b ? b.presence.length : null,
      versionsB: b ? b.versions : null,
    });
  }

  return groupOrder.map((service) => ({
    service,
    rows: rowsByService.get(service)!.sort((x, y) => x.key.localeCompare(y.key)),
  }));
}
