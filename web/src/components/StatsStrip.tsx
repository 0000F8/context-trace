import type { Stats } from '@context-trace/types';
import { formatTokens } from '../lib/format';
import './StatsStrip.css';

export function StatsStrip({ stats }: { stats: Stats }) {
  return (
    <dl className="stats-strip">
      <div className="stats-strip__figure">
        <dd>{stats.sessions.toLocaleString('en-US')}</dd>
        <dt>Sessions</dt>
      </div>
      <div className="stats-strip__figure">
        <dd>{stats.segments.toLocaleString('en-US')}</dd>
        <dt>Segments</dt>
      </div>
      <div className="stats-strip__figure">
        <dd>{formatTokens(stats.totalTokens)}</dd>
        <dt>Tokens tracked</dt>
      </div>
    </dl>
  );
}
