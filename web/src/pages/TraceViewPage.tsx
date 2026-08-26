import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Finding, SegmentDetail } from '@context-trace/types';
import { getAnalytics, getSegmentDetail, getTrace, liveUrl } from '../lib/api';
import { useFetch } from '../lib/useFetch';
import { assignServiceColors, deriveServiceOrder } from '../lib/colors';
import { buildCellStates, findPreviousSegment, groupSpansByService } from '../lib/strata';
import { buildDeepLinkSearch, parseDeepLink } from '../lib/deep-link';
import { COLUMN_WIDTH, ROW_LABEL_WIDTH } from '../lib/layout';
import { LeftRail } from '../components/LeftRail';
import { CompositionTimeline } from '../components/CompositionTimeline';
import { StrataGrid } from '../components/StrataGrid';
import { Inspector, type InspectorTab } from '../components/Inspector';
import { SectionDrawer } from '../components/SectionDrawer';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import './TraceViewPage.css';

const SCRUBBER_INTERVAL_MS = 700;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

export function TraceViewPage() {
  const { id } = useParams<{ id: string }>();
  const sessionId = id ?? '';
  const traceState = useFetch(() => getTrace(sessionId), [sessionId]);
  const analyticsState = useFetch(() => getAnalytics(sessionId), [sessionId]);

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [hoveredService, setHoveredService] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('sections');
  const [drawerKey, setDrawerKey] = useState<string | null>(null);
  const [segmentDetails, setSegmentDetails] = useState<Map<number, SegmentDetail>>(new Map());
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [gutterMinimized, setGutterMinimized] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLive, setIsLive] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const deepLinkAppliedRef = useRef<string | null>(null);
  // Manual gutter width (drag handle); null = auto-fit to the longest key.
  const [gutterPref, setGutterPref] = useState<number | null>(() => {
    const v = Number(localStorage.getItem('ct:gutterWidth'));
    return Number.isFinite(v) && v >= 120 ? v : null;
  });

  const trace = traceState.status === 'ready' ? traceState.data : null;
  const analytics = analyticsState.status === 'ready' ? analyticsState.data : null;

  // Select the latest segment (or the segment named by a deep link) whenever a
  // new trace loads for a session we haven't applied a deep link to yet.
  useEffect(() => {
    if (!trace || trace.segments.length === 0) {
      setSelectedIndex(null);
      return;
    }
    const last = trace.segments[trace.segments.length - 1]!;
    if (deepLinkAppliedRef.current !== trace.session.id) {
      deepLinkAppliedRef.current = trace.session.id;
      const deepLink = parseDeepLink(window.location.search);
      const wanted =
        deepLink.segment != null && trace.segments.some((s) => s.index === deepLink.segment) ? deepLink.segment : last.index;
      setSelectedIndex(wanted);
      setSegmentDetails(new Map());
      if (deepLink.section && trace.spans.some((s) => s.key === deepLink.section)) {
        setDrawerKey(deepLink.section);
      }
      return;
    }
    setSelectedIndex(last.index);
    setSegmentDetails(new Map());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace?.session.id]);

  // Keep the URL in sync with the current selection/drawer (no navigation).
  useEffect(() => {
    if (!trace) return;
    const qs = buildDeepLinkSearch(window.location.search, { segment: selectedIndex, section: drawerKey });
    window.history.replaceState(null, '', `${window.location.pathname}${qs}`);
  }, [trace, selectedIndex, drawerKey]);

  const serviceOrder = useMemo(() => (trace ? deriveServiceOrder(trace) : []), [trace]);
  const colorMap = useMemo(() => assignServiceColors(serviceOrder), [serviceOrder]);
  const cellStates = useMemo(() => (trace ? buildCellStates(trace) : new Map()), [trace]);
  const groups = useMemo(() => (trace ? groupSpansByService(trace.spans, serviceOrder) : []), [trace, serviceOrder]);

  const rawWindow = trace?.session.metadata?.window;
  const budgetWindow = typeof rawWindow === 'number' ? rawWindow : undefined;
  const overWindowIndexes = useMemo(
    () => new Set((analytics?.perSegment ?? []).filter((p) => p.overWindow).map((p) => p.index)),
    [analytics],
  );

  // Auto-fit the label gutter to the longest section key (IBM Plex Mono at
  // 12px advances ~7.2px/char), clamped so huge keys can't eat the chart.
  const autoGutter = useMemo(() => {
    if (!trace || trace.spans.length === 0) return ROW_LABEL_WIDTH;
    const longest = trace.spans.reduce((m, s) => Math.max(m, s.key.length), 0);
    return Math.min(340, Math.max(140, Math.round(longest * 7.2) + 30));
  }, [trace]);
  const gutterWidth = gutterMinimized ? 24 : (gutterPref ?? autoGutter);

  const resizeGutter = (w: number | null) => {
    setGutterPref(w);
    if (w == null) localStorage.removeItem('ct:gutterWidth');
    else localStorage.setItem('ct:gutterWidth', String(w));
  };

  // Any deliberate click pauses the scrubber — only its own timer advances
  // the selection while playing.
  const handleManualSelect = (index: number) => {
    setIsPlaying(false);
    setSelectedIndex(index);
  };

  const handleSelectFinding = (finding: Finding) => {
    if (finding.segmentIndex != null) handleManualSelect(finding.segmentIndex);
    if (finding.key) setDrawerKey(finding.key);
  };

  const togglePlay = () => setIsPlaying((v) => !v);

  const toggleLive = () => {
    setLiveError(null);
    setIsLive((v) => !v);
  };

  // Scrubber: steps the selection forward every 700ms, pausing at the last
  // segment. Manual selection (handleManualSelect) stops it.
  useEffect(() => {
    if (!isPlaying || !trace || trace.segments.length === 0) return;
    const sorted = [...trace.segments].sort((a, b) => a.index - b.index);
    const timer = window.setInterval(() => {
      setSelectedIndex((current) => {
        const pos = current == null ? -1 : sorted.findIndex((s) => s.index === current);
        const nextPos = pos + 1;
        if (nextPos >= sorted.length) {
          setIsPlaying(false);
          return current;
        }
        return sorted[nextPos]!.index;
      });
    }, SCRUBBER_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isPlaying, trace]);

  // Live tail: subscribe to the session's SSE stream while toggled on;
  // segment/outcome events just trigger a cheap refetch of both trace and
  // analytics. Auto-select + scroll effect (below) reacts to the refreshed
  // trace rather than the raw SSE events.
  useEffect(() => {
    if (!isLive || !sessionId) return;
    const source = new EventSource(liveUrl(sessionId));
    const onUpdate = () => {
      traceState.reload();
      analyticsState.reload();
    };
    source.addEventListener('segment', onUpdate);
    source.addEventListener('outcome', onUpdate);
    source.onerror = () => {
      source.close();
      setIsLive(false);
      setLiveError('Live connection lost.');
    };
    return () => {
      source.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, sessionId]);

  // When live and the trace refreshes (new segment/outcome arrived), jump to
  // and reveal the newest segment.
  useEffect(() => {
    if (!isLive || !trace || trace.segments.length === 0) return;
    const last = trace.segments[trace.segments.length - 1]!;
    setSelectedIndex(last.index);
    const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';
    requestAnimationFrame(() => {
      document.querySelector(`[data-segment-index="${last.index}"]`)?.scrollIntoView({ behavior, inline: 'end', block: 'nearest' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace, isLive]);

  useEffect(() => {
    if (!trace || selectedIndex == null) return;
    if (segmentDetails.has(selectedIndex)) {
      // Already cached for the current selection — nothing in flight, so the
      // loading flag must reflect that (it may still be true from a prior
      // selection whose fetch was cancelled before it could clear it).
      setDetailLoading(false);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    getSegmentDetail(trace.session.id, selectedIndex)
      .then((detail) => {
        if (!cancelled) {
          setSegmentDetails((m) => new Map(m).set(selectedIndex, detail));
          setDetailLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setDetailError(err instanceof Error ? err.message : 'Could not load segment detail.');
          setDetailLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [trace, selectedIndex, segmentDetails]);

  useEffect(() => {
    if (!trace || selectedIndex == null) return;
    const segment = trace.segments.find((s) => s.index === selectedIndex);
    const hasDelta = !!segment && segment.ops.some((op) => op.op !== 'carry');
    setInspectorTab(hasDelta ? 'changes' : 'sections');
  }, [trace, selectedIndex]);

  if (traceState.status === 'loading') {
    return (
      <div className="trace-view trace-view--loading">
        <LoadingState label="Loading trace" />
      </div>
    );
  }
  if (traceState.status === 'error') {
    return (
      <div className="trace-view trace-view--error">
        <ErrorState message={traceState.error} onRetry={traceState.reload} />
      </div>
    );
  }
  if (!trace) return null;

  if (trace.segments.length === 0) {
    return (
      <div className="trace-view trace-view--empty">
        <EmptyState title="No segments recorded yet." body="This session has started but hasn't recorded any context assemblies yet." />
      </div>
    );
  }

  const selectedSegment = trace.segments.find((s) => s.index === selectedIndex) ?? null;
  const selectedDetail = selectedIndex != null ? (segmentDetails.get(selectedIndex) ?? null) : null;
  const maxTokens = Math.max(...trace.segments.map((s) => s.totalTokens), budgetWindow ?? 0, 1);
  const selectedColumn = selectedIndex != null ? trace.segments.findIndex((s) => s.index === selectedIndex) : -1;

  const drawerSpan = drawerKey ? (trace.spans.find((s) => s.key === drawerKey) ?? null) : null;

  return (
    <div
      className={`trace-view${railCollapsed ? ' trace-view--rail-collapsed' : ''}${
        inspectorCollapsed ? ' trace-view--inspector-collapsed' : ''
      }`}
    >
      {railCollapsed ? (
        <button
          type="button"
          className="side-strip side-strip--left"
          onClick={() => setRailCollapsed(false)}
          title="Show session panel"
        >
          <span aria-hidden>»</span>
          <span className="side-strip__label">Session</span>
        </button>
      ) : (
        <div className="side-panel side-panel--left">
          <button
            type="button"
            className="side-collapse"
            onClick={() => setRailCollapsed(true)}
            title="Hide session panel"
            aria-label="Hide session panel"
          >
            «
          </button>
          <LeftRail
            session={trace.session}
            services={trace.services}
            serviceOrder={serviceOrder}
            colorMap={colorMap}
            hoveredService={hoveredService}
            onHoverService={setHoveredService}
            analytics={analytics}
            onSelectFinding={handleSelectFinding}
          />
        </div>
      )}
      <div className="trace-view__center">
        <div className="trace-view__zone-head">
          <p className="trace-view__zone-title">Composition timeline</p>
          <div className="trace-view__zone-actions">
            <button type="button" className="scrubber-toggle" onClick={togglePlay} aria-pressed={isPlaying}>
              {isPlaying ? 'Pause' : 'Play'}
            </button>
            <button type="button" className={`live-toggle${isLive ? ' is-active' : ''}`} onClick={toggleLive} aria-pressed={isLive}>
              <span className={`live-toggle__dot${isLive ? ' is-pulsing' : ''}`} aria-hidden />
              Live
            </button>
            {liveError && <span className="live-toggle__error">{liveError}</span>}
            <button
              type="button"
              className="gutter-toggle"
              onClick={() => setGutterMinimized((v) => !v)}
              aria-pressed={gutterMinimized}
            >
              {gutterMinimized ? 'Show labels' : 'Hide labels'}
            </button>
          </div>
        </div>
        <div className="trace-view__scroll">
          {selectedColumn >= 0 && (
            <div
              className="core-sample-rule"
              style={{ left: gutterWidth + selectedColumn * COLUMN_WIDTH, width: COLUMN_WIDTH }}
            />
          )}
          <CompositionTimeline
            segments={trace.segments}
            colorMap={colorMap}
            maxTokens={maxTokens}
            selectedIndex={selectedIndex}
            hoveredService={hoveredService}
            gutterWidth={gutterWidth}
            budgetWindow={budgetWindow}
            overWindowIndexes={overWindowIndexes}
            onSelect={handleManualSelect}
          />
          <p className="trace-view__zone-title">Strata grid (section lanes)</p>
          <StrataGrid
            groups={groups}
            segments={trace.segments}
            cellStates={cellStates}
            colorMap={colorMap}
            hoveredService={hoveredService}
            gutterWidth={gutterWidth}
            onResizeGutter={resizeGutter}
            onSelectSegment={handleManualSelect}
            onSelectSection={setDrawerKey}
          />
        </div>
      </div>
      {inspectorCollapsed ? (
        <button
          type="button"
          className="side-strip side-strip--right"
          onClick={() => setInspectorCollapsed(false)}
          title="Show inspector"
        >
          <span aria-hidden>«</span>
          <span className="side-strip__label">Inspector</span>
        </button>
      ) : (
        <div className="side-panel side-panel--right">
          <button
            type="button"
            className="side-collapse"
            onClick={() => setInspectorCollapsed(true)}
            title="Hide inspector"
            aria-label="Hide inspector"
          >
            »
          </button>
          <Inspector
            segment={selectedSegment}
            previousSegment={selectedIndex != null ? findPreviousSegment(trace.segments, selectedIndex) : null}
            detail={selectedDetail}
            loading={detailLoading}
            error={detailError}
            colorMap={colorMap}
            tab={inspectorTab}
            onTabChange={setInspectorTab}
            onOpenSection={setDrawerKey}
          />
        </div>
      )}
      {drawerKey && (
        <SectionDrawer
          sessionId={trace.session.id}
          sectionKey={drawerKey}
          span={drawerSpan}
          service={drawerSpan?.service ?? ''}
          color={colorMap.get(drawerSpan?.service ?? '') ?? '#0F6B62'}
          initialIndex={selectedIndex ?? 0}
          onClose={() => setDrawerKey(null)}
        />
      )}
    </div>
  );
}
