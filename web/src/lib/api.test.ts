import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearApiKey, getSession, getStats, onUnauthorized, setApiKey } from './api';

describe('stale 401 handling', () => {
  afterEach(() => {
    clearApiKey();
    vi.unstubAllGlobals();
  });

  it('does not re-lock on a 401 that was already in flight before a newer key was saved', async () => {
    // Simulates: /stats 401s under the old key -> user saves a valid key
    // (unlocking) -> a fresh request under the new key succeeds -> the
    // stale /stats response finally lands. That last arrival must not fire
    // onUnauthorized again, or a correct key gets reported as rejected.
    let resolveStale!: (res: Response) => void;
    const stale = new Promise<Response>((resolve) => {
      resolveStale = resolve;
    });

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => stale)
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ id: 's1' }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const unauthorized = vi.fn();
    const unsubscribe = onUnauthorized(unauthorized);

    const stalePending = getStats().catch(() => {
      // Expected to reject once the stale 401 lands below — asserted separately.
    });

    setApiKey('ct_valid');
    await getSession('s1');

    resolveStale(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
    await stalePending;

    expect(unauthorized).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('still fires onUnauthorized for a 401 issued under the key that is still current', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const unauthorized = vi.fn();
    const unsubscribe = onUnauthorized(unauthorized);

    await getStats().catch(() => {});

    expect(unauthorized).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
