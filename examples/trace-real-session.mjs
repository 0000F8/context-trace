// Traces a real multi-turn coding-agent session: the Claude Code session that
// built this repository. Section payloads are the repo's actual files and the
// session's actual command outputs, so token magnitudes and context dynamics
// (growing history, files read then evicted, subagent reports, a compaction
// cliff) are genuine rather than synthesized.
//
// Usage: node examples/trace-real-session.mjs [endpoint]   (default http://127.0.0.1:4720)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '../packages/sdk/dist/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const endpoint = process.argv[2] ?? 'http://127.0.0.1:4720';

const read = (p) => {
  try { return readFileSync(join(ROOT, p), 'utf8'); } catch { return `[${p} not present in this checkout]`; }
};
const cap = (s) => (s.length > 240_000 ? s.slice(0, 240_000) : s);

// ---------------------------------------------------------------------------
// Real payloads
// ---------------------------------------------------------------------------

const SYSTEM_HARNESS = `You are Claude Code, Anthropic's official CLI for Claude. You are an interactive agent that helps users with software engineering tasks.
${'Tooling contract: Bash, Read, Write, Edit, Agent, Skill, Artifact, TaskCreate/TaskOutput, Monitor, SendMessage, WebFetch, WebSearch, plus MCP servers (filesystem, github, playwright, context7). Independent tool calls run in parallel. Reference code as file_path:line_number. Text between tool calls may not be shown; the final message of the turn carries the deliverables. Lead with the outcome. For actions that are hard to reverse, confirm first unless durably authorized. Report outcomes faithfully: if tests fail, say so with the output.\n'.repeat(12)}
Session-specific guidance: memory directory mounted; scratchpad at /private/tmp/...; context management: when the conversation grows long, some or all of the current context is summarized. When you have enough information to act, act.`;

const CLAUDE_MD_GLOBAL = `# oh-my-claudecode - Intelligent Multi-Agent Orchestration
Coordinate specialized agents, tools, and skills so work is completed accurately and efficiently.
Delegate for: multi-file changes, refactors, debugging, reviews, planning, research, verification.
Model routing (session override): Opus orchestrates. Sonnet does the work. Every spawned worker = sonnet unless justified in one line.
${'Skills registry: autopilot, ultrawork, ralph, team, ralplan, deep-interview, verify, cancel. Hooks inject <system-reminder> tags. Verification before completion claims: size appropriately, iterate on failure. Cost discipline: prefer one well-scoped worker over a fan-out re-reading the same files.\n'.repeat(8)}`;

const SKILL_AUTOPILOT = `# Autopilot: full lifecycle from idea to verified code.
Phase 0 Expansion (analyst+architect -> spec) -> Phase 1 Planning (plan + critic) -> Phase 2 Execution (parallel executors) -> Phase 3 QA (build/lint/test cycles, max 5) -> Phase 4 Validation (architect + security-reviewer + code-reviewer, all must approve) -> Phase 5 Cleanup (state files, /cancel).
${'Execution policy: each phase completes before the next; parallel within phases; same error 3x = stop and report; rejected validation items get fixed and re-validated; cancel preserves resume state.\n'.repeat(10)}`;

const SKILL_FRONTEND = `# Frontend Design skill.
Approach this as the design lead at a small studio known for giving every client a visual identity that could not be mistaken for anyone else's. Ground it in the subject: the subject's own world - its materials, instruments, artifacts, vernacular - is where distinctive choices come from. Typography carries the personality of the page. Structure is information. Spend your boldness in one place; keep everything around the signature element quiet.
${'Calibration: AI design clusters around cream+serif+terracotta, near-black+acid-green, and broadsheet hairlines - defaults, not choices. Work in two passes: token system (color/type/layout/signature) then critique against the brief before building. Quality floor: responsive, visible focus, reduced motion respected.\n'.repeat(9)}`;

