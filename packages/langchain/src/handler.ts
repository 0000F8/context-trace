/**
 * `ContextTraceCallbackHandler` — a LangChain-shaped callback handler with
 * zero dependency on the `langchain` package itself. Compatibility is
 * structural: LangChain's `BaseCallbackHandler` calls methods by name with a
 * fixed argument list, and TypeScript/JS don't care that the object handed
 * to `callbacks: [handler]` wasn't built from LangChain's own base class, as
 * long as the methods it looks for exist and accept the arguments it passes.
 *
 * The structural types below (`Serialized`, `StructuralMessage`, ...) model
 * only the fields this handler actually reads from LangChain's real types.
 */

import type {
  Client,
  SectionRole,
  SegmentBuilder,
  ServiceKind,
  SessionHandle,
} from '@context-trace/sdk';

/** Minimal shape of LangChain's `Serialized` (a serialized Runnable/model/tool). */
export interface Serialized {
  id?: string[];
  name?: string;
  lc?: number;
  type?: string;
}

/**
 * Minimal shape of LangChain's `BaseMessage`. `content` is `unknown` because
 * real messages allow either a plain string or a `MessageContent[]` (for
 * multi-modal messages) — this handler stringifies whatever it gets.
 */
export interface StructuralMessage {
  content: unknown;
  /** LangChain messages expose this; e.g. 'system' | 'human' | 'ai' | 'tool' | 'function'. */
  _getType?: () => string;
  /** Some non-LangChain message-like objects use `role` directly instead. */
  role?: string;
  name?: string;
}

export interface StructuralGeneration {
  text?: string;
  message?: StructuralMessage;
}

/** Minimal shape of LangChain's `LLMResult`. */
export interface StructuralLLMResult {
  generations: StructuralGeneration[][];
  llmOutput?: Record<string, unknown> | null;
}

export interface ContextTraceCallbackHandlerOptions {
  /** An already-created @context-trace/sdk client. */
  client: Client;
  /** Session display name. Defaults to the root run's chain name, then 'langchain-run'. */
  sessionName?: string;
  agent?: string;
}

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** Maps a LangChain message type (or a plain `role` field) onto our SectionRole. */
function normalizeMessageRole(message: StructuralMessage): SectionRole {
  const type = message.role ?? (typeof message._getType === 'function' ? message._getType() : undefined);
  switch (type) {
    case 'system':
      return 'system';
    case 'ai':
    case 'assistant':
      return 'assistant';
    case 'tool':
    case 'function':
      return 'tool';
    case 'human':
    case 'user':
    default:
      return 'user';
  }
}

function roleToServiceKind(role: SectionRole): ServiceKind {
  switch (role) {
    case 'system':
      return 'system';
    case 'tool':
      return 'tool';
    case 'assistant':
      return 'other';
    case 'user':
    default:
      return 'user';
  }
}

function extractModelName(serialized: Serialized, extraParams?: Record<string, unknown>): string | undefined {
  const invocationParams = extraParams?.['invocation_params'];
  if (invocationParams && typeof invocationParams === 'object') {
    const params = invocationParams as Record<string, unknown>;
    const model = params['model'] ?? params['model_name'];
    if (typeof model === 'string') return model;
  }
  if (typeof serialized.name === 'string') return serialized.name;
  const idTail = serialized.id?.[serialized.id.length - 1];
  return typeof idTail === 'string' ? idTail : undefined;
}

function extractFirstGenerationText(output: StructuralLLMResult): string | undefined {
  const first = output.generations?.[0]?.[0];
  if (!first) return undefined;
  if (typeof first.text === 'string') return first.text;
  if (first.message) return contentToString(first.message.content);
  return undefined;
}

/**
 * Captures a LangChain run tree into context-trace: the root chain/agent run
 * becomes a session, each LLM call becomes a segment (one section per
 * prompt/message), and the LLM call's completion or failure is attached as
 * that segment's outcome.
 *
 * Tool calls are intentionally NOT captured as segment sections here — see
 * the package README's "Tools" section for why and how to add them yourself
 * from the host app.
 */
export class ContextTraceCallbackHandler {
  /** LangChain callback handlers are identified by this property. */
  name = 'ContextTraceCallbackHandler';

  private readonly client: Client;
  private readonly sessionName: string | undefined;
  private readonly agent: string | undefined;

  /** runId -> the session that run belongs to (root chain runs and everything nested under them). */
  private readonly runToSession = new Map<string, SessionHandle>();
  /** runId (of an in-flight LLM call) -> its open segment builder. */
  private readonly segments = new Map<string, SegmentBuilder>();
  /** runId (of an in-flight LLM call) -> Date.now() at handleLLMStart/handleChatModelStart. */
  private readonly startedAt = new Map<string, number>();

  constructor(options: ContextTraceCallbackHandlerOptions) {
    this.client = options.client;
    this.sessionName = options.sessionName;
    this.agent = options.agent;
  }

