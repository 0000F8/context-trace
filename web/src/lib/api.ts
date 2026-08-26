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

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
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

async function request<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`);
  } catch {
    throw new ApiError('Could not reach the trace server. Is it running?', 0);
  }
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

/** Path (through the proxy) for a session-export download link. */
export function exportUrl(id: string): string {
  return `${BASE}/sessions/${encodeURIComponent(id)}/export`;
}

/** SSE URL for the live tail of a session (consume with EventSource). */
export function liveUrl(id: string): string {
  return `${BASE}/sessions/${encodeURIComponent(id)}/live`;
}

export async function deleteSession(id: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch {
    throw new ApiError('Could not reach the trace server. Is it running?', 0);
  }
  if (!res.ok) {
    throw new ApiError(await parseErrorBody(res, `Delete failed (${res.status})`), res.status);
  }
}
