import { describe, expect, it } from 'vitest';
import { rejectFetch, resolveFetch, startFetch } from './useFetch';
import type { AsyncState } from './useFetch';

describe('startFetch (stale-while-revalidate transitions)', () => {
  it('goes to a clean loading state on the first fetch (no prior data)', () => {
    expect(startFetch<number>({ status: 'loading' }, false)).toEqual({ status: 'loading' });
  });

  it('goes to loading when deps changed, even with prior ready data (a session switch must not show stale data)', () => {
    const prev: AsyncState<number> = { status: 'ready', data: 1, isRefreshing: false };
    expect(startFetch(prev, true)).toEqual({ status: 'loading' });
  });

  it('keeps prior data and flips isRefreshing on a same-deps reload (live-tail poll)', () => {
    const prev: AsyncState<number> = { status: 'ready', data: 42, isRefreshing: false };
    expect(startFetch(prev, false)).toEqual({ status: 'ready', data: 42, isRefreshing: true });
  });

  it('goes to loading on a same-deps reload if the previous attempt had errored', () => {
    const prev: AsyncState<number> = { status: 'error', error: 'boom' };
    expect(startFetch(prev, false)).toEqual({ status: 'loading' });
  });
});

describe('resolveFetch', () => {
  it('always lands on a fresh, non-refreshing ready state', () => {
    expect(resolveFetch('data')).toEqual({ status: 'ready', data: 'data', isRefreshing: false });
  });
});

describe('rejectFetch', () => {
  it('keeps the stale data and just stops refreshing when a same-deps reload fails', () => {
    const prev: AsyncState<number> = { status: 'ready', data: 7, isRefreshing: true };
    expect(rejectFetch(prev, false, 'network down')).toEqual({ status: 'ready', data: 7, isRefreshing: false });
  });

  it('surfaces the error when there was no prior data to fall back on', () => {
    expect(rejectFetch<number>({ status: 'loading' }, false, 'network down')).toEqual({ status: 'error', error: 'network down' });
  });

  it('surfaces the error on a failed fetch for new deps, even if old data existed', () => {
    const prev: AsyncState<number> = { status: 'ready', data: 7, isRefreshing: false };
    expect(rejectFetch(prev, true, 'network down')).toEqual({ status: 'error', error: 'network down' });
  });
});
