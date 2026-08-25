import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { SessionsPage } from './pages/SessionsPage';
import { TraceViewPage } from './pages/TraceViewPage';

export function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <header className="app-header">
          <div className="app-header__inner">
            <Link to="/" className="app-header__brand">
              context-trace
            </Link>
          </div>
        </header>
        <Routes>
          <Route path="/" element={<SessionsPage />} />
          <Route path="/sessions/:id" element={<TraceViewPage />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
