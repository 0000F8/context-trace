import { useEffect, useState } from 'react';

/**
 * Returns `value`, delayed by `delayMs` after it stops changing. The first
 * render's value is returned immediately (no delay), so an initial fetch
 * driven by this hook fires right away rather than waiting out the debounce.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (value === debounced) return;
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, delayMs]);

  return debounced;
}
