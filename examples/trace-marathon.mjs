// Marathon stress trace: a 100-turn incident-response agent running against a
// 180k-token context window. Shows what long-horizon context management looks
// like in practice: history compounding every turn, ephemeral tool results
// sliding out after a few turns, runbooks rotating, three compaction sawteeth
// as the budget fills, and a finale where a 55k-token heap dump overflows the
// window and forces an emergency truncation.
//
// Section `tokens` are the agent's true accounting; `content` carries a
// bounded preview (what a production hook would ship for large payloads).
//
// Usage: node examples/trace-marathon.mjs [endpoint]   (default http://127.0.0.1:4720)

import { createClient } from '../packages/sdk/dist/index.js';

const endpoint = process.argv[2] ?? 'http://127.0.0.1:4720';

const WINDOW = 180_000;          // model context window (tokens)
const COMPACT_AT = 165_000;      // context manager compacts above this
const TURNS = 100;

// deterministic PRNG so the trace is reproducible
let seed = 4721;
const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (lo, hi) => Math.floor(lo + rand() * (hi - lo));

const SERVICES = ['checkout-api', 'payments', 'inventory', 'auth-gw', 'search', 'notifications'];
const RUNBOOKS = ['db-failover', 'cache-stampede', 'pod-crashloop', 'queue-backlog', 'cert-rotation', 'rate-limit-tuning'];
const ACTIONS = [
  'kubectl get pods -n prod | grep -v Running', 'kubectl logs --tail=500', 'kubectl describe pod',
  'grafana: p99 latency panel', 'grafana: error-rate by service', 'pg_stat_activity dump',
  'redis INFO memory', 'kafka consumer lag check', 'traceroute + DNS resolution check',
];

const preview = (label, tokens) =>
  `[${label} — ${tokens} tokens, preview]\n` + `${label} output line: metrics nominal until 04:12:07Z, then p99 2.4s, error rate 8.3%, pods OOMKilled=3.\n`.repeat(Math.min(40, Math.ceil(tokens / 100)));

// ---------------------------------------------------------------------------

const ct = createClient({ endpoint, flushIntervalMs: 500, maxBatch: 20, onError: (e) => console.error('sdk:', e.message) });
const session = ct.startSession({
  id: 'incident-4721-marathon',
  name: 'sre-agent: incident #4721 — checkout latency war room (100 turns)',
  agent: 'sre-agent',
  metadata: { window: WINDOW, compactAt: COMPACT_AT, source: 'examples/trace-marathon.mjs' },
});

// live context: key -> { tokens, content, bornAt }
const live = new Map();
const put = (key, tokens, content, turn) => live.set(key, { tokens, content, bornAt: turn });
const total = () => [...live.values()].reduce((s, v) => s + v.tokens, 0);

put('system:harness', 2600, preview('sre-agent harness prompt: tools, escalation policy, tone', 2600), 0);
put('policy:oncall', 1400, preview('on-call policy: sev levels, paging tree, comms cadence', 1400), 0);
put('skill:incident-response', 3200, preview('incident-response playbook skill', 3200), 0);
put('mem:incident-notes', 300, 'Incident #4721 opened 04:10Z. Checkout p99 regression. Suspects: none yet.', 0);

let histTokens = 900;
let histLog = ['04:10Z incident opened, sev2, checkout p99 2.4s (SLO 400ms)'];
let compactions = 0;
const t0 = Date.parse('2026-08-25T04:10:00Z');
const summaryRows = [];

