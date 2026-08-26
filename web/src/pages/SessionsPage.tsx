import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SearchResponse } from '@context-trace/types';
import { ApiError, getStats, listSessions, searchContent } from '../lib/api';
import { useFetch } from '../lib/useFetch';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { StatsStrip } from '../components/StatsStrip';
import { SessionTable } from '../components/SessionTable';
import { SearchResults } from '../components/SearchResults';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import './SessionsPage.css';

type SearchMode = 'sessions' | 'content';

export function SessionsPage() {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 300);
  const navigate = useNavigate();

  const [mode, setMode] = useState<SearchMode>('sessions');
  // Optimistic until proven otherwise: a 501 from a real content search
  // (or the mount-time probe below) hides the toggle for the rest of the
  // session — spec2 §G1 ("detect once and hide the toggle").
  const [contentSearchAvailable, setContentSearchAvailable] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // Cheap capability probe so the toggle doesn't flash in on a build
    // without FTS5. A real (if trivial) query, since empty q is a 400.
    searchContent('*', 1).catch((err: unknown) => {
      if (!cancelled && err instanceof ApiError && err.status === 501) setContentSearchAvailable(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!contentSearchAvailable && mode === 'content') setMode('sessions');
  }, [contentSearchAvailable, mode]);

  const statsState = useFetch(() => getStats(), []);
  // useFetch already drops stale in-flight responses: each effect run closes
  // over its own `cancelled` flag, so a slow response from a superseded
  // debouncedQuery can't overwrite a newer one's state.
  const sessionsState = useFetch(
    () => (mode === 'sessions' ? listSessions({ q: debouncedQuery || undefined, limit: 100 }) : Promise.resolve(null)),
    [mode, debouncedQuery],
  );
  const searchState = useFetch<SearchResponse | null>(() => {
    if (mode !== 'content' || !debouncedQuery) return Promise.resolve(null);
    return searchContent(debouncedQuery).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 501) {
        setContentSearchAvailable(false);
        return null;
      }
      throw err;
    });
  }, [mode, debouncedQuery]);

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
          placeholder={mode === 'sessions' ? 'Search sessions' : 'Search section content'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={mode === 'sessions' ? 'Search sessions' : 'Search section content'}
        />
        {contentSearchAvailable && (
          <div className="sessions-page__mode-toggle" role="group" aria-label="Search mode">
            <button type="button" aria-pressed={mode === 'sessions'} onClick={() => setMode('sessions')}>
              Sessions
            </button>
            <button type="button" aria-pressed={mode === 'content'} onClick={() => setMode('content')}>
              Content
            </button>
          </div>
        )}
      </div>

      {mode === 'sessions' && (
        <>
          {sessionsState.status === 'loading' && <LoadingState label="Loading sessions" />}
          {sessionsState.status === 'error' && <ErrorState message={sessionsState.error} onRetry={sessionsState.reload} />}
          {sessionsState.status === 'ready' && sessionsState.data && sessionsState.data.sessions.length === 0 && debouncedQuery === '' && (
            <EmptyState
              title="No traces yet."
              body={
                <>
                  Point the SDK at this server, or run the seed script: <code>docker compose run --rm seed</code>
                </>
              }
            />
          )}
          {sessionsState.status === 'ready' && sessionsState.data && sessionsState.data.sessions.length === 0 && debouncedQuery !== '' && (
            <EmptyState title={`No sessions match "${debouncedQuery}".`} body="Try a different search term." />
          )}
          {sessionsState.status === 'ready' && sessionsState.data && sessionsState.data.sessions.length > 0 && (
            <SessionTable
              sessions={sessionsState.data.sessions}
              onOpen={(id) => navigate(`/sessions/${id}`)}
              onCompare={(a, b) => navigate(`/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`)}
            />
          )}
        </>
      )}

      {mode === 'content' && (
        <>
          {debouncedQuery === '' && <p className="sessions-page__hint">Type to search section content across all sessions.</p>}
          {debouncedQuery !== '' && searchState.status === 'loading' && <LoadingState label="Searching" />}
          {debouncedQuery !== '' && searchState.status === 'error' && <ErrorState message={searchState.error} onRetry={searchState.reload} />}
          {debouncedQuery !== '' && searchState.status === 'ready' && searchState.data && searchState.data.hits.length === 0 && (
            <EmptyState
              title={`No content matches "${debouncedQuery}".`}
              body="Try a different search term. Hash-only sessions aren't searchable — nothing is indexed for them."
            />
          )}
          {debouncedQuery !== '' && searchState.status === 'ready' && searchState.data && searchState.data.hits.length > 0 && (
            <SearchResults hits={searchState.data.hits} />
          )}
        </>
      )}
    </div>
  );
}
