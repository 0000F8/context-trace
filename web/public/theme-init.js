// Pre-paint theme init; mirrors src/lib/theme.ts initialTheme(). Loaded as a
// blocking external script (CSP allows 'self' only — no inline scripts).
try {
  var t = localStorage.getItem('ct:theme');
  if (t !== 'light' && t !== 'dark') {
    t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = t;
} catch (e) {}
