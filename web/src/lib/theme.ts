export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'ct:theme';

/** Stored preference, else the OS preference. (index.html applies the same
 *  logic inline before first paint to avoid a light flash.) */
export function initialTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(STORAGE_KEY, theme);
}
