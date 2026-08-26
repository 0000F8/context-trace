import { useEffect, useRef, useState } from 'react';
import type { AnnotatedSection, SegmentDetail, Section, TraceSegment } from '@context-trace/types';
import { diffLines } from '../lib/diff';
import { formatLatency, formatTokens, previewLine } from '../lib/format';
import { buildPromptMarkdown, buildPromptMessages } from '../lib/prompt';
import { ServiceChip } from './ServiceChip';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';
import './Inspector.css';

export type InspectorTab = 'changes' | 'sections';

interface InspectorProps {
  segment: TraceSegment | null;
  previousSegment: TraceSegment | null;
  detail: SegmentDetail | null;
  loading: boolean;
  error: string | null;
  colorMap: Map<string, string>;
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  onOpenSection: (key: string) => void;
}

export function Inspector({ segment, previousSegment, detail, loading, error, colorMap, tab, onTabChange, onOpenSection }: InspectorProps) {
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);
  const [showResponse, setShowResponse] = useState(false);
  const copiedTimer = useRef<number | null>(null);

  useEffect(() => {
    setShowResponse(false);
  }, [segment?.id]);

  useEffect(
    () => () => {
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  if (!segment) {
    return (
      <aside className="inspector">
        <p className="inspector__hint">Select a segment to inspect it.</p>
      </aside>
    );
  }

  const delta = previousSegment ? segment.totalTokens - previousSegment.totalTokens : null;
  const outcome = segment.outcome;

  function flashCopied(label: string) {
    setCopiedLabel(label);
    if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopiedLabel(null), 1500);
  }

  async function copyMarkdown() {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(buildPromptMarkdown(detail));
      flashCopied('Copied markdown');
    } catch {
      // clipboard unavailable — nothing more we can do here.
    }
  }

  async function copyMessages() {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(buildPromptMessages(detail), null, 2));
      flashCopied('Copied messages');
    } catch {
      // clipboard unavailable — nothing more we can do here.
    }
  }

  return (
    <aside className="inspector">
      <header className="inspector__header">
        <div className="inspector__title">
          <span className="inspector__index">segment {segment.index}</span>
          {segment.label && <span className="inspector__label">{segment.label}</span>}
        </div>
        <div className="inspector__meta">
          <span>{formatTokens(segment.totalTokens)} tokens</span>
          {delta != null && (
            <span className={`inspector__delta ${delta >= 0 ? 'is-up' : 'is-down'}`}>
              {delta >= 0 ? '+' : ''}
              {formatTokens(delta)}
            </span>
          )}
        </div>
        {outcome && (
          <div className="inspector__outcome">
            {outcome.latencyMs != null && <span className="inspector__chip inspector__chip--mono">{formatLatency(outcome.latencyMs)}</span>}
            {outcome.scores &&
              Object.entries(outcome.scores).map(([key, value]) => (
                <span key={key} className="inspector__chip">
                  {key} {value.toFixed(2)}
                </span>
              ))}
            {outcome.error && <span className="inspector__chip inspector__chip--error">{outcome.error}</span>}
          </div>
        )}
        <div className="inspector__actions">
          <button type="button" disabled={loading || !detail} onClick={copyMarkdown}>
            Copy markdown
          </button>
          <button type="button" disabled={loading || !detail} onClick={copyMessages}>
            Copy messages
          </button>
          {copiedLabel && (
            <span className="inspector__copied" role="status">
              {copiedLabel}
            </span>
          )}
        </div>
      </header>
      <div className="inspector__tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'changes'} className={tab === 'changes' ? 'is-active' : ''} onClick={() => onTabChange('changes')}>
          Changes
        </button>
        <button role="tab" aria-selected={tab === 'sections'} className={tab === 'sections' ? 'is-active' : ''} onClick={() => onTabChange('sections')}>
          Sections
        </button>
      </div>
      {outcome?.responseText && (
        <div className="inspector__response">
          <button type="button" className="inspector__response-toggle" onClick={() => setShowResponse((v) => !v)}>
            {showResponse ? 'Hide response' : 'Show response'}
          </button>
          {showResponse && <pre className="inspector__response-content">{outcome.responseText}</pre>}
        </div>
      )}
      <div className="inspector__body">
        {loading && <LoadingState label="Loading segment" />}
        {error && <ErrorState message={error} />}
        {!loading && !error && detail && tab === 'sections' && <SectionsTab detail={detail} colorMap={colorMap} onOpenSection={onOpenSection} />}
        {!loading && !error && detail && tab === 'changes' && <ChangesTab detail={detail} colorMap={colorMap} onOpenSection={onOpenSection} />}
      </div>
    </aside>
  );
}

