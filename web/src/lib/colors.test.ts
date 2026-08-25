import { describe, expect, it } from 'vitest';
import {
  assignServiceColors,
  colorForService,
  deriveServiceOrder,
  hexToRgba,
  paletteSlotForService,
  SERVICE_PALETTE,
  softColorFor,
} from './colors';
import type { CompiledTrace } from '@context-trace/types';

describe('colorForService / paletteSlotForService', () => {
  it('is deterministic for a given service name', () => {
    expect(colorForService('memory')).toBe(colorForService('memory'));
    expect(paletteSlotForService('memory')).toBe(paletteSlotForService('memory'));
  });

  it('always returns a slot within the palette', () => {
    const paletteColors = SERVICE_PALETTE.map((p) => p.base);
    expect(paletteColors).toContain(colorForService('retrieval'));
    const slot = paletteSlotForService('retrieval');
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(slot).toBeLessThan(SERVICE_PALETTE.length);
  });

  it('does not depend on first-appearance order', () => {
    const fromOneOrder = assignServiceColors(['zeta', 'memory', 'retrieval']);
    const fromAnotherOrder = assignServiceColors(['retrieval', 'memory', 'zeta']);
    for (const name of ['memory', 'retrieval', 'zeta']) {
      expect(fromOneOrder.get(name)).toBe(fromAnotherOrder.get(name));
      expect(fromOneOrder.get(name)).toBe(colorForService(name));
    }
  });
});

describe('assignServiceColors', () => {
  it('maps each service to its deterministic color', () => {
    const map = assignServiceColors(['memory', 'retrieval', 'tools']);
    expect(map.get('memory')).toBe(colorForService('memory'));
    expect(map.get('retrieval')).toBe(colorForService('retrieval'));
    expect(map.get('tools')).toBe(colorForService('tools'));
  });

  it('keeps a repeated service stable on its one color and dedups', () => {
    const map = assignServiceColors(['memory', 'retrieval', 'memory']);
    expect(map.get('memory')).toBe(colorForService('memory'));
    expect(map.size).toBe(2);
  });

  it('agrees between an alphabetical list (server order) and a first-appearance list (trace order)', () => {
    const names = ['memory', 'retrieval', 'tools'];
    const alphabetical = assignServiceColors([...names].sort());
    const firstAppearance = assignServiceColors(['tools', 'memory', 'retrieval']);
    for (const name of names) {
      expect(alphabetical.get(name)).toBe(firstAppearance.get(name));
    }
  });
});

describe('hexToRgba / softColorFor', () => {
  it('converts hex to an rgba string at the given alpha', () => {
    expect(hexToRgba('#0F6B62', 0.5)).toBe('rgba(15, 107, 98, 0.5)');
  });

  it('softColorFor uses 14% alpha', () => {
    expect(softColorFor('#C4652A')).toBe('rgba(196, 101, 42, 0.14)');
  });
});

describe('deriveServiceOrder', () => {
  it('walks segments by index, then ops by position, deduping first appearances', () => {
    const trace: Pick<CompiledTrace, 'segments'> = {
      segments: [
        {
          id: 's1',
          index: 1,
          kind: 'llm_call',
          timestamp: '2026-01-01T00:00:00Z',
          totalTokens: 10,
          sectionCount: 2,
          services: [],
          ops: [
            { op: 'add', key: 'k2', service: 'retrieval', tokens: 5 },
            { op: 'add', key: 'k3', service: 'memory', tokens: 5 },
          ],
        },
        {
          id: 's0',
          index: 0,
          kind: 'llm_call',
          timestamp: '2026-01-01T00:00:00Z',
          totalTokens: 5,
          sectionCount: 1,
          services: [],
          ops: [{ op: 'add', key: 'k1', service: 'memory', tokens: 5 }],
        },
      ],
    };
    expect(deriveServiceOrder(trace)).toEqual(['memory', 'retrieval']);
  });
});
