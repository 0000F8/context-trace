import { useState } from 'react';
import type { TraceSegment } from '@context-trace/types';
import type { CellState, StrataGroup } from '../lib/strata';
import { COLUMN_WIDTH, ROW_HEIGHT, ROW_LABEL_WIDTH } from '../lib/layout';
import { softColorFor } from '../lib/colors';
import { truncateMiddle } from '../lib/format';
import './StrataGrid.css';

interface StrataGridProps {
  groups: StrataGroup[];
  segments: TraceSegment[];
  cellStates: Map<string, Map<number, CellState>>;
  colorMap: Map<string, string>;
  hoveredService: string | null;
  onSelectSegment: (index: number) => void;
  onSelectSection: (key: string) => void;
}

const CELL_PAD = 3;

export function StrataGrid({ groups, segments, cellStates, colorMap, hoveredService, onSelectSegment, onSelectSection }: StrataGridProps) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; label: string } | null>(null);
  const rows = groups.flatMap((g) => g.rows.map((row) => ({ span: row.span, service: g.service })));
  const width = ROW_LABEL_WIDTH + segments.length * COLUMN_WIDTH;
  const height = rows.length * ROW_HEIGHT + 24;

  if (rows.length === 0) {
    return <div className="strata-grid strata-grid--empty">No sections recorded for this session.</div>;
  }

  return (
    <div className="strata-grid">
      <svg width={width} height={height} role="img" aria-label="Section lanes (strata grid)">
        {rows.map((row, r) => {
          const y = r * ROW_HEIGHT;
          const color = colorMap.get(row.service) ?? '#0F6B62';
          const dimmedRow = hoveredService != null && hoveredService !== row.service;
          return (
            <g key={row.span.key} className={dimmedRow ? 'is-dimmed' : ''}>
              <rect x={0} y={y} width={4} height={ROW_HEIGHT - 2} fill={color} />
              <text x={12} y={y + ROW_HEIGHT / 2 + 4} className="strata-grid__label">
                <title>{row.span.key}</title>
                {truncateMiddle(row.span.key, 22)}
              </text>
              {segments.map((seg, c) => {
                const state = cellStates.get(row.span.key)?.get(seg.index);
                if (!state) return null;
                const x = ROW_LABEL_WIDTH + c * COLUMN_WIDTH + CELL_PAD;
                const w = COLUMN_WIDTH - CELL_PAD * 2;
                const cellH = ROW_HEIGHT - 6;
                const cellY = y + 3;
                return (
                  <g
                    key={seg.id}
                    tabIndex={0}
                    role="button"
                    aria-label={`${row.span.key}, segment ${seg.index}, ${state}`}
                    className={`strata-cell strata-cell--${state}`}
                    onClick={() => {
                      onSelectSegment(seg.index);
                      onSelectSection(row.span.key);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectSegment(seg.index);
                        onSelectSection(row.span.key);
                      }
                    }}
                    onMouseEnter={() => setTooltip({ x, y: cellY, label: `${row.span.key} · ${state}` })}
                    onMouseLeave={() => setTooltip(null)}
                    onFocus={() => setTooltip({ x, y: cellY, label: `${row.span.key} · ${state}` })}
                    onBlur={() => setTooltip(null)}
                  >
                    {state === 'removed' ? (
                      <rect x={x} y={cellY} width={w} height={cellH} rx={2} fill="none" stroke="var(--ink-2)" strokeDasharray="2,2" />
                    ) : (
                      <>
                        <rect x={x} y={cellY} width={w} height={cellH} rx={2} fill={state === 'carried' ? softColorFor(color) : color} />
                        {state === 'added' && <rect x={x + 1} y={cellY + 1} width={w - 2} height={2} fill="var(--surface)" opacity={0.55} />}
                        {state === 'changed' && (
                          <polygon points={`${x + w - 7},${cellY} ${x + w},${cellY} ${x + w},${cellY + 7}`} fill="var(--surface)" opacity={0.75} />
                        )}
                      </>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
        {segments.map((seg, c) => (
          <text
            key={seg.id}
            x={ROW_LABEL_WIDTH + c * COLUMN_WIDTH + COLUMN_WIDTH / 2}
            y={rows.length * ROW_HEIGHT + 16}
            className="strata-grid__axis-label"
            textAnchor="middle"
          >
            {seg.index}
          </text>
        ))}
      </svg>
      {tooltip && (
        <div className="strata-grid__tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          {tooltip.label}
        </div>
      )}
    </div>
  );
}
