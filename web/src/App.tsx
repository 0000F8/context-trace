import { useEffect, useState } from 'react';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { SessionsPage } from './pages/SessionsPage';
import { TraceViewPage } from './pages/TraceViewPage';
import { ComparePage } from './pages/ComparePage';
import { KeyPrompt } from './components/KeyPrompt';
import { clearApiKey, hasApiKey, onUnauthorized, setApiKey } from './lib/api';
import { applyTheme, initialTheme, type Theme } from './lib/theme';

export function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  };

  // Open-mode instances never see a 401, so `locked` stays false and this
  // whole flow is inert: no prompt, no header action, no stored key, no
  // extra requests beyond what the pages already make.
  const [keyStored, setKeyStored] = useState(hasApiKey);
  const [locked, setLocked] = useState(false);
  // Forces the routed page tree to remount after a key is saved/cleared, so
  // its useFetch calls re-run with the new (or absent) x-api-key header
  // rather than sitting on a stale 401 error.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => onUnauthorized(() => setLocked(true)), []);

  function handleSaveKey(key: string) {
    setApiKey(key);
    setKeyStored(true);
    setLocked(false);
    setAttempt((n) => n + 1);
  }

  function handleSignOut() {
    clearApiKey();
    setKeyStored(false);
    setLocked(true);
    setAttempt((n) => n + 1);
  }

  return (
    <BrowserRouter>
      <div className="app-shell">
        <header className="app-header">
          <div className="app-header__inner">
            <Link to="/" className="app-header__brand">
              context-trace
            </Link>
            <div className="app-header__actions">
              {keyStored && (
                <button type="button" className="theme-toggle" onClick={handleSignOut}>
                  Sign out
                </button>
              )}
              <button type="button" className="theme-toggle" onClick={toggleTheme}>
                {theme === 'dark' ? 'Light theme' : 'Dark theme'}
              </button>
            </div>
          </div>
        </header>
        {locked ? (
          <KeyPrompt key={attempt} onSave={handleSaveKey} rejected={keyStored} />
        ) : (
          <Routes key={attempt}>
            <Route path="/" element={<SessionsPage />} />
            <Route path="/sessions/:id" element={<TraceViewPage />} />
            <Route path="/compare" element={<ComparePage />} />
          </Routes>
        )}
      </div>
    </BrowserRouter>
  );
}
