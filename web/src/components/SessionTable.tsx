import type { SessionSummary } from '@context-trace/types';
import { assignServiceColors } from '../lib/colors';
import { formatDateTime, formatTokens } from '../lib/format';
import { ServiceChip } from './ServiceChip';
import './SessionTable.css';

export function SessionTable({ sessions, onOpen }: { sessions: SessionSummary[]; onOpen: (id: string) => void }) {
  return (
    <table className="session-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Agent</th>
          <th>Segments</th>
          <th>Latest tokens</th>
          <th>Peak tokens</th>
          <th>Services</th>
          <th>Last activity</th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((session) => {
          const colorMap = assignServiceColors(session.services);
          return (
            <tr
              key={session.id}
              tabIndex={0}
              onClick={() => onOpen(session.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onOpen(session.id);
              }}
            >
              <td className="session-table__name">{session.name}</td>
              <td>{session.agent ?? '—'}</td>
              <td className="mono">{session.segmentCount}</td>
              <td className="mono">{formatTokens(session.totalTokens)}</td>
              <td className="mono">{formatTokens(session.peakTokens)}</td>
              <td>
                <div className="session-table__chips">
                  {session.services.map((name) => (
                    <ServiceChip key={name} name={name} color={colorMap.get(name) ?? '#0F6B62'} />
                  ))}
                </div>
              </td>
              <td className="mono">{formatDateTime(session.lastActivityAt)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