function SectionsTab({
  detail,
  colorMap,
  onOpenSection,
}: {
  detail: SegmentDetail;
  colorMap: Map<string, string>;
  onOpenSection: (key: string) => void;
}) {
  return (
    <ul className="inspector__list">
      {detail.sections.map((s) => (
        <li key={s.key}>
          <button className="inspector__row" onClick={() => onOpenSection(s.key)}>
            <ServiceChip name={s.service} color={colorMap.get(s.service) ?? '#0F6B62'} />
            <span className="inspector__row-key">{s.key}</span>
            <span className={`inspector__badge inspector__badge--${s.state}`}>{s.state}</span>
            <span className="inspector__row-tokens">{formatTokens(s.tokens)}</span>
          </button>
          {s.content && <p className="inspector__preview">{previewLine(s.content)}</p>}
        </li>
      ))}
      {detail.removed.map((s) => (
        <li key={s.key} className="is-removed">
          <button className="inspector__row" onClick={() => onOpenSection(s.key)}>
            <ServiceChip name={s.service} color={colorMap.get(s.service) ?? '#0F6B62'} />
            <span className="inspector__row-key">{s.key}</span>
            <span className="inspector__badge inspector__badge--removed">removed</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ChangesTab({
  detail,
  colorMap,
  onOpenSection,
}: {
  detail: SegmentDetail;
  colorMap: Map<string, string>;
  onOpenSection: (key: string) => void;
}) {
  const added = detail.sections.filter((s) => s.state === 'added');
  const changed = detail.sections.filter((s) => s.state === 'changed');
  const removed = detail.removed;

  if (added.length === 0 && changed.length === 0 && removed.length === 0) {
    return <p className="inspector__hint">No changes from the previous segment. Everything carried.</p>;
  }

  return (
    <div className="inspector__changes">
      {added.map((s) => (
        <section key={s.key} className="change-block change-block--added">
          <ChangeHeader section={s} colorMap={colorMap} tag="added" onOpen={() => onOpenSection(s.key)} />
          {s.content && <pre className="change-block__content">{s.content}</pre>}
        </section>
      ))}
      {changed.map((s) => (
        <section key={s.key} className="change-block change-block--changed">
          <ChangeHeader
            section={s}
            colorMap={colorMap}
            tag="changed"
            delta={s.prevTokens != null ? s.tokens - s.prevTokens : null}
            onOpen={() => onOpenSection(s.key)}
          />
          <LineDiff prev={s.prevContent ?? ''} next={s.content ?? ''} />
        </section>
      ))}
      {removed.map((s) => (
        <section key={s.key} className="change-block change-block--removed">
          <ChangeHeader section={s} colorMap={colorMap} tag="removed" onOpen={() => onOpenSection(s.key)} />
          {s.content && <pre className="change-block__content change-block__content--struck">{s.content}</pre>}
        </section>
      ))}
    </div>
  );
}

function ChangeHeader({
  section,
  colorMap,
  tag,
  delta,
  onOpen,
}: {
  section: AnnotatedSection | Section;
  colorMap: Map<string, string>;
  tag: 'added' | 'changed' | 'removed';
  delta?: number | null;
  onOpen: () => void;
}) {
  return (
    <button className="change-block__header" onClick={onOpen}>
      <ServiceChip name={section.service} color={colorMap.get(section.service) ?? '#0F6B62'} />
      <span className="change-block__key">{section.key}</span>
      <span className={`inspector__badge inspector__badge--${tag}`}>{tag}</span>
      {delta != null && (
        <span className="change-block__delta">
          {delta >= 0 ? '+' : ''}
          {formatTokens(delta)}
        </span>
      )}
    </button>
  );
}

function LineDiff({ prev, next }: { prev: string; next: string }) {
  const lines = diffLines(prev, next);
  return (
    <div className="change-block__content">
      {lines.map((line, i) => (
        <div key={i} className={`diff-line diff-line--${line.type}`}>
          <span className="diff-line__marker">{line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}</span>
          <span className="diff-line__text">{line.text}</span>
        </div>
      ))}
    </div>
  );
}
