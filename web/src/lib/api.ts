import type {
  CompiledTrace,
  SearchResponse,
  SegmentDetail,
  SessionAnalytics,
  SessionDetail,
  SessionSummary,
  Stats,
} from '@context-trace/types';

const BASE = '/api/v1';

const API_KEY_STORAGE = 'ct:apiKey';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Reads the stored API key, if any. `localStorage` access is wrapped since some environments (private tabs, SSR) can throw. */
export function getApiKey(): string | null {
  try {
    return localStorage.getItem(API_KEY_STORAGE);
  } catch {
    return null;
  }
}

export function hasApiKey(): boolean {
  return getApiKey() != null;
}

// Bumped on every save/clear so an in-flight request can tell whether the key
// it was sent under is still the current one by the time its response lands.
// See doFetch's stale-401 guard below.
let keyEpoch = 0;

export function setApiKey(key: string): void {
  try {
    localStorage.setItem(API_KEY_STORAGE, key);
  } catch {
    // storage unavailable — the key just won't survive a reload.
  }
  keyEpoch++;
}

export function clearApiKey(): void {
  try {
    localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    // storage unavailable — nothing to clear.
  }
  keyEpoch++;
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** Subscribes to 401 responses from any request. Returns an unsubscribe function. */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function authHeaders(): HeadersInit {
  const key = getApiKey();
  return key ? { 'x-api-key': key } : {};
}

async function parseErrorBody(res: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string') {
      return (body as { error: string }).error;
    }
  } catch {
    // ignore — body wasn't JSON
  }
  return fallback;
}

async function doFetch(path: string, init?: RequestInit): Promise<Response> {
  // Captured before the request goes out, so a 401 that was already in
  // flight when the key changed (a save or a sign-out) can be recognized as
  // stale once it lands, rather than re-locking the app over a request that
  // nobody would even retry under the key that's active now.
  const epoch = keyEpoch;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers: { ...authHeaders(), ...init?.headers } });
  } catch {
    throw new ApiError('Could not reach the trace server. Is it running?', 0);
  }
  if (res.status === 401 && epoch === keyEpoch) {
    // Fires before the caller's own catch runs, so the app can swap in the
    // key prompt instead of (or ahead of) any component's generic error state.
    unauthorizedListeners.forEach((listener) => listener());
  }
  return res;
}

async function request<T>(path: string): Promise<T> {
  const res = await doFetch(path);
  if (!res.ok) {
    throw new ApiError(await parseErrorBody(res, `Request failed (${res.status})`), res.status);
  }
  return res.json() as Promise<T>;
}

export function getStats(): Promise<Stats> {
  return request<Stats>('/stats');
}

export function listSessions(params: { limit?: number; offset?: number; q?: string } = {}): Promise<{
  sessions: SessionSummary[];
  total: number;
}> {
  const search = new URLSearchParams();
  if (params.limit != null) search.set('limit', String(params.limit));
  if (params.offset != null) search.set('offset', String(params.offset));
  if (params.q) search.set('q', params.q);
  const qs = search.toString();
  return request(`/sessions${qs ? `?${qs}` : ''}`);
}

export function getSession(id: string): Promise<SessionDetail> {
  return request(`/sessions/${encodeURIComponent(id)}`);
}

export function getTrace(id: string): Promise<CompiledTrace> {
  return request(`/sessions/${encodeURIComponent(id)}/trace`);
}

export function getSegmentDetail(id: string, index: number): Promise<SegmentDetail> {
  return request(`/sessions/${encodeURIComponent(id)}/segments/${index}`);
}

export function getAnalytics(id: string): Promise<SessionAnalytics> {
  return request<SessionAnalytics>(`/sessions/${encodeURIComponent(id)}/trace/analytics`);
}

export function searchContent(q: string, limit = 20): Promise<SearchResponse> {
  return request<SearchResponse>(`/search?q=${encodeURIComponent(q)}&limit=${limit}`);
}

/** Path (through the proxy) for a session export. Exported for anyone scripting against the API directly; the web UI itself downloads via `fetchExport` below so the key can ride in a header instead of this URL. */
export function exportUrl(id: string): string {
  return `${BASE}/sessions/${encodeURIComponent(id)}/export`;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
}

/** Extracts a filename from a `content-disposition` header, handling both the plain and RFC 5987 (`filename*=UTF-8''...`) forms. */
function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      // malformed encoding — fall through to the plain form below.
    }
  }
  const plainMatch = /filename="?([^";]+)"?/i.exec(disposition);
  return plainMatch?.[1]?.trim() || null;
}

/**
 * Fetches a session export through the same authenticated path as every
 * other request (so `x-api-key` rides in a header, not the URL, and a 401
 * here participates in the normal key-prompt flow) and hands back a Blob the
 * caller can turn into a download.
 */
export async function fetchExport(id: string): Promise<ExportResult> {
  const res = await doFetch(`/sessions/${encodeURIComponent(id)}/export`);
  if (!res.ok) {
    throw new ApiError(await parseErrorBody(res, `Export failed (${res.status})`), res.status);
  }
  const blob = await res.blob();
  const filename = filenameFromDisposition(res.headers.get('content-disposition')) ?? `${id}.context-trace.json`;
  return { blob, filename };
}

/**
 * SSE URL for the live tail of a session (consume with EventSource).
 *
 * `EventSource` can't set request headers, so it can't carry `x-api-key` the
 * way every other request does. This is the one deliberate exception to "the
 * key never appears in a URL": in key mode, the live endpoint also accepts
 * `?key=`, checked server-side against the same hashes as the header.
 */
export function liveUrl(id: string): string {
  const key = getApiKey();
  const path = `/sessions/${encodeURIComponent(id)}/live`;
  return key ? `${BASE}${path}?key=${encodeURIComponent(key)}` : `${BASE}${path}`;
}

export async function deleteSession(id: string): Promise<void> {
  const res = await doFetch(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    throw new ApiError(await parseErrorBody(res, `Delete failed (${res.status})`), res.status);
  }
}
