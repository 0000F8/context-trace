import { Fragment } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { CompiledTrace, SessionAnalytics } from '@context-trace/types';
import { getAnalytics, getTrace } from '../lib/api';
import { useFetch, type FetchResult } from '../lib/useFetch';
import { assignServiceColors, deriveServiceOrder } from '../lib/colors';
import {
  alignStrata,
  buildHeadlineMetrics,
  formatDeltaPercent,
  formatMetricDelta,
  formatMetricValue,
  unionServiceShareRows,
} from '../lib/compare';
import { ServiceChip } from '../components/ServiceChip';
import { MiniCompositionTimeline } from '../components/MiniCompositionTimeline';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import './ComparePage.css';

export function ComparePage() {
  const [searchParams] = useSearchParams();
  const a = searchParams.get('a');
  const b = searchParams.get('b');

  const traceStateA = useFetch(() => (a ? getTrace(a) : Promise.resolve(null)), [a]);
  const traceStateB = useFetch(() => (b ? getTrace(b) : Promise.resolve(null)), [b]);
  const analyticsStateA = useFetch(() => (a ? getAnalytics(a) : Promise.resolve(null)), [a]);
  const analyticsStateB = useFetch(() => (b ? getAnalytics(b) : Promise.resolve(null)), [b]);

  if (!a || !b) {
    return (
      <div className="compare-page">
        <EmptyState
          title="Choose two sessions to compare."
          body={
            <>
              Head back to <Link to="/">sessions</Link> and check exactly two to compare.
            </>
          }
        />
      </div>
    );
  }

  const states: Array<FetchResult<unknown>> = [traceStateA, traceStateB, analyticsStateA, analyticsStateB];
  const reloadAll = () => states.forEach((s) => s.reload());

  if (states.some((s) => s.status === 'loading')) {
    return (
      <div className="compare-page">
        <LoadingState label="Loading comparison" />
      </div>
    );
  }
  const failed = states.find((s) => s.status === 'error');
  if (failed && failed.status === 'error') {
    return (
      <div className="compare-page">
        <ErrorState message={failed.error} onRetry={reloadAll} />
      </div>
    );
  }

  const traceA = traceStateA.status === 'ready' ? traceStateA.data : null;
  const traceB = traceStateB.status === 'ready' ? traceStateB.data : null;
  const analyticsA = analyticsStateA.status === 'ready' ? analyticsStateA.data : null;
  const analyticsB = analyticsStateB.status === 'ready' ? analyticsStateB.data : null;
  if (!traceA || !traceB || !analyticsA || !analyticsB) return null;

  return <ComparisonView traceA={traceA} traceB={traceB} analyticsA={analyticsA} analyticsB={analyticsB} />;
}