  handleChainStart(chain: Serialized, _inputs: unknown, runId: string, parentRunId?: string): void {
    if (parentRunId) {
      // Nested chain run: inherit the root run's session (if known) so LLM
      // calls further down this branch resolve to the same session.
      const parentSession = this.runToSession.get(parentRunId);
      if (parentSession) this.runToSession.set(runId, parentSession);
      return;
    }
    const idTail = chain.id?.[chain.id.length - 1];
    const session = this.client.startSession({
      id: runId,
      name: this.sessionName ?? chain.name ?? idTail ?? 'langchain-run',
      agent: this.agent,
    });
    this.runToSession.set(runId, session);
  }

  handleChainEnd(_outputs: unknown, runId: string, parentRunId?: string): void {
    this.finishChainRun(runId, parentRunId);
  }

  /**
   * LangChain calls this instead of handleChainEnd when a chain run fails.
   * A failed root run still needs its session ended and its map entry
   * cleaned up — otherwise a chain that always errors would leak one
   * runToSession entry (and one open, never-ended session) per invocation.
   */
  handleChainError(_err: unknown, runId: string, parentRunId?: string): void {
    this.finishChainRun(runId, parentRunId);
  }

  private finishChainRun(runId: string, parentRunId?: string): void {
    if (parentRunId) {
      // Nested chain run: no session lifecycle to end here (that's the root
      // run's job) — just drop the inherited map entry so it doesn't leak.
      this.runToSession.delete(runId);
      return;
    }
    const session = this.runToSession.get(runId);
    session?.end();
    this.runToSession.delete(runId);
  }

  handleLLMStart(
    llm: Serialized,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
  ): void {
    const session = this.resolveSession(runId, parentRunId);
    const segment = session.segment({ id: runId, kind: 'llm_call', model: extractModelName(llm, extraParams) });
    prompts.forEach((prompt, i) => {
      segment.section({
        key: `prompt:${i}`,
        service: 'prompts',
        serviceKind: 'system',
        role: 'system',
        content: prompt,
      });
    });
    this.segments.set(runId, segment);
    this.startedAt.set(runId, Date.now());
  }

  handleChatModelStart(
    llm: Serialized,
    messages: StructuralMessage[][],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
  ): void {
    const session = this.resolveSession(runId, parentRunId);
    const segment = session.segment({ id: runId, kind: 'llm_call', model: extractModelName(llm, extraParams) });
    // LangChain's chat-model hooks pass a batch dimension (messages: BaseMessage[][]);
    // only the first batch entry is captured, matching the common single-call case.
    const batch = messages[0] ?? [];
    batch.forEach((message, i) => {
      const role = normalizeMessageRole(message);
      segment.section({
        key: `msg:${i}:${role}`,
        service: 'prompts',
        serviceKind: roleToServiceKind(role),
        role,
        content: contentToString(message.content),
      });
    });
    this.segments.set(runId, segment);
    this.startedAt.set(runId, Date.now());
  }

  handleLLMEnd(output: StructuralLLMResult, runId: string, _parentRunId?: string): void {
    const segment = this.segments.get(runId);
    if (!segment) return;
    segment.record();
    const startedAt = this.startedAt.get(runId);
    segment.outcome({
      responseText: extractFirstGenerationText(output),
      latencyMs: startedAt !== undefined ? Date.now() - startedAt : undefined,
    });
    this.finishLlmRun(runId);
  }

  handleLLMError(err: unknown, runId: string, _parentRunId?: string): void {
    const segment = this.segments.get(runId);
    if (!segment) return;
    segment.record();
    const startedAt = this.startedAt.get(runId);
    segment.outcome({
      error: err instanceof Error ? err.message : String(err),
      latencyMs: startedAt !== undefined ? Date.now() - startedAt : undefined,
    });
    this.finishLlmRun(runId);
  }

  /**
   * Drops every map entry keyed by an LLM run's own id once that run is
   * done. `segments`/`startedAt` were always scoped to the LLM run alone,
   * but `resolveSession` also stashes the LLM run's resolved session under
   * its own runId in `runToSession` (see below) — without this, that entry
   * would never be cleaned up and `runToSession` would grow by one per LLM
   * call for the life of the process.
   */
  private finishLlmRun(runId: string): void {
    this.segments.delete(runId);
    this.startedAt.delete(runId);
    this.runToSession.delete(runId);
  }

  /**
   * Present so this class satisfies LangChain's full callback handler
   * interface, but intentionally a no-op — see the README's "Tools" section.
   */
  handleToolStart(): void {}

  /** @see handleToolStart */
  handleToolEnd(): void {}

  private resolveSession(runId: string, parentRunId?: string): SessionHandle {
    const known = parentRunId ? this.runToSession.get(parentRunId) : undefined;
    if (known) {
      this.runToSession.set(runId, known);
      return known;
    }
    // No known parent session in this handler instance — e.g. a bare
    // `model.invoke()` with no surrounding chain run, or a parent run that
    // started before this handler was constructed. Re-bind by id instead of
    // starting a fresh session, per @context-trace/sdk's stateless
    // correlation pattern (`client.session(id)`).
    const session = this.client.session(parentRunId ?? runId);
    this.runToSession.set(runId, session);
    return session;
  }
}
