# @context-trace/langchain

A LangChain-compatible callback handler that captures LLM context assemblies
into [context-trace](../../README.md), with **no dependency on the
`langchain` package**. Compatibility is purely structural: LangChain invokes
callback handler methods by name with a fixed argument list, and this class
implements the ones it needs, typed against minimal local interfaces that
model only the fields it actually reads.

## Install

Inside this monorepo, the package is already linked via npm workspaces:

```json
{ "dependencies": { "@context-trace/langchain": "0.1.0" } }
```

## Quick start

```ts
import { createClient } from '@context-trace/sdk';
import { ContextTraceCallbackHandler } from '@context-trace/langchain';
import { ChatOpenAI } from '@langchain/openai'; // any LangChain chat model

const ct = createClient({ endpoint: 'http://localhost:4720', onError: console.warn });
const handler = new ContextTraceCallbackHandler({ client: ct, agent: 'support-bot' });

const model = new ChatOpenAI({ model: 'gpt-4o-mini' });

const result = await model.invoke('What is context-trace?', {
  callbacks: [handler],
});
```

Wired into a chain instead of a bare model call, the handler follows the run
tree automatically:

```ts
import { RunnableSequence } from '@langchain/core/runnables';

const chain = RunnableSequence.from([promptTemplate, model, outputParser]);

await chain.invoke(
  { question: 'What is context-trace?' },
  { runName: 'support-chat', callbacks: [handler] },
);
```

Every top-level `invoke`/`stream` call becomes one session (named from
LangChain's `runName`/chain name, or `options.sessionName` if you pass one);
every LLM call inside it becomes one segment; the segment's completion (or
error) is attached as that segment's outcome.

## API

`new ContextTraceCallbackHandler(options)`:

| Option        | Type      | Description |
|---------------|-----------|--------------|
| `client`      | `Client`  | Required. An already-created `@context-trace/sdk` client (`createClient(...)`). |
| `sessionName` | `string?` | Overrides the session name for every root run. Defaults to the chain's own name, then `'langchain-run'`. |
| `agent`       | `string?` | Passed through to `Session.agent` on every session this handler starts. |

The handler implements: `name`, `handleChainStart`, `handleChainEnd`,
`handleChainError`, `handleLLMStart`, `handleChatModelStart`, `handleLLMEnd`,
`handleLLMError`, `handleToolStart`, `handleToolEnd`.

## Mapping

- **Root run → session.** A `handleChainStart` with no `parentRunId` (a
  top-level `invoke`/`stream`/`batch` call) starts a session via
  `client.startSession({ id: runId, name, agent })`. Its matching
  `handleChainEnd` **or** `handleChainError` calls `session.end()` — LangChain
  calls `handleChainError` instead of `handleChainEnd` when the run throws,
  so a chain that always fails still gets its session closed out instead of
  leaking an open session forever.
- **Nested chain runs** (a `parentRunId` is present) don't start a new
  session — they inherit whichever session their parent run belongs to, so
  LLM calls several levels deep in a chain still land in the same session.
  Their own `handleChainEnd`/`handleChainError` just drops that inherited
  bookkeeping entry; only the root run's end/error closes the session itself.
- **LLM call → segment.** Both `handleLLMStart` (plain-text prompts, used by
  completion-style LLMs) and `handleChatModelStart` (structured messages,
  used by chat models) open one segment per call, `kind: 'llm_call'`,
  `model` extracted from the invocation params when available, else from the
  serialized model's name.
  - `handleLLMStart`: one section per prompt string, key `prompt:<i>`,
    `service: 'prompts'`, `serviceKind: 'system'`, `role: 'system'` — a
    raw completion prompt is treated as one fully-assembled system context,
    since it carries no per-message role information of its own.
  - `handleChatModelStart`: one section per message in the **first** batch
    entry (LangChain's chat-model hooks pass a `BaseMessage[][]` batch
    dimension; only `messages[0]` is captured, matching the common
    single-call case), key `msg:<i>:<role>` where `<role>` is the normalized
    role. Role → `serviceKind` mapping: `system → system`, `user → user`,
    `assistant → other`, `tool → tool`.
- **LLM call end → outcome.** `handleLLMEnd` calls `segment.record()`, then
  `segment.outcome({ responseText, latencyMs })`. `latencyMs` is measured
  from an internal `Map<runId, number>` populated at `handleLLMStart`/
  `handleChatModelStart` time — it is **wall-clock time in this process**,
  not a server-reported duration. `responseText` comes from the first
  generation's `text` (completion models) or `message.content`, stringified
  (chat models).
- **LLM call error → outcome.** `handleLLMError` calls `segment.record()`,
  then `segment.outcome({ error: err.message, latencyMs })` instead of a
  normal outcome. **`err.message` is stored verbatim** and is readable
  through context-trace's ordinary (open) read/export path, the same as any
  other section content — nothing here redacts it. If your model calls can
  throw errors whose messages embed secrets (an API key echoed back in a
  provider error, a raw request body in an SDK exception, etc.), scrub or
  wrap that error before it reaches `handleLLMError` — e.g. by wrapping the
  model call yourself and re-throwing a sanitized `Error`, since this
  handler has no way to know what a given provider's error messages contain.
- **No surrounding chain run.** A bare `model.invoke(..., { callbacks:
  [handler] })` with no chain wrapping it never sees a `handleChainStart`, so
  there's no session to inherit. In that case the LLM run falls back to
  `client.session(runId)` — the SDK's stateless re-bind — so the segment
  still ships, just without an explicit `session.started` event or a
  human-chosen session name.

## Privacy modes

The handler has no privacy API of its own — it inherits whatever
`contentMode` and `redact` the `client` you pass to it was configured with
(see the [SDK README's Privacy modes section](../sdk/README.md#privacy-modes)).
Every `segment.section(...)` call this handler makes goes through the same
client, so a client created with `contentMode: 'hash-only'` (or a `redact`
callback) applies uniformly to every session/segment/section this handler
records — prompts, chat messages, and model outputs alike. There is no
separate `ContextTraceCallbackHandler` option to set a content mode or
redactor; configure it once on `createClient(...)` instead.

## Tools

`handleToolStart`/`handleToolEnd` are implemented as **no-ops**. Tool calls
are not captured as segment sections by this handler — correlating a tool
result to "the next LLM call's context" reliably requires knowing how your
specific chain re-injects that result (as a message, a retrieval doc, a
scratchpad field, ...), which varies per chain and is exactly the kind of
domain knowledge a generic adapter can't have. If you want tool I/O in the
trace, add it yourself as a section on the relevant segment from your own
code — see `segment.section(...)` in the [SDK README](../sdk/README.md).

## Out of scope

No support for streaming partial tokens (`handleLLMNewToken`), no automatic
tool-call sections (see above).
