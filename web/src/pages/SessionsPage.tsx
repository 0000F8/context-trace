import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getStats, listSessions } from '../lib/api';
import { useFetch } from '../lib/useFetch';
import { StatsStrip } from '../components/StatsStrip';
import { SessionTable } from '../components/SessionTable';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import './SessionsPage.css';

export function SessionsPage() {
  const [query, setQuery] = useState('');
  const navigate = useNavigate();

  const statsState = useFetch(() => getStats(), []);
  const sessionsState = useFetch(() => listSessions({ q: query || undefined, limit: 100 }), [query]);

  return (
    <div className="sessions-page">
      <header className="sessions-page__header">
        <h1>context-trace</h1>
        <p className="sessions-page__intro">Inspect how assembled context evolves across a session's segments.</p>
      </header>

      {statsState.status === 'ready' && <StatsStrip stats={statsState.data} />}
      {statsState.status === 'error' && <ErrorState message={statsState.error} onRetry={statsState.reload} />}

      <div className="sessions-page__toolbar">
        <input
          type="search"
          className="sessions-page__search"
          placeholder="Search sessions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search sessions"
        />
      </div>

      {sessionsState.status === 'loading' && <LoadingState label="Loading sessions" />}
      {sessionsState.status === 'error' && <ErrorState message={sessionsState.error} onRetry={sessionsState.reload} />}
      {sessionsState.status === 'ready' && sessionsState.data.sessions.length === 0 && query === '' && (
        <EmptyState
          title="No traces yet."
          body={
            <>
              Point the SDK at this server, or run the seed script: <code>docker compose run --rm seed</code>
            </>
          }
        />
      )}
      {sessionsState.status === 'ready' && sessionsState.data.sessions.length === 0 && query !== '' && (
        <EmptyState title={`No sessions match "${query}".`} body="Try a different search term." />
      )}
      {sessionsState.status === 'ready' && sessionsState.data.sessions.length > 0 && (
        <SessionTable sessions={sessionsState.data.sessions} onOpen={(id) => navigate(`/sessions/${id}`)} />
      )}
    </div>
  );
}
