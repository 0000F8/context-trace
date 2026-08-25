import type { SessionSummary, TraceService } from '@context-trace/types';
import { formatDateTime, formatTokens } from '../lib/format';
import './LeftRail.css';

interface LeftRailProps {
  session: SessionSummary;
  services: TraceService[];
  serviceOrder: string[];
  colorMap: Map<string, string>;
  hoveredService: string | null;
  onHoverService: (service: string | null) => void;
}

export function LeftRail({ session, services, serviceOrder, colorMap, hoveredService, onHoverService }: LeftRailProps) {
  const byName = new Map(services.map((s) => [s.name, s]));
  const ordered = serviceOrder.map((name) => byName.get(name)).filter((s): s is TraceService => s != null);

  return (
    <aside className="left-rail">
      <div className="left-rail__meta">
        <h2 className="left-rail__title">{session.name}</h2>
        <dl>
          <div>
            <dt>id</dt>
            <dd className="mono">{session.id}</dd>
          </div>
          {session.agent && (
            <div>
              <dt>agent</dt>
              <dd>{session.agent}</dd>
            </div>
          )}
          <div>
            <dt>started</dt>
            <dd>{formatDateTime(session.startedAt)}</dd>
          </div>
          {session.endedAt && (
            <div>
              <dt>ended</dt>
              <dd>{formatDateTime(session.endedAt)}</dd>
            </div>
          )}
          <div>
            <dt>segments</dt>
            <dd>{session.segmentCount}</dd>
          </div>
          <div>
            <dt>peak tokens</dt>
            <dd>{formatTokens(session.peakTokens)}</dd>
          </div>
        </dl>
      </div>
      <div className="left-rail__legend">
        <h3>Contributing services</h3>
        <ul>
          {ordered.map((service) => (
            <li
              key={service.name}
              className={hoveredService && hoveredService !== service.name ? 'is-dimmed' : ''}
              onMouseEnter={() => onHoverService(service.name)}
              onMouseLeave={() => onHoverService(null)}
              onFocus={() => onHoverService(service.name)}
              onBlur={() => onHoverService(null)}
              tabIndex={0}
            >
              <span className="left-rail__dot" style={{ background: colorMap.get(service.name) ?? '#0F6B62' }} />
              <span className="left-rail__name">{service.name}</span>
              <span className="left-rail__tokens">{formatTokens(service.totalTokens)}</span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
