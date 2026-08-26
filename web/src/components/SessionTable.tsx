import { useState } from 'react';
import type { SessionSummary } from '@context-trace/types';
import { assignServiceColors } from '../lib/colors';
import { formatDateTime, formatTokens } from '../lib/format';
import { ServiceChip } from './ServiceChip';
import './SessionTable.css';

interface SessionTableProps {
  sessions: SessionSummary[];
  onOpen: (id: string) => void;
  /** Called with the two selected session ids when "Compare" is activated. */
  onCompare: (a: string, b: string) => void;
}

export function SessionTable({ sessions, onOpen, onCompare }: SessionTableProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleCompare = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < 2) {
        next.add(id);
      }
      return next;
    });
  };

  const selectedIds = [...selected];
  const canCompare = selectedIds.length === 2;
  const maxSelected = selectedIds.length >= 2;

  return (
    <div className="session-table-wrap">
      <div className="session-table__toolbar">
        {canCompare && (
          <button type="button" className="session-table__compare-btn" onClick={() => onCompare(selectedIds[0]!, selectedIds[1]!)}>
            Compare
          </button>
        )}
      </div>
      <table className="session-table">
        <thead>
          <tr>
            <th className="session-table__compare-col">Compare</th>
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
            const isChecked = selected.has(session.id);
            return (
              <tr
                key={session.id}
                tabIndex={0}
                onClick={() => onOpen(session.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onOpen(session.id);
                }}
              >
                <td className="session-table__compare-col" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    disabled={!isChecked && maxSelected}
                    onChange={() => toggleCompare(session.id)}
                    aria-label={`Select ${session.name} for comparison`}
                  />
                </td>
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
    </div>
  );
}
