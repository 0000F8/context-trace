/**
 * @context-trace/sdk — zero-runtime-dependency client for capturing LLM
 * context assemblies (sessions, segments, sections) and shipping them to a
 * context-trace server.
 *
 * Every capture call (startSession, session, segment, section, record, end)
 * is a synchronous, non-throwing enqueue. Network I/O only ever happens on
 * the background flusher or when flush()/shutdown() are called explicitly.
 * See the README for the full options table and a framework-hook adapter
 * example.
 */

import type { Client, ClientOptions } from './client.js';
import { ClientImpl } from './client.js';

export type {
  Client,
  ClientOptions,
  SegmentBuilder,
  SegmentOptions,
  SectionInput,
  SessionHandle,
  StartSessionOptions,
} from './client.js';

/** Create a context-trace client. See README for the full options table. */
export function createClient(options: ClientOptions): Client {
  return new ClientImpl(options);
}

export { estimateTokens, fnv1a64, generateId } from '@context-trace/types';
export type {
  IngestEvent,
  IngestRequest,
  IngestResponse,
  Section,
  SectionRole,
  Segment,
  SegmentKind,
  SegmentWithSections,
  ServiceKind,
  Session,
} from '@context-trace/types';
