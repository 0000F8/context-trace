/**
 * Project-key crypto: minting, hashing, and constant-time verification. Pure
 * node:crypto, no DB or HTTP concerns here so it stays independently testable.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { KeyRole } from '@context-trace/types';

const ROLE_LETTER: Record<KeyRole, string> = { write: 'w', read: 'r', admin: 'a' };

export interface MintedKey {
  /** The real secret. Returned to the caller exactly once; never persisted. */
  plaintext: string;
  /** sha256 hex digest — the only form stored in `project_keys.key_hash`. */
  hash: string;
  /** First 12 chars of the plaintext, safe to display/log for identification. */
  prefix: string;
}

/** Constant-time string equality via fixed-length SHA-256 digests (safe even for unequal-length inputs). */
export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

/** sha256 hex digest of a key's plaintext. */
export function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * Mints a new project key: `ct<role-letter>_<32 random bytes, base64url>` — e.g.
 * `ctw_...` for write, `ctr_...` for read, `cta_...` for admin. Only the hash and
 * a display prefix are meant to be persisted; the plaintext is surfaced once.
 */
export function mintKey(role: KeyRole): MintedKey {
  const random = randomBytes(32).toString('base64url');
  const plaintext = `ct${ROLE_LETTER[role]}_${random}`;
  return { plaintext, hash: hashKey(plaintext), prefix: plaintext.slice(0, 12) };
}
