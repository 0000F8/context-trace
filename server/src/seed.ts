/**
 * Writes 3 realistic demo sessions directly into the database at CT_DB.
 * Safe to re-run: sessions/segments use fixed ids and are upserted.
 */
import { estimateTokens, fnv1a64 } from '@context-trace/types';
import type { Section, SectionRole, ServiceKind, SegmentKind, SegmentWithSections, Session } from '@context-trace/types';
import { openDb } from './db.js';
import { endSession, getStats, upsertSegment, upsertSession } from './store.js';

interface SectionPlan {
  key: string;
  service: string;
  serviceKind: ServiceKind;
  role?: SectionRole;
  content: string;
}

interface SegmentPlan {
  label: string;
  kind: SegmentKind;
  model?: string;
  sections: SectionPlan[];
}

interface SessionPlan {
  id: string;
  name: string;
  agent: string;
  metadata?: Record<string, unknown>;
  segments: SegmentPlan[];
  ended: boolean;
}

function toSection(plan: SectionPlan, position: number): Section {
  return {
    key: plan.key,
    service: plan.service,
    serviceKind: plan.serviceKind,
    role: plan.role,
    position,
    content: plan.content,
    contentHash: fnv1a64(plan.content),
    tokens: estimateTokens(plan.content),
  };
}

// ---------------------------------------------------------------------------
// Session 1: support-chat — memory, retrieval, tool, history all contribute.
// ---------------------------------------------------------------------------

