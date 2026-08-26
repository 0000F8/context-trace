/**
 * Pure parse/build helpers for the trace view's deep-link query params
 * (?segment=N&section=<key>). Kept side-effect free so the URL read/write
 * (window.location / history.replaceState) lives entirely in the page
 * component — see .omc/autopilot/spec2.md section G2.
 */
export interface DeepLinkParams {
  segment: number | null;
  section: string | null;
}

/** Parses segment/section from a `location.search` string. Invalid or absent values become null. */
export function parseDeepLink(search: string): DeepLinkParams {
  const params = new URLSearchParams(search);
  const segmentRaw = params.get('segment');
  let segment: number | null = null;
  if (segmentRaw != null && /^\d+$/.test(segmentRaw)) {
    const n = Number(segmentRaw);
    if (Number.isFinite(n)) segment = n;
  }
  const sectionRaw = params.get('section');
  const section = sectionRaw && sectionRaw.length > 0 ? sectionRaw : null;
  return { segment, section };
}

/**
 * Builds a new search string (leading '?', or '' when empty) with segment/section
 * set or removed (null clears the param). Any other existing params are preserved.
 */
export function buildDeepLinkSearch(currentSearch: string, params: DeepLinkParams): string {
  const usp = new URLSearchParams(currentSearch);
  if (params.segment != null) usp.set('segment', String(params.segment));
  else usp.delete('segment');
  if (params.section != null) usp.set('section', params.section);
  else usp.delete('section');
  const qs = usp.toString();
  return qs ? `?${qs}` : '';
}
