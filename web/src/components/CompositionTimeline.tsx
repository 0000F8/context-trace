import { useState } from 'react';
import type { TraceSegment } from '@context-trace/types';
import { COLUMN_WIDTH, ROW_LABEL_WIDTH, TIMELINE_HEIGHT } from '../lib/layout';
import { formatTokens } from '../lib/format';
import type { CSSVarStyle } from '../lib/css-vars';
import './CompositionTimeline.css';

interface CompositionTimelineProps {
  segments: TraceSegment[];
  colorMap: Map<string, string>;
  maxTokens: number;
  selectedIndex: number | null;
  hoveredService: string | null;
  onSelect: (index: number) => void;
}

interface Tooltip {
  x: number;
  y: number;
  label: string;
}

export function CompositionTimeline({ segments, colorMap, maxTokens, selectedIndex, hoveredService, onSelect }: CompositionTimelineProps) {
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const width = ROW_LABEL_WIDTH + segments.length * COLUMN_WIDTH;
  const barAreaHeight = TIMELINE_HEIGHT - 20;
  const serviceOrderList = [...colorMap.keys()];

  const points = segments.map((seg, i) => {
    const x = ROW_LABEL_WIDTH + i * COLUMN_WIDTH + COLUMN_WIDTH / 2;
    const y = maxTokens > 0 ? barAreaHeight - (seg.totalTokens / maxTokens) * barAreaHeight : barAreaHeight;
    return { x, y };
  });
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');

  return (
    <div className="composition-timeline">
      <svg width={width} height={TIMELINE_HEIGHT} role="img" aria-label="Composition timeline">
        <text x={8} y={14} className="chart-axis-label">
          tokens
        </text>
        {segments.map((seg, i) => {
          const x = ROW_LABEL_WIDTH + i * COLUMN_WIDTH;
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