function ComparisonView({
  traceA,
  traceB,
  analyticsA,
  analyticsB,
}: {
  traceA: CompiledTrace;
  traceB: CompiledTrace;
  analyticsA: SessionAnalytics;
  analyticsB: SessionAnalytics;
}) {
  const orderA = deriveServiceOrder(traceA);
  const orderB = deriveServiceOrder(traceB);
  const serviceOrder = [...orderA, ...orderB.filter((s) => !orderA.includes(s))];
  const colorMap = assignServiceColors(serviceOrder);

  const metrics = buildHeadlineMetrics(
    {
      segmentCount: traceA.session.segmentCount,
      peakTokens: traceA.session.peakTokens,
      totalTokens: traceA.session.totalTokens,
      carryRatio: analyticsA.carryRatio,
      avgLatencyMs: analyticsA.outcomes?.avgLatencyMs,
    },
    {
      segmentCount: traceB.session.segmentCount,
      peakTokens: traceB.session.peakTokens,
      totalTokens: traceB.session.totalTokens,
      carryRatio: analyticsB.carryRatio,
      avgLatencyMs: analyticsB.outcomes?.avgLatencyMs,
    },
  );

  const shareRows = unionServiceShareRows(traceA.services, traceB.services);
  const strataGroups = alignStrata(traceA.spans, traceB.spans);
  const maxTokens = Math.max(traceA.session.peakTokens, traceB.session.peakTokens, 1);

  return (
    <div className="compare-page">
      <header className="compare-page__header">
        <h1 className="compare-page__title">
          {traceA.session.name} vs {traceB.session.name}
        </h1>
      </header>

      <section className="compare-section">
        <h2 className="compare-section__title">Headline metrics</h2>
        <table className="compare-metrics">
          <thead>
            <tr>
              <th>Metric</th>
              <th>A</th>
              <th>B</th>
              <th>Δ</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.label}>
                <td>{m.label}</td>
                <td className="mono">{formatMetricValue(m.a, m.format)}</td>
                <td className="mono">{formatMetricValue(m.b, m.format)}</td>
                <td className={`mono compare-metrics__delta compare-metrics__delta--${m.judgment}`}>{formatMetricDelta(m.delta, m.format)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="compare-section">
        <h2 className="compare-section__title">Per-service token share</h2>
        {shareRows.length === 0 ? (
          <p className="compare-section__empty">No sections recorded in either session.</p>
        ) : (
          <table className="compare-service-table">
            <thead>
              <tr>
                <th>Service</th>
                <th>Share (A)</th>
                <th>Share (B)</th>
                <th>Δ</th>
              </tr>
            </thead>
            <tbody>
              {shareRows.map((row) => (
                <tr key={row.name}>
                  <td>
                    <ServiceChip name={row.name} color={colorMap.get(row.name) ?? '#0F6B62'} />
                  </td>
                  <td className="mono">{(row.shareA * 100).toFixed(1)}%</td>
                  <td className="mono">{(row.shareB * 100).toFixed(1)}%</td>
                  {/* Shares sum to 1, so a shift here is redistribution, not improvement/regression — no judgment color. */}
                  <td className="mono">{formatDeltaPercent(row.deltaPoints)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="compare-section">
        <h2 className="compare-section__title">Composition timelines</h2>
        <div className="compare-timelines">
          <div className="compare-timelines__row">
            <p className="mini-timeline__label">{traceA.session.name} (A)</p>
            <MiniCompositionTimeline label={traceA.session.name} segments={traceA.segments} serviceOrder={serviceOrder} colorMap={colorMap} maxTokens={maxTokens} />
          </div>
          <div className="compare-timelines__row">
            <p className="mini-timeline__label">{traceB.session.name} (B)</p>
            <MiniCompositionTimeline label={traceB.session.name} segments={traceB.segments} serviceOrder={serviceOrder} colorMap={colorMap} maxTokens={maxTokens} />
          </div>
        </div>
      </section>

      <section className="compare-section">
        <h2 className="compare-section__title">Aligned strata summary</h2>
        {strataGroups.length === 0 ? (
          <p className="compare-section__empty">No sections recorded in either session.</p>
        ) : (
          <table className="compare-strata-table">
            <thead>
              <tr>
                <th>Section</th>
                <th>Presence (A)</th>
                <th>Versions (A)</th>
                <th>Presence (B)</th>
                <th>Versions (B)</th>
              </tr>
            </thead>
            <tbody>
              {strataGroups.map((group) => (
                <Fragment key={group.service}>
                  <tr className="compare-strata-table__group-head">
                    <td colSpan={5}>
                      <ServiceChip name={group.service} color={colorMap.get(group.service) ?? '#0F6B62'} />
                    </td>
                  </tr>
                  {group.rows.map((row) => (
                    <tr key={row.key}>
                      <td className="mono compare-strata-table__key">{row.key}</td>
                      <td className="mono">{row.presenceA ?? '—'}</td>
                      <td className="mono">{row.versionsA ?? '—'}</td>
                      <td className="mono">{row.presenceB ?? '—'}</td>
                      <td className="mono">{row.versionsB ?? '—'}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