for (let turn = 0; turn < TURNS; turn++) {
  let label;
  const isFinaleDump = turn === 96;
  const isOverflow = turn === 98;
  const isTruncation = turn === 99;

  if (isTruncation) {
    // Emergency truncation: window still exceeded after the dump — drop
    // everything except the harness and a minimal state summary.
    label = 'EMERGENCY TRUNCATION — context overflow';
    for (const key of [...live.keys()]) {
      if (key !== 'system:harness' && key !== 'mem:incident-notes') live.delete(key);
    }
    histTokens = 400;
    histLog = ['[emergency summary] 99 turns compressed: root cause = payments connection-pool leak after 04:02Z deploy; rollback executed; heap dump analysis moved out-of-band.'];
  } else if (total() + histTokens > COMPACT_AT && turn < 96) {
    // (compaction disabled during the finale: the dump under analysis must stay in context)
    // Context manager compaction: summarize history, evict stale tools/runbooks.
    compactions++;
    label = `compaction #${compactions}`;
    for (const key of [...live.keys()]) {
      if ((key.startsWith('tool:') || key.startsWith('runbook:')) && live.get(key).bornAt < turn - 2) live.delete(key);
    }
    histTokens = 2200;
    histLog = [`[compaction #${compactions} summary] turns 0-${turn - 1}: ${pick(SERVICES)} implicated, ${compactions >= 2 ? 'rollback prepared' : 'still triaging'}, ${between(2, 9)} hypotheses eliminated.`];
    put('mem:incident-notes', live.get('mem:incident-notes').tokens + between(120, 400), `Notes v${compactions + 1}: timeline, eliminated hypotheses, current suspect: payments pool.`, turn);
  } else {
    // Normal investigation turn.
    const svc = pick(SERVICES);
    const action = pick(ACTIONS);
    label = isFinaleDump ? 'heap dump pasted (90k tokens)' : isOverflow ? 'OVER WINDOW — model call degraded' : `${svc}: ${action.split(' ')[0].replace(':', '')} ${turn}`;

    // 1-3 ephemeral tool results
    const nTools = isFinaleDump ? 1 : between(1, 4);
    for (let i = 0; i < nTools; i++) {
      const tok = isFinaleDump ? 90_000 : between(1500, 6000);
      const key = isFinaleDump ? 'tool:heap-dump-payments' : `tool:${svc}-${action.split(' ')[0].replace(':', '')}-t${turn}${i ? '-' + i : ''}`;
      put(key, tok, preview(key, tok), turn);
    }
    if (isOverflow) put('tool:core-dump-checkout', 45_000, preview('tool:core-dump-checkout', 45_000), turn);
    // occasionally pull a runbook (sticks around until compaction)
    if (rand() < 0.25) {
      const rb = pick(RUNBOOKS);
      put(`runbook:${rb}`, between(2500, 6000), preview(`runbook ${rb}`, 4000), turn);
    }
    // occasionally update incident notes
    if (rand() < 0.15) {
      const cur = live.get('mem:incident-notes');
      put('mem:incident-notes', cur.tokens + between(80, 250), `Notes updated turn ${turn}: ${svc} ${rand() < 0.5 ? 'cleared' : 'still suspect'}.`, turn);
    }
    // slide out tool results older than 3 turns
    for (const key of [...live.keys()]) {
      if (key.startsWith('tool:') && key !== 'tool:heap-dump-payments' && live.get(key).bornAt < turn - 3) live.delete(key);
    }
    if (isOverflow) {
      // over the window: nothing evicted yet, the assembly simply exceeds it
      histLog.push(`turn ${turn}: context exceeds ${WINDOW} window — provider truncating silently, responses degrade`);
    }
    histTokens += between(900, 2200);
    histLog.push(`turn ${turn} (${label}): operator + agent exchange, findings appended.`);
    if (histLog.length > 40) histLog = histLog.slice(-40);
  }

  live.set('hist:transcript', { tokens: histTokens, content: histLog.join('\n'), bornAt: turn });

  const seg = session.segment({
    index: turn,
    label: `t${turn} — ${label}`,
    kind: 'llm_call',
    model: 'claude-sonnet-5',
    timestamp: new Date(t0 + turn * 90_000).toISOString(),
    metadata: { window: WINDOW },
  });
  const order = ['system', 'policy', 'skill', 'mem', 'runbook', 'tool', 'hist'];
  const keys = [...live.keys()].sort((a, b) => {
    const pa = order.indexOf(a.split(':')[0]); const pb = order.indexOf(b.split(':')[0]);
    return pa !== pb ? pa - pb : a.localeCompare(b);
  });
  for (const key of keys) {
    const v = live.get(key);
    const [service, serviceKind] =
      key.startsWith('system') ? ['harness', 'system'] :
      key.startsWith('policy') ? ['policies', 'system'] :
      key.startsWith('skill') ? ['skills', 'system'] :
      key.startsWith('mem') ? ['memory', 'memory'] :
      key.startsWith('runbook') ? ['runbooks', 'retrieval'] :
      key.startsWith('tool') ? ['tool-results', 'tool'] : ['history', 'history'];
    seg.section({ key, service, serviceKind, content: v.content, tokens: v.tokens });
  }
  seg.record();
  summaryRows.push({ turn, label, tokens: total(), over: total() > WINDOW });
}

session.end();
await ct.shutdown();

const trace = await (await fetch(`${endpoint}/v1/sessions/incident-4721-marathon/trace`)).json();
const peak = Math.max(...trace.segments.map((s) => s.totalTokens));
console.log(`Captured "${trace.session.name}"`);
console.log(`${trace.segments.length} segments, ${trace.spans.length} section spans, peak ${peak.toLocaleString()} tokens (window ${WINDOW.toLocaleString()})`);
console.log(`compactions: ${compactions}, over-window segments: ${trace.segments.filter((s) => s.totalTokens > WINDOW).length}`);
for (const s of trace.segments) {
  if (s.label.includes('compaction') || s.label.includes('OVER') || s.label.includes('TRUNCATION') || s.label.includes('heap') || s.index % 20 === 0 || s.index === TURNS - 1) {
    console.log(`  [${String(s.index).padStart(2)}] ${String(s.totalTokens.toLocaleString()).padStart(8)} tok  ${s.label}${s.totalTokens > WINDOW ? '  *** OVER WINDOW ***' : ''}`);
  }
}
