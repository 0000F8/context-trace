import { useEffect, useState } from 'react';
import type { AnnotatedSection, SegmentDetail, TraceSpan } from '@context-trace/types';
import { getSegmentDetail } from '../lib/api';
import { canDiff, hasContent, HASH_ONLY_PLACEHOLDER } from '../lib/content';
import { diffLines } from '../lib/diff';
import { formatTokens } from '../lib/format';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';
import './SectionDrawer.css';

interface SectionDrawerProps {
  sessionId: string;
  sectionKey: string;
  span: TraceSpan | null;
  service: string;
  color: string;
  initialIndex: number;
  onClose: () => void;
}

export function SectionDrawer({ sessionId, sectionKey, span, service, color, initialIndex, onClose }: SectionDrawerProps) {
  const presence = span?.presence ?? [];
  const defaultIndex = presence.includes(initialIndex) ? initialIndex : (presence[presence.length - 1] ?? initialIndex);

  const [activeIndex, setActiveIndex] = useState(defaultIndex);
  const [cache, setCache] = useState<Map<number, SegmentDetail>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setActiveIndex(defaultIndex);
    setCache(new Map());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionKey]);

  useEffect(() => {
    if (cache.has(activeIndex)) {
      // Already cached for the current tick — nothing in flight, so the
      // loading flag must reflect that (it may still be true from a prior
      // tick whose fetch was cancelled before it could clear it).
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getSegmentDetail(sessionId, activeIndex)
      .then((detail) => {
        if (!cancelled) {
          setCache((m) => new Map(m).set(activeIndex, detail));
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load this version.');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, activeIndex, cache]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const detail = cache.get(activeIndex);
  const section: AnnotatedSection | undefined = detail?.sections.find((s) => s.key === sectionKey);

  return (
    <div className="section-drawer-overlay" onClick={onClose}>
      <aside className="section-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Section ${sectionKey}`}>
        <header className="section-drawer__header">
          <div className="section-drawer__title">
            <span className="section-drawer__dot" style={{ background: color }} />
            <span className="section-drawer__key">{sectionKey}</span>
          </div>
          <button className="section-drawer__close" onClick={onClose} aria-label="Close section">
            Close
          </button>
        </header>
        <p className="section-drawer__service">
          {service}
          {span ? ` · ${span.versions} version${span.versions === 1 ? '' : 's'}` : ''}
        </p>

        {presence.length > 0 && (
          <div className="section-drawer__ticks" role="tablist" aria-label="Segment versions">
            {presence.map((idx) => (
              <button
                key={idx}
                role="tab"
                aria-selected={idx === activeIndex}
                className={`section-drawer__tick ${idx === activeIndex ? 'is-active' : ''}`}
                onClick={() => setActiveIndex(idx)}
              >
                {idx}
              </button>
            ))}
          </div>
        )}

        <div className="section-drawer__body">
          {loading && <LoadingState label="Loading version" />}
          {error && <ErrorState message={error} />}
          {!loading && !error && section && (
            <>
              <div className="section-drawer__meta">
                <span className={`inspector__badge inspector__badge--${section.state}`}>{section.state}</span>
                <span>{formatTokens(section.tokens)} tokens</span>
              </div>
              {section.state === 'changed' ? (
                canDiff(section.prevContent, section.content) ? (
                  <div className="section-drawer__diff">
                    {diffLines(section.prevContent ?? '', section.content ?? '').map((line, i) => (
                      <div key={i} className={`diff-line diff-line--${line.type}`}>
                        <span className="diff-line__marker">{line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}</span>
                        <span className="diff-line__text">{line.text}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="section-drawer__content hash-only-placeholder">{HASH_ONLY_PLACEHOLDER}</p>
                )
              ) : hasContent(section.content) ? (
                <pre className="section-drawer__content">{section.content}</pre>
              ) : (
                <p className="section-drawer__content hash-only-placeholder">{HASH_ONLY_PLACEHOLDER}</p>
              )}
            </>
          )}
          {!loading && !error && !section && <p className="inspector__hint">Not present in this segment.</p>}
        </div>
      </aside>
    </div>
  );
}
