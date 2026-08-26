import { useState } from 'react';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { SessionsPage } from './pages/SessionsPage';
import { TraceViewPage } from './pages/TraceViewPage';
import { ComparePage } from './pages/ComparePage';
import { applyTheme, initialTheme, type Theme } from './lib/theme';

export function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  };

  return (
    <BrowserRouter>
      <div className="app-shell">
        <header className="app-header">
          <div className="app-header__inner">
            <Link to="/" className="app-header__brand">
              context-trace
            </Link>
            <button type="button" className="theme-toggle" onClick={toggleTheme}>
              {theme === 'dark' ? 'Light theme' : 'Dark theme'}
            </button>
          </div>
        </header>
        <Routes>
          <Route path="/" element={<SessionsPage />} />
          <Route path="/sessions/:id" element={<TraceViewPage />} />
          <Route path="/compare" element={<ComparePage />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
