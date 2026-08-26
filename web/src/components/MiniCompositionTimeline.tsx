import type { TraceSegment } from '@context-trace/types';
import { formatTokens } from '../lib/format';
import './MiniCompositionTimeline.css';

const COLUMN_WIDTH = 18;
const HEIGHT = 90;

interface MiniCompositionTimelineProps {
  label: string;
  segments: TraceSegment[];
  serviceOrder: string[];
  colorMap: Map<string, string>;
  /** Shared across both mini timelines so bar heights are comparable (spec2 §F). */
  maxTokens: number;
}

/**
 * A compact, non-interactive composition timeline for the comparison page —
 * same stacked-bar-by-service idea as CompositionTimeline, but no selection,
 * hover tooltip state, or trend line: just a shape to eyeball side by side.
 * Hover feedback is the native SVG <title>, per spec2 §F.
 */
export function MiniCompositionTimeline({ label, segments, serviceOrder, colorMap, maxTokens }: MiniCompositionTimelineProps) {
  const width = Math.max(segments.length * COLUMN_WIDTH, 1);

  return (
    <div className="mini-timeline">
      <svg width={width} height={HEIGHT} role="img" aria-label={`Composition timeline for ${label}`}>
        <line x1={0} y1={HEIGHT} x2={width} y2={HEIGHT} className="mini-timeline__baseline" />
        {segments.map((seg, i) => {
          const x = i * COLUMN_WIDTH;
          let cursorY = HEIGHT;
          const ordered = [...seg.services].sort((a, b) => serviceOrder.indexOf(a.name) - serviceOrder.indexOf(b.name));
          return (
            <g key={seg.id}>
              <title>{`Segment ${seg.index} · ${formatTokens(seg.totalTokens)} tokens`}</title>
              {ordered.map((svc) => {
                const h = maxTokens > 0 ? (svc.tokens / maxTokens) * HEIGHT : 0;
                cursorY -= h;
                return (
                  <rect key={svc.name} x={x + 2} y={cursorY} width={COLUMN_WIDTH - 4} height={h} fill={colorMap.get(svc.name) ?? '#0F6B62'} />
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
