import { describe, expect, it } from 'vitest';
import { assignServiceColors, deriveServiceOrder, hexToRgba, SERVICE_PALETTE, softColorFor } from './colors';
import type { CompiledTrace } from '@context-trace/types';

describe('assignServiceColors', () => {
  it('assigns the first service to the first palette color', () => {
    const map = assignServiceColors(['memory']);
    expect(map.get('memory')).toBe(SERVICE_PALETTE[0]!.base);
  });

  it('assigns distinct services to distinct palette slots in order', () => {
    const map = assignServiceColors(['memory', 'retrieval', 'tools']);
    expect(map.get('memory')).toBe(SERVICE_PALETTE[0]!.base);
    expect(map.get('retrieval')).toBe(SERVICE_PALETTE[1]!.base);
    expect(map.get('tools')).toBe(SERVICE_PALETTE[2]!.base);
  });

  it('keeps a repeated service stable on its original color', () => {
    const map = assignServiceColors(['memory', 'retrieval', 'memory']);
    expect(map.get('memory')).toBe(SERVICE_PALETTE[0]!.base);
    expect(map.size).toBe(2);
  });

  it('cycles the palette after 8 distinct services', () => {
    const names = Array.from({ length: 9 }, (_, i) => `svc-${i}`);
    const map = assignServiceColors(names);
    expect(map.get('svc-0')).toBe(SERVICE_PALETTE[0]!.base);
    expect(map.get('svc-8')).toBe(SERVICE_PALETTE[0]!.base);
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
