import { Link } from 'react-router-dom';
import type { SearchHit } from '@context-trace/types';
import { colorForService } from '../lib/colors';
import { parseSnippet } from '../lib/snippet';
import { ServiceChip } from './ServiceChip';
import './SearchResults.css';

export function SearchResults({ hits }: { hits: SearchHit[] }) {
  return (
    <ul className="search-results">
      {hits.map((hit, i) => (
        <li key={`${hit.sessionId}:${hit.segmentIndex}:${hit.key}:${i}`} className="search-results__item">
          <Link
            className="search-results__link"
            to={`/sessions/${encodeURIComponent(hit.sessionId)}?segment=${hit.segmentIndex}&section=${encodeURIComponent(hit.key)}`}
          >
            <div className="search-results__meta">
              <span className="search-results__session">{hit.sessionName}</span>
              <span className="search-results__key mono">{hit.key}</span>
              <ServiceChip name={hit.service} color={colorForService(hit.service)} />
              <span className="search-results__segment mono">segment {hit.segmentIndex}</span>
            </div>
            <p className="search-results__snippet">
              {parseSnippet(hit.snippet).map((part, j) =>
                part.match ? (
                  <mark key={j} className="search-results__match">
                    {part.text}
                  </mark>
                ) : (
                  <span key={j}>{part.text}</span>
                ),
              )}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}