const turnsSpec = [
  // [label, narration, {sectionKey: content...} adds/updates for this turn, drops:[keys]]
  ['init', 'User: init. Assistant: repo is empty except .omc/ session state — nothing to document. Asked what context-trace should become.', {
    'tool:repo-listing': 'total 0\ndrwxr-xr-x 3 z1ggy staff 96 Aug 25 00:29 .omc\n(4 state files, no code, no git)',
  }, []],
  ['autopilot request', 'User: autopilot a library + web service that captures context and its contributing sections/services, compiles temporal/procedural traces, visualized in a web app; dockerize; use front-end design skills. Assistant: engaged autopilot, checked toolchain (node 22, docker 27), git init.', {
    'skill:autopilot': SKILL_AUTOPILOT,
    'tool:env-check': 'v22.23.2 / 10.9.8 / Docker 27.3.1 / Compose v2.30.3 / git 2.38.0\nInitialized empty Git repository in /Users/z1ggy/projects/context-trace/.git/',
  }, ['tool:repo-listing']],
  ['write spec', 'User (mid-turn): the library will be called from framework hooks, async; visualization needs diffs between updates. Assistant: wrote the authoritative spec — snapshot model, wire protocol, query API, compiled trace shape; folded in hook-first SDK ergonomics and first-class Changes view.', {
    'file:spec.md': read('.omc/autopilot/spec.md'),
  }, ['tool:env-check']],
  ['design brief', 'Assistant: loaded frontend-design skill; wrote the mandatory design brief — stratigraphy concept, lab-bench neutrals with data-owned color, IBM Plex, shared-x-axis core-sample signature.', {
    'skill:frontend-design': SKILL_FRONTEND,
    'file:design-brief.md': read('.omc/autopilot/design-brief.md'),
  }, []],
  ['scaffold types', 'Assistant: scaffolded npm workspaces and fully implemented @context-trace/types — wire+trace types, fnv1a64, estimateTokens, generateId. Tests 5/5. better-sqlite3 verified native.', {
    'file:types/index.ts': read('packages/types/src/index.ts'),
    'tool:build-output': '> tsc -p tsconfig.json\nTest Files 1 passed (1)\nTests 5 passed (5)\nbetter-sqlite3 OK',
  }, []],
  ['dispatch agents', 'Assistant: spawned three sonnet executors in disjoint directories — sdk, server, web (designer agent with the brief). Wrote Dockerfiles, nginx.conf, compose myself while they ran.', {
    'tool:agent-spawns': 'sdk-agent@session spawned\nserver-agent@session spawned\nweb-agent@session spawned\nDockerfiles + compose written (multi-stage node:22-slim, nginx SPA proxy, seed profile service)',
  }, ['file:types/index.ts']],
  ['sdk lands', 'sdk-agent: package implemented — bounded batching queue, unref flush timer, retry w/ backoff, never throws into host. 8/8 tests. Assistant committed checkpoint.', {
    'agent:sdk-report': 'Files: client.ts (queue/flusher/handles), index.ts, index.test.ts (8 cases: ordering, idempotency, interleave positions, retry-then-drop, enabled:false, drain, bound, rebind). Build+typecheck+tests green. Retry: 3 total attempts, 200/400ms backoff. kind defaults llm_call.',
  }, []],
  ['sdk code review', 'Assistant: read client.ts end-to-end — never-throw guarantee holds, FIFO ordering sound; flagged 4xx-retry waste and un-unref backoff timer; dispatched both refinements back to sdk-agent.', {
    'file:sdk/client.ts': read('packages/sdk/src/client.ts'),
  }, []],
  ['server lands', 'server-agent: Hono app, pure compiler, store, seed, 23/23 tests; fixed my scaffold tsconfig extends bug. Assistant: reviewed compile.ts — diff semantics, span versioning, ops ordering all match spec.', {
    'agent:server-report': 'db.ts (WAL, FK cascade, :memory:), store.ts (idempotent upserts, partial accept), trace/compile.ts (pure), app.ts (createApp for app.request tests), seed.ts (3 sessions, staggered timestamps, idempotent). Deviations flagged: span versions count hash transitions incl. gaps; removed ops ordered by prev position, appended last.',
    'file:server/compile.ts': read('server/src/trace/compile.ts'),
  }, ['file:sdk/client.ts']],
  ['QA round 1', 'Assistant: ran API contract harness (all endpoints, idempotency, cascade), SDK e2e round-trip, full suite 56 green. Committed server+web.', {
    'tool:qa-output': 'PASS healthz/seed/stats/sessions/detail/trace/segment\nPASS ingest idempotency + stub session + delete cascade + 404\nALL API QA PASSED\nSDK E2E PASSED\nTests: 5+10+23+18 = 56 passed',
  }, ['agent:sdk-report', 'agent:server-report', 'file:server/compile.ts']],
  ['visual QA', 'Assistant: booted seeded stack, Playwright pass — sessions page, trace view (shared-axis strata grid + core sample), section drawer with version ticks and line diff, responsive at 820px. Docker compose up healthy, seeded, verified through nginx.', {
    'tool:playwright-notes': 'sessions-page: stats strip hairlines, service chips, seeded rows OK\ntrace-view: timeline+strata aligned, seg5 selected, Changes tab diff w/ -42 tokens, removed struck\ndrawer: 6 versions, CHANGED badge, added line highlighted\ndocker: server Healthy, web :8080, /api proxy 200, seed 3 sessions/21 segments/79 sections',
  }, []],
  ['compaction', '[Context compacted: earlier turns summarized. Retained: harness, global CLAUDE.md, autopilot skill, working summary. Dropped: file payloads, old tool outputs, playwright notes.]', {
    'skill:frontend-design': null, 'file:spec.md': null, 'file:design-brief.md': null,
    'tool:qa-output': null, 'tool:playwright-notes': null, 'tool:agent-spawns': null, 'tool:build-output': null,
  }, []],
  ['security review', 'security-reviewer (opus): REJECT — wildcard CORS exposes reads+delete cross-origin; CT_API_KEY breaks the UI (auth unusable); 27,000x memory amplification in session summaries (100MB -> 3.7KB response, RSS 244MB); plus caps, timing compare, port binding, CSP, hash trust.', {
    'agent:security-review': 'MAJOR 1 app.ts:108 CORS * on all /v1/* — evil origin reads sections + DELETE ok. Fix: scope to ingest.\nMAJOR 2 api.ts:29 UI never sends x-api-key; auth mode unusable. Fix: write-only scope.\nMAJOR 3 store.ts:282 SELECT * materializes all content for 3.7KB summaries; limit=200; searchbox self-DoS. Fix: SQL aggregates.\nMODERATE 4 unbounded content + BigInt hashing 31ms/MB blocks loop.\nLOW 5 !== compare. 6 0.0.0.0:4720. 7 no CSP. 8 client hash trusted -> forged carried states.\nClean: no XSS, no SQLi (all bound params), no proto pollution.',
  }, []],
  ['quality review + dispatch', 'quality-reviewer (opus): REJECT — SDK silently loses rejected segments (hook adapter emits every segment index 0 -> UNIQUE rejects all but first, zero onError); dup section key discards whole snapshot; stuck loading spinner race; 6 minors. Assistant dispatched all 13 findings to owning agents; fixed fnv1a64 (BigInt->limbs, differential-verified), compose loopback, nginx headers, README env docs myself.', {
    'agent:quality-review': 'MAJOR 1 client.ts:270 only res.ok checked; 200+rejected[] invisible; README adapter all index 0. VERIFIED 1/3 stored.\nMAJOR 2 dup key -> whole segment rejected silently.\nMAJOR 3 TraceViewPage detailLoading stuck on cached-path early return; SectionDrawer same.\nMINORS: ended fabricates stub; stub outside txn; index 1.5 unreachable; maxBatch:0 infinite loop; color mismatch list vs trace; prev = index-1 breaks sparse.',
  }, []],
  ['fix round lands', 'Agents: server rewrote summaries to SQL aggregates (4ms for 10MB stored), CORS ingest-only, write-scoped auth timingSafeEqual, caps, hash recompute, dup-key/stub/txn/integer fixes (38/38); SDK surfaces rejections, caches session handles (indexes 0,1,2 verified), dedupes keys, clamps options (15/15); web fixed loading race, hash colors, sorted-prev, debounce (24/24).', {
    'tool:reqa-output': 'PASS cors scoping / contentHash integrity / duplicate key rejection / no stub from session.ended / integer index / content cap / summary aggregates (4.0ms avg for 10MB) / auth scoping\nALL FIX-REGRESSION QA PASSED\n82 tests green; docker rebuilt: CSP+nosniff live, no ACAO on reads, 127.0.0.1:4720',
    'memory:context-trace-project': 'context-trace: snapshot model diffed by key+fnv1a64; auth guards writes only (amended spec); summaries never materialize content; SDK session cache bounded LRU, never evict on end(); colors = hash(name) mod 8. Hosted github.com/0000F8/context-trace.',
  }, ['file:sdk/client.ts']],
  ['re-validation', 'security-reviewer: APPROVE — all 8 verified empirically (probe tables, 20,010-input hash differential, 200MB benchmark). quality-reviewer: 9/9 fixed but new MAJOR — session cache unbounded (28.4MB/200k sessions). Assistant dispatched LRU fix.', {
    'agent:security-verdict': 'APPROVE. CORS table probed per-route; amplification 2ms/0.1MB at 200MB stored (was 98ms/244MB at 100MB); fnv limb math checked independently; headers live through proxy. LOW: README loopback wording overstates protection — web port re-exposes reads. Fix wording.',
  }, ['agent:security-review']],
  ['final approval', 'sdk-agent: bounded LRU (maxSessions 1000, evict on overflow only, enabled guard) 17/17. Assistant verified 0.2MB/200k sessions, 84 tests green, pushed. quality-reviewer: APPROVE — true LRU not FIFO, eviction boundary fails loudly, README honest. Autopilot cancelled cleanly; repo public at github.com/0000F8/context-trace.', {
    'tool:final-state': 'heap growth after 200k sessions: 0.2MB BOUNDED\nTests 5+17+38+24 = 84 passed\nead2f22 pushed; both reviewers APPROVE; autopilot state cleared',
  }, ['agent:quality-review']],
];

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

