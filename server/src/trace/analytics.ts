/**
 * Pure analytics over a compiled trace: no DB/HTTP imports, so this is unit-testable
 * in isolation. Thresholds are spec-fixed constants, not configurable — this keeps the
 * findings comparable across sessions instead of being a per-request knob.
 */
import type { CompiledTrace, Finding, SessionAnalytics } from '@context-trace/types';

const THRASH_MAX_GAP = 5;
const DEAD_WEIGHT_MIN_PRESENCE = 10;
const DEAD_WEIGHT_MIN_TOKENS = 200;
const CHURN_MIN_PRESENCE = 4;
const CHURN_MIN_RATE = 0.5;

function readWindow(session: CompiledTrace['session'], fallback: number | undefined): number | undefined {
  const w = session.metadata?.window;
  if (typeof w === 'number' && Number.isFinite(w)) return w;
  return fallback;
}

/**
 * Computes findings + rollups for a session's compiled trace. `window` is an optional
 * fallback used only when `session.metadata.window` isn't itself a finite number —
 * the metadata value always wins when present, matching `SessionAnalytics.window`'s
 * documented source of truth.
 */
export function computeAnalytics(trace: CompiledTrace, window?: number): SessionAnalytics {
  const effectiveWindow = readWindow(trace.session, window);
  const segments = [...trace.segments].sort((a, b) => a.index - b.index);

  const perSegment: SessionAnalytics['perSegment'] = segments.map((seg) => {
    let addedTokens = 0;
    let changedTokens = 0;
    let carriedTokens = 0;
    let removedTokens = 0;
    for (const op of seg.ops) {
      if (op.op === 'add') addedTokens += op.tokens;
      else if (op.op === 'change') changedTokens += op.tokens;
      else if (op.op === 'carry') carriedTokens += op.tokens;
      else removedTokens += op.tokens;
    }
    const totalTokens = seg.totalTokens;
    return {
      index: seg.index,
      totalTokens,
      addedTokens,
      changedTokens,
      carriedTokens,
      removedTokens,
      carryRatio: totalTokens > 0 ? carriedTokens / totalTokens : 0,
      overWindow: effectiveWindow !== undefined && totalTokens > effectiveWindow,
      latencyMs: seg.outcome?.latencyMs,
    };
  });

  const firstIndex = segments.length > 0 ? segments[0]!.index : undefined;
  let sumCarried = 0;
  let sumTotal = 0;
  for (const s of perSegment) {
    if (firstIndex !== undefined && s.index > firstIndex) {
      sumCarried += s.carriedTokens;
      sumTotal += s.totalTokens;
    }
  }
  const carryRatio = sumTotal > 0 ? sumCarried / sumTotal : 0;

  const churn: SessionAnalytics['churn'] = [];
  const deadWeight: SessionAnalytics['deadWeight'] = [];
  const thrash: SessionAnalytics['thrash'] = [];

  for (const span of trace.spans) {
    const presence = span.presence.length;
    const changes = Math.max(0, span.versions - 1);
    const churnRate = presence > 0 ? changes / presence : 0;

    if (presence >= CHURN_MIN_PRESENCE && churnRate >= CHURN_MIN_RATE) {
      churn.push({ key: span.key, service: span.service, presence, changes, churnRate });
    }

    if (presence >= DEAD_WEIGHT_MIN_PRESENCE && changes === 0) {
      const lastTokens = span.tokensByIndex[span.lastIndex] ?? 0;
      if (lastTokens >= DEAD_WEIGHT_MIN_TOKENS) {
        deadWeight.push({ key: span.key, service: span.service, carriedSegments: presence, tokens: lastTokens });
      }
    }

    const sortedPresence = [...span.presence].sort((a, b) => a - b);
    for (let i = 1; i < sortedPresence.length; i++) {
      const prevIdx = sortedPresence[i - 1]!;
      const curIdx = sortedPresence[i]!;
      if (curIdx - prevIdx <= 1) continue; // contiguous — no removal/re-add happened
      const removedAt = prevIdx + 1;
      const readdedAt = curIdx;
      const gap = readdedAt - removedAt;
      if (gap <= THRASH_MAX_GAP) {
        thrash.push({ key: span.key, service: span.service, removedAt, readdedAt, gap });
      }
    }
  }

  const findings: Finding[] = [];
  for (const s of perSegment) {
    if (!s.overWindow) continue;
    findings.push({
      severity: 'warning',
      kind: 'over-window',
      message: `Segment ${s.index} carries ${s.totalTokens} tokens, over the ${effectiveWindow}-token window.`,
      segmentIndex: s.index,
    });
  }
  for (const t of thrash) {
    findings.push({
      severity: 'warning',
      kind: 'thrash',
      message: `"${t.key}" was dropped and pulled back in ${t.gap} segment${t.gap === 1 ? '' : 's'} — consider keeping it steady or letting it go for good.`,
      key: t.key,
      segmentIndex: t.readdedAt,
    });
  }
  for (const c of churn) {
    findings.push({
      severity: 'notice',
      kind: 'churn',
      message: `"${c.key}" changed ${c.changes} of ${c.presence} times it appeared — a ${Math.round(c.churnRate * 100)}% churn rate.`,
      key: c.key,
    });
  }
  for (const d of deadWeight) {
    findings.push({
      severity: 'notice',
      kind: 'dead-weight',
      message: `"${d.key}" has sat unchanged for ${d.carriedSegments} segments at ${d.tokens} tokens — a candidate for summarizing or dropping.`,
      key: d.key,
    });
  }

  const latencies: number[] = [];
  const scoreSums = new Map<string, { sum: number; count: number }>();
  for (const seg of segments) {
    const outcome = seg.outcome;
    if (!outcome) continue;
    if (typeof outcome.latencyMs === 'number') latencies.push(outcome.latencyMs);
    if (outcome.scores) {
      for (const [key, value] of Object.entries(outcome.scores)) {
        if (typeof value !== 'number') continue;
        const entry = scoreSums.get(key) ?? { sum: 0, count: 0 };
        entry.sum += value;
        entry.count += 1;
        scoreSums.set(key, entry);
      }
    }
  }

  let outcomes: SessionAnalytics['outcomes'];
  if (latencies.length > 0 || scoreSums.size > 0) {
    outcomes = {};
    if (latencies.length > 0) {
      outcomes.avgLatencyMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    }
    if (scoreSums.size > 0) {
      const scoreAverages: Record<string, number> = {};
      for (const [key, { sum, count }] of scoreSums.entries()) scoreAverages[key] = sum / count;
      outcomes.scoreAverages = scoreAverages;
    }
  }

  return { window: effectiveWindow, carryRatio, perSegment, churn, deadWeight, thrash, findings, outcomes };
}
