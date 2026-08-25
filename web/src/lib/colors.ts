import { fnv1a64 } from '@context-trace/types';
import type { CompiledTrace } from '@context-trace/types';

/**
 * Service palette (data — the only saturated colors on screen). A service's
 * slot is `fnv1a64(name) mod 8` (see colorForService below), not order of
 * appearance — that keeps a service's color identical across every view
 * (session table vs. trace view) and every session, without needing shared
 * ordering state. Rare collisions between two service names are acceptable.
 * See .omc/autopilot/design-brief.md.
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

/** The `-soft` tint: same hue at low alpha over surface, for carried/background states. */
export function softColorFor(color: string): string {
  const varRef = color.match(/^var\((--service-[0-7])\)$/);
  if (varRef) return `var(${varRef[1]}-soft)`;
  return hexToRgba(color, 0.14);
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
 * Deterministic palette slot for a service name: fnv1a64(name) mod palette
 * length. Independent of when or where the name is first seen, so the same
 * service always lands on the same slot in every view and every session.
 */
export function paletteSlotForService(serviceName: string): number {
  const hash = BigInt(`0x${fnv1a64(serviceName)}`);
  return Number(hash % BigInt(SERVICE_PALETTE.length));
}

export function colorForService(serviceName: string): string {
  // A var() reference rather than raw hex so the data palette follows the
  // active theme (tokens.css defines light and dark values per slot).
  return `var(--service-${paletteSlotForService(serviceName)})`;
}

/**
 * Maps each service name to its deterministic color (see colorForService).
 * `servicesInOrder` only controls Map insertion/iteration order (used by
 * callers for legend/stacking order) — it has no effect on which color a
 * service gets. Safe against duplicate entries in the input.
 */
export function assignServiceColors(servicesInOrder: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const service of servicesInOrder) {
    if (!map.has(service)) {
      map.set(service, colorForService(service));
    }
  }
  return map;
}