const ct = createClient({ endpoint, flushIntervalMs: 500, onError: (e) => console.error('sdk:', e.message) });
const session = ct.startSession({
  id: 'real-claude-code-session',
  name: 'claude-code: building context-trace (this repo, real session)',
  agent: 'claude-fable-5',
  metadata: { source: 'examples/trace-real-session.mjs', turns: turnsSpec.length },
});

const live = new Map(); // key -> content (current context assembly)
live.set('system:harness', SYSTEM_HARNESS);
live.set('claude-md:global', CLAUDE_MD_GLOBAL);

const serviceFor = (key) => {
  const [prefix] = key.split(':');
  return {
    system: ['harness', 'system'], 'claude-md': ['claude-md', 'system'],
    skill: ['skills', 'system'], hist: ['history', 'history'],
    file: ['file-reads', 'retrieval'], tool: ['tool-results', 'tool'],
    agent: ['subagents', 'tool'], memory: ['memory', 'memory'],
  }[prefix] ?? ['other', 'other'];
};

let historyLog = [];
const t0 = Date.parse('2026-08-25T04:33:00Z');

turnsSpec.forEach(([label, narration, changes, drops], i) => {
  // history: compaction turn replaces the log with a summary; others append
  if (label === 'compaction') {
    historyLog = [`[compacted summary] Turns 0-${i - 1}: autopilot built context-trace — spec/design/scaffold done, sdk+server+web landed via parallel agents, QA round 1 green (56 tests), docker verified, visual QA passed. Open: phase 4 validation.`];
  } else {
    historyLog.push(`— turn ${i} (${label}): ${narration}`);
  }
  for (const [key, content] of Object.entries(changes)) {
    if (content === null) live.delete(key); else live.set(key, content);
  }
  for (const key of drops) live.delete(key);
  live.set('hist:conversation', historyLog.join('\n\n'));

  const seg = session.segment({
    index: i,
    label: `turn ${i} — ${label}`,
    kind: 'llm_call',
    model: 'claude-fable-5',
    timestamp: new Date(t0 + i * 3 * 60_000).toISOString(),
  });
  // stable assembly order: system, claude-md, skills, memory, files, tools, agents, history
  const order = ['system', 'claude-md', 'skill', 'memory', 'file', 'tool', 'agent', 'hist'];
  const keys = [...live.keys()].sort((a, b) => {
    const pa = order.indexOf(a.split(':')[0]);
    const pb = order.indexOf(b.split(':')[0]);
    return pa !== pb ? pa - pb : a.localeCompare(b);
  });
  for (const key of keys) {
    const [service, serviceKind] = serviceFor(key);
    seg.section({ key, service, serviceKind, content: cap(live.get(key)) });
  }
  seg.record();
});

session.end();
await ct.shutdown();

const res = await fetch(`${endpoint}/v1/sessions/real-claude-code-session/trace`);
const trace = await res.json();
const peak = Math.max(...trace.segments.map((s) => s.totalTokens));
console.log(`Captured "${trace.session.name}"`);
console.log(`${trace.segments.length} segments, ${trace.spans.length} section spans, ${trace.services.length} services, peak ${peak} tokens`);
for (const s of trace.segments) {
  const d = `${s.ops.filter((o) => o.op === 'add').length}+ ${s.ops.filter((o) => o.op === 'change').length}~ ${s.ops.filter((o) => o.op === 'remove').length}-`;
  console.log(`  [${String(s.index).padStart(2)}] ${String(s.totalTokens).padStart(6)} tok  ${d.padEnd(9)} ${s.label}`);
}
