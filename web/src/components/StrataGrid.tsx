import { useState } from 'react';
import type { TraceSegment } from '@context-trace/types';
import type { CellState, StrataGroup } from '../lib/strata';
import { COLUMN_WIDTH, ROW_HEIGHT } from '../lib/layout';
import { softColorFor } from '../lib/colors';
import { truncateMiddle } from '../lib/format';
import './StrataGrid.css';

interface StrataGridProps {
  groups: StrataGroup[];
  segments: TraceSegment[];
  cellStates: Map<string, Map<number, CellState>>;
  colorMap: Map<string, string>;
  hoveredService: string | null;
  /** Width of the sticky left gutter; below 60px labels collapse to color ticks. */
  gutterWidth: number;
  /** Drag-resize callback; null resets to auto-fit. Handle hidden when absent. */
  onResizeGutter?: (width: number | null) => void;
  onSelectSegment: (index: number) => void;
  onSelectSection: (key: string) => void;
}

const CELL_PAD = 3;

export function StrataGrid({ groups, segments, cellStates, colorMap, hoveredService, gutterWidth, onResizeGutter, onSelectSegment, onSelectSection }: StrataGridProps) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; label: string } | null>(null);
  const rows = groups.flatMap((g) => g.rows.map((row) => ({ span: row.span, service: g.service })));
  const width = gutterWidth + segments.length * COLUMN_WIDTH;
  // No bottom index axis of its own: the sticky composition timeline above
  // carries the always-visible segment-index row for both charts.
  const height = rows.length * ROW_HEIGHT + 4;
  const showLabelText = gutterWidth >= 60;
  // Char budget for middle-truncation at the current gutter width (mono ~7.2px/char).
  const labelChars = Math.max(6, Math.floor((gutterWidth - 30) / 7.2));

  const startGutterDrag = (e: React.PointerEvent) => {
    if (!onResizeGutter) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = gutterWidth;
    const move = (ev: PointerEvent) => {
      onResizeGutter(Math.min(480, Math.max(120, startW + ev.clientX - startX)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (rows.length === 0) {
    return <div className="strata-grid strata-grid--empty">No sections recorded for this session.</div>;
  }

  return (
    <div className="strata-grid">
      {/* Sticky row labels: stay pinned while the cell grid pans horizontally.
          The backdrop is opaque so cells never show through under the gutter. */}
      <div className="strata-grid__label-overlay" aria-hidden>
        <div className="chart-gutter-backdrop" style={{ width: gutterWidth, height: rows.length * ROW_HEIGHT }} />
        {rows.map((row, r) => {
          const color = colorMap.get(row.service) ?? '#0F6B62';
          const dimmedRow = hoveredService != null && hoveredService !== row.service;
          return (
            <div
              key={row.span.key}
              className={`strata-grid__sticky-label${dimmedRow ? ' is-dimmed' : ''}`}
              style={{ top: r * ROW_HEIGHT, width: gutterWidth - 10, height: ROW_HEIGHT - 2, borderLeftColor: color }}
              title={row.span.key}
            >
              {showLabelText ? truncateMiddle(row.span.key, labelChars) : ''}
            </div>
          );
        })}
        {showLabelText && onResizeGutter && (
          <div
            className="strata-grid__resize-handle"
            style={{ left: gutterWidth - 4, height: rows.length * ROW_HEIGHT }}
            title="Drag to resize labels; double-click to fit"
            onPointerDown={startGutterDrag}
            onDoubleClick={() => onResizeGutter(null)}
          />
        )}
      </div>
      <svg width={width} height={height} role="img" aria-label="Section lanes (strata grid)">
        {rows.map((row, r) => {
          const y = r * ROW_HEIGHT;
          const color = colorMap.get(row.service) ?? '#0F6B62';
          const dimmedRow = hoveredService != null && hoveredService !== row.service;
          return (
            <g key={row.span.key} className={dimmedRow ? 'is-dimmed' : ''}>
              {segments.map((seg, c) => {
                const state = cellStates.get(row.span.key)?.get(seg.index);
                if (!state) return null;
                const x = gutterWidth + c * COLUMN_WIDTH + CELL_PAD;
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
      </svg>
      {tooltip && (
        <div className="strata-grid__tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          {tooltip.label}
        </div>
      )}
    </div>
  );
}
