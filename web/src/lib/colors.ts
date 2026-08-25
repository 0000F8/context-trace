import type { CompiledTrace } from '@context-trace/types';

/**
 * Service palette (data — the only saturated colors on screen). Assigned to
 * services by order of first appearance in a session, deterministic, cycling
 * after 8. See .omc/autopilot/design-brief.md.
 */
export const SERVICE_PALETTE: ReadonlyArray<{ name: string; base: string }> = [
  { name: 'teal', base: '#0F6B62' },
  { name: 'copper', base: '#C4652A' },
  { name: 'cobalt', base: '#3E5FA8' },
  { name: 'violet', base: '#8A5FB0' },
  { name: 'madder', base: '#B03A5B' },
  { name: 'moss', base: '#5E7D2F' },
  { name: 'ochre', base: '#946F23' },
  { name: 'slate-cyan', base: '#4A7D8C' },
];

export function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The `-soft` tint: same hue at ~14% alpha over surface, for carried/background states. */
export function softColorFor(hex: string): string {
  return hexToRgba(hex, 0.14);
}

/**
 * Derives the order in which services first appear in a compiled trace,
 * walking segments in index order and, within each, ops in position order
 * (removals are appended last in the wire contract, which is fine — a
 * removal can never be a first appearance).
 */
export function deriveServiceOrder(trace: Pick<CompiledTrace, 'segments'>): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const segments = [...trace.segments].sort((a, b) => a.index - b.index);
  for (const segment of segments) {
    for (const op of segment.ops) {
      if (!seen.has(op.service)) {
        seen.add(op.service);
        order.push(op.service);
      }
    }
  }
  return order;
}

/**
 * Assigns each service a stable palette slot by first-appearance order,
 * cycling after 8 services. Safe against duplicate entries in the input.
 */
export function assignServiceColors(servicesInOrder: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const service of servicesInOrder) {
    if (!map.has(service)) {
      const slot = SERVICE_PALETTE[map.size % SERVICE_PALETTE.length]!;
      map.set(service, slot.base);
    }
  }
  return map;
}
