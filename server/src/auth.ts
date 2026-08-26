/**
 * Auth-mode parsing and key resolution for the v0.3 tenancy spine (spec3.md §A/§C).
 * Kept separate from app.ts so the HTTP wiring stays focused on routing/middleware.
 */
import type { AuthMode, KeyRole } from '@context-trace/types';
import type { Db } from './db.js';
import { constantTimeEqual, hashKey, mintKey } from './keys.js';
import * as store from './store.js';

/**
 * Parses `CT_AUTH`. Precedence is explicit so upgrades never tighten silently:
 * unset/'' and 'none' both mean today's open (or legacy write-key) behavior;
 * 'key' turns on project-scoped auth; anything else fails fast rather than
 * silently falling open.
 */
export function parseAuthMode(raw: string | undefined): AuthMode {
  if (raw === undefined || raw === '' || raw === 'none') return 'none';
  if (raw === 'key') return 'key';
  throw new Error(`invalid CT_AUTH value: ${JSON.stringify(raw)} (expected unset, "none", or "key")`);
}

export interface ResolvedKey {
  keyId: string;
  projectId: string;
  role: KeyRole;
}

/** Resolves a bearer key's project + role. Returns undefined for unknown or revoked keys. */
export function resolveApiKey(db: Db, plaintext: string): ResolvedKey | undefined {
  const candidateHash = hashKey(plaintext);
  const row = store.findActiveKeyByHash(db, candidateHash);
  if (!row) return undefined;
  // Defense-in-depth beyond the indexed hash lookup above: the same constant-time
  // helper v0.2 uses for its single static key comparison.
  if (!constantTimeEqual(candidateHash, row.keyHash)) return undefined;
  return { keyId: row.id, projectId: row.projectId, role: row.role };
}

export interface BootstrapResult {
  /** CT_API_KEY was set while CT_AUTH=key — it has no effect; the caller should warn once. */
  legacyApiKeyIgnored: boolean;
  /** A fresh admin key was minted at boot; its plaintext must be printed exactly once. */
  generatedAdminKey?: string;
}

/**
 * Ensures an admin key exists when running in 'key' mode. `CT_ADMIN_KEY` supplies one
 * (hashed at boot, idempotent across restarts); otherwise, if no active admin key exists
 * yet, a fresh one is minted and its plaintext returned for the caller to print once.
 * No-op outside 'key' mode.
 */
export function bootstrapAuth(
  db: Db,
  opts: { authMode: AuthMode; apiKey?: string; adminKeyEnv?: string }
): BootstrapResult {
  const legacyApiKeyIgnored = opts.authMode === 'key' && Boolean(opts.apiKey);
  if (opts.authMode !== 'key') return { legacyApiKeyIgnored };

  if (opts.adminKeyEnv) {
    store.ensureAdminKeyFromEnv(db, opts.adminKeyEnv);
    return { legacyApiKeyIgnored };
  }

  if (!store.hasActiveAdminKey(db)) {
    const minted = mintKey('admin');
    store.insertBootstrapAdminKey(db, minted);
    return { legacyApiKeyIgnored, generatedAdminKey: minted.plaintext };
  }

  return { legacyApiKeyIgnored };
}
