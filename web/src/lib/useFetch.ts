import { useEffect, useRef, useState, type DependencyList } from 'react';

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: T; isRefreshing: boolean };

export type FetchResult<T> = AsyncState<T> & { reload: () => void };

/**
 * Stale-while-revalidate state transitions, pulled out of the effect body so
 * they're unit-testable without rendering a component: a `reload()` (same
 * deps) must keep showing the previous data with `isRefreshing: true` rather
 * than reverting to `'loading'` — that's what stops a live-tail poll from
 * flashing the whole page back to a loading state on every event.
 */
export function startFetch<T>(prev: AsyncState<T>, isNewDeps: boolean): AsyncState<T> {
  return isNewDeps || prev.status !== 'ready' ? { status: 'loading' } : { ...prev, isRefreshing: true };
}

export function resolveFetch<T>(data: T): AsyncState<T> {
  return { status: 'ready', data, isRefreshing: false };
}

export function rejectFetch<T>(prev: AsyncState<T>, isNewDeps: boolean, message: string): AsyncState<T> {
  // A failed reload of already-displayed data just stops the spinner and
  // keeps the stale data on screen — only a fresh (no prior data) load surfaces the error.
  return !isNewDeps && prev.status === 'ready' ? { ...prev, isRefreshing: false } : { status: 'error', error: message };
}

/** Runs `fn` on mount and whenever `deps` change; exposes a manual `reload`. See startFetch/resolveFetch/rejectFetch for the stale-while-revalidate contract. */
export function useFetch<T>(fn: () => Promise<T>, deps: DependencyList): FetchResult<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  // Tracks the last deps this hook actually fetched for, so a same-deps
  // reload (tick bump) can be told apart from a real deps change.
  const lastDepsKey = useRef<string | null>(null);

  useEffect(() => {
    const depsKey = JSON.stringify(deps);
    const isNewDeps = lastDepsKey.current !== depsKey;
    lastDepsKey.current = depsKey;

    let cancelled = false;
    setState((prev) => startFetch(prev, isNewDeps));
    fnRef
      .current()
      .then((data) => {
        if (!cancelled) setState(resolveFetch(data));
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState((prev) => rejectFetch(prev, isNewDeps, err instanceof Error ? err.message : 'Something went wrong.'));
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { ...state, reload: () => setTick((t) => t + 1) };
}
