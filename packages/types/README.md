# @context-trace/types

Shared wire types, compiled-trace types, and utilities for
[context-trace](https://github.com/0000F8/context-trace): the contract
between the SDK, the server, and the web inspector.

Dependency-free and runtime-agnostic (no `node:*` imports) — safe to import
from browser code, edge runtimes, or Node.

## What's in here

- **Wire types** — the `POST /v1/ingest` event shapes (`SessionEvent`,
  `SegmentEvent`, `SectionInput`, outcomes) shared by every SDK.
- **Compiled-trace types** — the shapes the server emits from
  `/v1/sessions/:id/trace` (diffed segments, section spans, analytics,
  findings).
- **Utilities** — `fnv1a64` (the content-hash function used to detect
  changed sections; the Python SDK ports it bit-for-bit), `estimateTokens`,
  and `generateId`.

## Install

```sh
npm install @context-trace/types
```

You typically don't depend on this directly — `@context-trace/sdk` and
`@context-trace/langchain` re-export what you need — but it's published
standalone for tooling that only needs the types (e.g. a custom ingest
client or a server-side script).

## License

Apache-2.0. See [LICENSE](./LICENSE).
