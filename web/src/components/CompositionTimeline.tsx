import { useState } from 'react';
import type { TraceSegment } from '@context-trace/types';
import { COLUMN_WIDTH, TIMELINE_HEIGHT } from '../lib/layout';
import { formatTokens } from '../lib/format';
import type { CSSVarStyle } from '../lib/css-vars';
import './CompositionTimeline.css';

interface CompositionTimelineProps {
  segments: TraceSegment[];
  colorMap: Map<string, string>;
  maxTokens: number;
  selectedIndex: number | null;
  hoveredService: string | null;
  /** Width of the sticky left gutter; below 60px the tick labels are hidden. */
  gutterWidth: number;
  onSelect: (index: number) => void;
}

interface Tooltip {
  x: number;
  y: number;
  label: string;
}

/** Round-number axis ticks: 1/2/2.5/5 × 10^n steps, at most `target` ticks. */
function niceTicks(max: number, target = 4): number[] {
  if (max <= 0) return [];
  const raw = max / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => max / s <= target) ?? mag * 10;
  const ticks: number[] = [];
  for (let v = step; v <= max; v += step) ticks.push(v);
  return ticks;
}

export function CompositionTimeline({ segments, colorMap, maxTokens, selectedIndex, hoveredService, gutterWidth, onSelect }: CompositionTimelineProps) {
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const width = gutterWidth + segments.length * COLUMN_WIDTH;
  const showTickLabels = gutterWidth >= 60;
  const barAreaHeight = TIMELINE_HEIGHT - 20;
  const serviceOrderList = [...colorMap.keys()];

  const points = segments.map((seg, i) => {
    const x = gutterWidth + i * COLUMN_WIDTH + COLUMN_WIDTH / 2;
    const y = maxTokens > 0 ? barAreaHeight - (seg.totalTokens / maxTokens) * barAreaHeight : barAreaHeight;
    return { x, y };
  });
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');

  const ticks = niceTicks(maxTokens);

  return (
    <div className="composition-timeline">
      {/* Sticky ordinate: stays pinned to the left edge while the chart pans.
          The backdrop is opaque so bars never show through under the labels. */}
      <div className="timeline__axis-overlay" aria-hidden>
        <div className="chart-gutter-backdrop" style={{ width: gutterWidth, height: TIMELINE_HEIGHT + 4 }} />
        {showTickLabels && (
          <span className="timeline__axis-sticky-label" style={{ top: 4 }}>
            tokens
          </span>
        )}
        {showTickLabels &&
          ticks.map((v) => (
            <span
              key={v}
              className="timeline__axis-sticky-label"
              style={{ top: 4 + barAreaHeight - (v / maxTokens) * barAreaHeight - 7 }}
            >
              {formatTokens(v)}
            </span>
          ))}
      </div>
      <svg width={width} height={TIMELINE_HEIGHT} role="img" aria-label="Composition timeline">
        {ticks.map((v) => {
          const y = barAreaHeight - (v / maxTokens) * barAreaHeight;
          return <line key={v} x1={0} y1={y} x2={width} y2={y} className="timeline__gridline" />;
        })}
        <line x1={0} y1={barAreaHeight} x2={width} y2={barAreaHeight} className="timeline__baseline" />
        {segments.map((seg, i) => {
          const x = gutterWidth + i * COLUMN_WIDTH;
          let cursorY = barAreaHeight;
          const orderedServices = [...seg.services].sort(
            (a, b) => serviceOrderList.indexOf(a.name) - serviceOrderList.indexOf(b.name),
          );
          const bars = orderedServices.map((svc) => {
            const h = maxTokens > 0 ? (svc.tokens / maxTokens) * barAreaHeight : 0;
            cursorY -= h;
            const dimmed = hoveredService != null && hoveredService !== svc.name;
            return (
              <rect
                key={svc.name}
                x={x + 4}
                y={cursorY}
                width={COLUMN_WIDTH - 8}
                height={h}
                fill={colorMap.get(svc.name) ?? '#0F6B62'}
                opacity={dimmed ? 0.18 : 1}
                onMouseEnter={() => setTooltip({ x: x + COLUMN_WIDTH / 2, y: cursorY, label: `${svc.name} · ${formatTokens(svc.tokens)}` })}
                onMouseLeave={() => setTooltip(null)}
              />
            );
          });
          return (
            <g
              key={seg.id}
              className="timeline__column"
              style={{ '--i': i } as CSSVarStyle}
              tabIndex={0}
              role="button"
              aria-label={`Segment ${seg.index}, ${formatTokens(seg.totalTokens)} tokens`}
              aria-pressed={selectedIndex === seg.index}
              onClick={() => onSelect(seg.index)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(seg.index);
                }
              }}
              onFocus={() =>
                setTooltip({ x: x + COLUMN_WIDTH / 2, y: barAreaHeight, label: `Segment ${seg.index} · ${formatTokens(seg.totalTokens)}` })
              }
              onBlur={() => setTooltip(null)}
            >
              <rect x={x} y={0} width={COLUMN_WIDTH} height={barAreaHeight} fill="transparent" />
              {bars}
            </g>
          );
        })}
        <path d={linePath} className="timeline__trend" fill="none" />
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={2} className="timeline__trend-dot" />
        ))}
      </svg>
      {tooltip && (
        <div className="composition-timeline__tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          {tooltip.label}
        </div>
      )}
    </div>
  );
}