const SUPPORT_CHAT: SessionPlan = {
  id: 'seed-support-chat',
  name: 'support-chat: order #48213 refund',
  agent: 'triage-bot',
  metadata: { channel: 'web-widget', customerId: 'cus_48213' },
  ended: true,
  segments: [
    {
      label: 'turn 1',
      kind: 'llm_call',
      model: 'claude-sonnet-5',
      sections: [
        {
          key: 'system:instructions',
          service: 'prompts',
          serviceKind: 'system',
          role: 'system',
          content:
            'You are triage-bot, a support agent for Acme Outfitters. Be concise, empathetic, and always ' +
            'confirm order details before issuing refunds. Escalate anything over $200 to a human.',
        },
        {
          key: 'mem:user-profile',
          service: 'memory',
          serviceKind: 'memory',
          content: 'Customer: Dana Reyes. Tier: Gold. 3 prior orders, no prior refund requests.',
        },
        {
          key: 'hist:conversation',
          service: 'history',
          serviceKind: 'history',
          role: 'user',
          content: 'User: Hi, my jacket arrived with a broken zipper. I want a refund for order #48213.',
        },
      ],
    },
    {
      label: 'turn 2',
      kind: 'llm_call',
      model: 'claude-sonnet-5',
      sections: [
        {
          key: 'system:instructions',
          service: 'prompts',
          serviceKind: 'system',
          role: 'system',
          content:
            'You are triage-bot, a support agent for Acme Outfitters. Be concise, empathetic, and always ' +
            'confirm order details before issuing refunds. Escalate anything over $200 to a human.',
        },
        {
          key: 'mem:user-profile',
          service: 'memory',
          serviceKind: 'memory',
          content: 'Customer: Dana Reyes. Tier: Gold. 3 prior orders, no prior refund requests.',
        },
        {
          key: 'rag:kb-refund-policy',
          service: 'retrieval',
          serviceKind: 'retrieval',
          content:
            'KB#112 Refund Policy: Defective items are eligible for full refund within 60 days. No RMA needed ' +
            'for confirmed manufacturing defects under $250.',
        },
        {
          key: 'hist:conversation',
          service: 'history',
          serviceKind: 'history',
          role: 'user',
          content:
            'User: Hi, my jacket arrived with a broken zipper. I want a refund for order #48213.\n' +
            'Assistant: I am sorry to hear that! Let me pull up your order and confirm the defect.',
        },
      ],
    },
    {
      label: 'turn 3',
      kind: 'llm_call',
      model: 'claude-sonnet-5',
      sections: [
        {
          key: 'system:instructions',
          service: 'prompts',
          serviceKind: 'system',
          role: 'system',
          content:
            'You are triage-bot, a support agent for Acme Outfitters. Be concise, empathetic, and always ' +
            'confirm order details before issuing refunds. Escalate anything over $200 to a human.',
        },
        {
          key: 'mem:user-profile',
          service: 'memory',
          serviceKind: 'memory',
          content: 'Customer: Dana Reyes. Tier: Gold. 3 prior orders, no prior refund requests.',
        },
        {
          key: 'rag:kb-refund-policy',
          service: 'retrieval',
          serviceKind: 'retrieval',
          content:
            'KB#112 Refund Policy: Defective items are eligible for full refund within 60 days. No RMA needed ' +
            'for confirmed manufacturing defects under $250.',
        },
        {
          key: 'tool:order-lookup',
          service: 'orders-api',
          serviceKind: 'tool',
          role: 'tool',
          content: 'order_lookup(48213) -> { item: "Trailhead Jacket", price: 128.00, status: "delivered", days_since: 4 }',
        },
        {
          key: 'hist:conversation',
          service: 'history',
          serviceKind: 'history',
          role: 'user',
          content:
            'User: Hi, my jacket arrived with a broken zipper. I want a refund for order #48213.\n' +
            'Assistant: I am sorry to hear that! Let me pull up your order and confirm the defect.\n' +
            'Assistant: Found it — Trailhead Jacket, $128.00, delivered 4 days ago. That qualifies for a full refund.',
        },
      ],
    },
    {
      label: 'turn 4',
      kind: 'llm_call',
      model: 'claude-sonnet-5',
      sections: [
        {
          key: 'system:instructions',
          service: 'prompts',
          serviceKind: 'system',
          role: 'system',
          content:
            'You are triage-bot, a support agent for Acme Outfitters. Be concise, empathetic, and always ' +
            'confirm order details before issuing refunds. Escalate anything over $200 to a human.',
        },
        {
          key: 'mem:user-profile',
          service: 'memory',
          serviceKind: 'memory',
          content:
            'Customer: Dana Reyes. Tier: Gold. 3 prior orders, no prior refund requests. ' +
            'Refund of $128.00 for order #48213 approved and issued.',
        },
        {
          key: 'rag:kb-refund-policy',
          service: 'retrieval',
          serviceKind: 'retrieval',
          content:
            'KB#112 Refund Policy: Defective items are eligible for full refund within 60 days. No RMA needed ' +
            'for confirmed manufacturing defects under $250.',
        },
        {
          key: 'hist:conversation',
          service: 'history',
          serviceKind: 'history',
          role: 'user',
          content:
            'User: Hi, my jacket arrived with a broken zipper. I want a refund for order #48213.\n' +
            'Assistant: I am sorry to hear that! Let me pull up your order and confirm the defect.\n' +
            'Assistant: Found it — Trailhead Jacket, $128.00, delivered 4 days ago. That qualifies for a full refund.\n' +
            'Assistant: Refund of $128.00 issued to your original payment method, 3-5 business days.',
        },
      ],
    },
    {
      label: 'turn 5',
      kind: 'llm_call',
      model: 'claude-sonnet-5',
      sections: [
        {
          key: 'system:instructions',
          service: 'prompts',
          serviceKind: 'system',
          role: 'system',
          content:
            'You are triage-bot, a support agent for Acme Outfitters. Be concise, empathetic, and always ' +
            'confirm order details before issuing refunds. Escalate anything over $200 to a human.',
        },
        {
          key: 'mem:user-profile',
          service: 'memory',
          serviceKind: 'memory',
          content:
            'Customer: Dana Reyes. Tier: Gold. 3 prior orders, no prior refund requests. ' +
            'Refund of $128.00 for order #48213 approved and issued.',
        },
        {
          key: 'hist:conversation',
          service: 'history',
          serviceKind: 'history',
          role: 'user',
          content:
            'User: Thank you so much, that was fast!\n' +
            'Assistant: Happy to help, Dana. Anything else I can do for you today?',
        },
      ],
    },
    {
      label: 'turn 6',
      kind: 'llm_call',
      model: 'claude-sonnet-5',
      sections: [
        {
          key: 'system:instructions',
          service: 'prompts',
          serviceKind: 'system',
          role: 'system',
          content:
            'You are triage-bot, a support agent for Acme Outfitters. Be concise, empathetic, and always ' +
            'confirm order details before issuing refunds. Escalate anything over $200 to a human.',
        },
        {
          key: 'hist:conversation',
          service: 'history',
          serviceKind: 'history',
          role: 'user',
          content:
            'User: No that is all, thanks!\n' +
            'Assistant: You are welcome — have a great day!',
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Session 2: research-assistant — heavy retrieval churn, growing memory notes.
// ---------------------------------------------------------------------------

const RAG_CHUNKS = [
  'Doc#1 "Battery chemistry basics": Lithium-ion cells degrade primarily through SEI layer growth at the anode.',
  'Doc#2 "Thermal runaway": Runaway begins near 150C when the separator melts, causing internal short circuits.',
  'Doc#3 "Fast charging tradeoffs": Charging above 1C accelerates lithium plating at low temperatures.',
  'Doc#4 "Solid-state alternatives": Solid electrolytes remove flammable liquid components but face interface resistance.',
  'Doc#5 "Cycle life testing": Standard cycle-life tests use 80% depth-of-discharge at 25C ambient.',
  'Doc#6 "Recycling economics": Cobalt recovery drives most of the economic case for battery recycling today.',
];

function researchSegments(): SegmentPlan[] {
  const notes: string[] = [];
  const segments: SegmentPlan[] = [];
  const questions = [
    'Why do lithium-ion batteries degrade over time?',
    'What causes thermal runaway specifically?',
    'How does fast charging make degradation worse?',
    'Are solid-state batteries actually safer?',
    'How is cycle life measured in industry testing?',
    'Is battery recycling economically viable yet?',
    'Summarize the tradeoffs across everything we covered.',
    'One more thing — what about second-life applications for EV batteries?',
  ];

  for (let i = 0; i < questions.length; i++) {
    const chunkIdx = Math.min(i, RAG_CHUNKS.length - 1);
    notes.push(`Q${i + 1}: ${questions[i]}`);

    const sections: SectionPlan[] = [
      {
        key: 'system:instructions',
        service: 'prompts',
        serviceKind: 'system',
        role: 'system',
        content: 'You are research-bot. Answer strictly from retrieved sources and cite doc ids. Keep a running summary of the thread.',
      },
      {
        key: 'mem:running-notes',
        service: 'memory',
        serviceKind: 'memory',
        content: notes.join('\n'),
      },
      {
        key: `rag:chunk-${chunkIdx}`,
        service: 'retrieval',
        serviceKind: 'retrieval',
        content: RAG_CHUNKS[chunkIdx]!,
      },
      {
        key: 'user:question',
        service: 'chat-ui',
        serviceKind: 'user',
        role: 'user',
        content: questions[i]!,
      },
    ];

    // The second retrieved chunk (secondary source) appears from question 2 onward and
    // rotates out once superseded — demonstrates a section that appears, persists a while,
    // then drops.
    if (i >= 1 && i <= 4) {
      const secondaryIdx = (chunkIdx + 1) % RAG_CHUNKS.length;
      sections.push({
        key: 'rag:secondary',
        service: 'retrieval',
        serviceKind: 'retrieval',
        content: RAG_CHUNKS[secondaryIdx]!,
      });
    }

    segments.push({
      label: `Q${i + 1}`,
      kind: 'llm_call',
      model: 'claude-opus-5',
      sections,
    });
  }

  return segments;
}

const RESEARCH_ASSISTANT: SessionPlan = {
  id: 'seed-research-assistant',
  name: 'research-assistant: EV battery degradation deep-dive',
  agent: 'research-bot',
  metadata: { topic: 'battery-chemistry', sourceCorpus: 'internal-kb-v3' },
  ended: false,
  segments: researchSegments(),
};

// ---------------------------------------------------------------------------
// Session 3: code-review-bot — tool-heavy (lint/test output alternating).
// ---------------------------------------------------------------------------

const CODE_REVIEW: SessionPlan = {
  id: 'seed-code-review',
  name: 'code-review-bot: PR #942 rate limiter refactor',
  agent: 'reviewer',
  metadata: { repo: 'acme/api-gateway', pr: 942 },
  ended: true,
  segments: [
    {
      label: 'initial pass',
      kind: 'llm_call',
      model: 'claude-sonnet-5',
      sections: [
        {
          key: 'system:instructions',
          service: 'prompts',
          serviceKind: 'system',
          role: 'system',
          content: 'You are a meticulous code reviewer. Flag correctness, concurrency, and security issues before style nits.',
        },
        {
          key: 'hist:pr-description',
          service: 'history',
          serviceKind: 'history',
          content: 'PR #942: Replace fixed-window rate limiter with a sliding-window log implementation backed by Redis.',
        },
        {
          key: 'tool:diff',
          service: 'git-tool',
          serviceKind: 'tool',
          role: 'tool',
          content: 'diff --git a/ratelimit/window.go b/ratelimit/window.go\n+func SlidingWindow(key string, limit int) bool { ... }',
        },
      ],
    },
    {
      label: 'run lint',
      kind: 'llm_call',
      model: 'claude-sonnet-5',
      sections: [
        {
          key: 'system:instructions',
          service: 'prompts',
          serviceKind: 'system',
          role: 'system',
          content: 'You are a meticulous code reviewer. Flag correctness, concurrency, and security issues before style nits.',
        },
        {
          key: 'hist:pr-description',
          service: 'history',
          serviceKind: 'history',
          content: 'PR #942: Replace fixed-window rate limiter with a sliding-window log implementation backed by Redis.',
        },
        {
          key: 'tool:lint',
          service: 'lint-tool',
          serviceKind: 'tool',
          role: 'tool',
          content: 'golangci-lint: 2 warnings — unused import "time" (window.go:4), missing error check (window.go:31).',
        },
      ],
    },
    {
      label: 'run tests',
      kind: 'llm_call',
      model: 'claude-sonnet-5',
      sections: [
        {
          key: 'system:instructions',
          service: 'prompts',
          serviceKind: 'system',
          role: 'system',
          content: 'You are a meticulous code reviewer. Flag correctness, concurrency, and security issues before style nits.',
        },
        {
          key: 'hist:pr-description',
          service: 'history',
          serviceKind: 'history',
          content: 'PR #942: Replace fixed-window rate limiter with a sliding-window log implementation backed by Redis.',
        },
        {
          key: 'tool:test-run',
          service: 'ci-tool',
          serviceKind: 'tool',
          role: 'tool',
          content: 'go test ./ratelimit/... -race: FAIL TestSlidingWindow_Concurrent (data race on window.entries, window.go:45)',
        },
      ],
    },
    {
      label: 'draft comment',
      kind: 'llm_call',
      model: 'claude-sonnet-5',
      sections: [
        {
          key: 'system:instructions',
          service: 'prompts',
          serviceKind: 'system',
          role: 'system',
          content: 'You are a meticulous code reviewer. Flag correctness, concurrency, and security issues before style nits.',
        },
        {
          key: 'mem:findings',
          service: 'memory',
          serviceKind: 'memory',
          content: 'Findings so far: (1) unused import, (2) missing error check, (3) data race on window.entries under concurrent access — blocking.',
        },
        {
          key: 'hist:pr-description',
          service: 'history',
          serviceKind: 'history',
          content: 'PR #942: Replace fixed-window rate limiter with a sliding-window log implementation backed by Redis.',
        },
      ],
    },
    {
      label: 'author response',
      kind: 'llm_call',
      model: 'claude-sonnet-5',
      sections: [
        {
          key: 'system:instructions',
          service: 'prompts',
          serviceKind: 'system',
          role: 'system',
          content: 'You are a meticulous code reviewer. Flag correctness, concurrency, and security issues before style nits.',
        },
        {
          key: 'mem:findings',
          service: 'memory',
          serviceKind: 'memory',
          content:
            'Findings so far: (1) unused import — fixed, (2) missing error check — fixed, ' +
            '(3) data race on window.entries under concurrent access — author added a mutex, pending re-test.',
        },
        {
          key: 'hist:pr-description',
          service: 'history',
          serviceKind: 'history',
          content:
            'PR #942: Replace fixed-window rate limiter with a sliding-window log implementation backed by Redis.\n' +
            'Author: pushed fixes for lint warnings and added sync.Mutex around window.entries.',
        },
        {
          key: 'tool:diff',
          service: 'git-tool',
          serviceKind: 'tool',
          role: 'tool',
          content: 'diff --git a/ratelimit/window.go b/ratelimit/window.go\n+var mu sync.Mutex\n+func SlidingWindow(key string, limit int) bool { mu.Lock(); defer mu.Unlock(); ... }',
        },
      ],
    },
    {
      label: 're-run tests',
      kind: 'llm_call',
      model: 'claude-sonnet-5',
      sections: [
        {
          key: 'system:instructions',
          service: 'prompts',
          serviceKind: 'system',
          role: 'system',
          content: 'You are a meticulous code reviewer. Flag correctness, concurrency, and security issues before style nits.',
        },
        {
          key: 'mem:findings',
          service: 'memory',
          serviceKind: 'memory',
          content:
            'Findings so far: (1) unused import — fixed, (2) missing error check — fixed, ' +
            '(3) data race on window.entries — fixed with mutex, verified by -race re-run.',
        },
        {
          key: 'tool:test-run',
          service: 'ci-tool',
          serviceKind: 'tool',
          role: 'tool',
          content: 'go test ./ratelimit/... -race: PASS (12 tests, 0.84s)',
        },
      ],
    },
    {
      label: 'approve',
      kind: 'llm_call',
      model: 'claude-sonnet-5',
      sections: [
        {
          key: 'system:instructions',
          service: 'prompts',
          serviceKind: 'system',
          role: 'system',
          content: 'You are a meticulous code reviewer. Flag correctness, concurrency, and security issues before style nits.',
        },
        {
          key: 'mem:findings',
          service: 'memory',
          serviceKind: 'memory',
          content: 'All findings resolved. Sliding-window rate limiter approved for merge.',
        },
        {
          key: 'hist:pr-description',
          service: 'history',
          serviceKind: 'history',
          content:
            'PR #942: Replace fixed-window rate limiter with a sliding-window log implementation backed by Redis.\n' +
            'Reviewer: LGTM — approved.',
        },
      ],
    },
  ],
};

const SESSION_PLANS: SessionPlan[] = [SUPPORT_CHAT, RESEARCH_ASSISTANT, CODE_REVIEW];

function seedSession(db: ReturnType<typeof openDb>, plan: SessionPlan, baseTs: number): void {
  const spanMs = 10 * 60 * 1000; // ~10 minutes per session
  const stepMs = plan.segments.length > 1 ? spanMs / (plan.segments.length - 1) : 0;

  const session: Session = {
    id: plan.id,
    name: plan.name,
    agent: plan.agent,
    metadata: plan.metadata,
    startedAt: new Date(baseTs).toISOString(),
  };
  upsertSession(db, session);

  plan.segments.forEach((segPlan, index) => {
    const timestamp = new Date(baseTs + Math.round(stepMs * index)).toISOString();
    const sections = segPlan.sections.map((s, pos) => toSection(s, pos));
    const segment: SegmentWithSections = {
      id: `${plan.id}-seg-${index}`,
      sessionId: plan.id,
      index,
      label: segPlan.label,
      kind: segPlan.kind,
      model: segPlan.model,
      timestamp,
      sections,
    };
    upsertSegment(db, segment);
  });

  if (plan.ended) {
    const lastTs = baseTs + Math.round(stepMs * (plan.segments.length - 1)) + 15_000;
    endSession(db, plan.id, new Date(lastTs).toISOString());
  }
}

function main(): void {
  const dbPath = process.env.CT_DB ?? './data/context-trace.db';
  const db = openDb(dbPath);

  const now = Date.now();
  // Stagger the 3 sessions so they don't all overlap: most recent first.
  seedSession(db, SUPPORT_CHAT, now - 5 * 60 * 1000);
  seedSession(db, RESEARCH_ASSISTANT, now - 40 * 60 * 1000);
  seedSession(db, CODE_REVIEW, now - 90 * 60 * 1000);

  const stats = getStats(db);
  console.log(
    `Seeded ${SESSION_PLANS.length} sessions into ${dbPath}: ` +
      `${stats.sessions} sessions, ${stats.segments} segments, ${stats.sections} sections, ${stats.totalTokens} tokens.`
  );

  db.close();
}

main();
