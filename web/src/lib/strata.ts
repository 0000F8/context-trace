import type { CompiledTrace, TraceSpan } from '@context-trace/types';

export type CellState = 'added' | 'changed' | 'carried' | 'removed';

const OP_TO_CELL_STATE = {
  add: 'added',
  change: 'changed',
  carry: 'carried',
} as const;

/**
 * For each section key, maps segment index -> cell state for the strata
 * grid. Derived directly from each segment's ops list (no lastIndex+1
 * arithmetic needed: a 'remove' op already lands on the exact segment where
 * the tombstone should render, and the lane simply has no cell after that).
 */
export function buildCellStates(trace: Pick<CompiledTrace, 'segments'>): Map<string, Map<number, CellState>> {
  const result = new Map<string, Map<number, CellState>>();
  for (const segment of trace.segments) {
    for (const op of segment.ops) {
      let byIndex = result.get(op.key);
      if (!byIndex) {
        byIndex = new Map();
        result.set(op.key, byIndex);
      }
      byIndex.set(segment.index, op.op === 'remove' ? 'removed' : OP_TO_CELL_STATE[op.op]);
    }
  }
  return result;
}

export interface StrataRow {
  span: TraceSpan;
}

export interface StrataGroup {
  service: string;
  rows: StrataRow[];
}

/**
 * Groups spans by service (rows = section keys grouped by service), ordering
 * groups by the session's service first-appearance order and rows within a
 * group by their own first appearance.
 */
export function groupSpansByService(spans: TraceSpan[], serviceOrder: string[]): StrataGroup[] {
  const groups = new Map<string, StrataRow[]>();
  for (const span of spans) {
    let rows = groups.get(span.service);
    if (!rows) {
      rows = [];
      groups.set(span.service, rows);
    }
    rows.push({ span });
  }
  for (const rows of groups.values()) {
    rows.sort((a, b) => a.span.firstIndex - b.span.firstIndex || a.span.key.localeCompare(b.span.key));
  }
  const knownOrder = serviceOrder.filter((name) => groups.has(name));
  const extra = [...groups.keys()].filter((name) => !serviceOrder.includes(name)).sort();
  return [...knownOrder, ...extra].map((service) => ({ service, rows: groups.get(service)! }));
}
