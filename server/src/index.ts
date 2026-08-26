import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { bootstrapAuth, parseAuthMode, parsePositiveIntEnv } from './auth.js';
import { openDb } from './db.js';

const port = Number.parseInt(process.env.CT_PORT ?? '4720', 10);
const dbPath = process.env.CT_DB ?? './data/context-trace.db';
const apiKey = process.env.CT_API_KEY && process.env.CT_API_KEY.length > 0 ? process.env.CT_API_KEY : undefined;
const corsOrigin = process.env.CT_CORS_ORIGIN ?? '*';
const adminKeyEnv = process.env.CT_ADMIN_KEY && process.env.CT_ADMIN_KEY.length > 0 ? process.env.CT_ADMIN_KEY : undefined;

/** Runs `fn`, printing its error and exiting 1 on failure — the shared fail-fast-at-boot posture (spec3.md §A). */
function parseOrExit<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Fail fast on an unrecognized CT_AUTH rather than silently falling open (spec3.md §A).
const authMode = parseOrExit(() => parseAuthMode(process.env.CT_AUTH));
const adminRateLimit = parseOrExit(() => parsePositiveIntEnv(process.env.CT_ADMIN_RATE_LIMIT, 'CT_ADMIN_RATE_LIMIT', 10));
const adminRateWindowMs = parseOrExit(() =>
  parsePositiveIntEnv(process.env.CT_ADMIN_RATE_WINDOW_MS, 'CT_ADMIN_RATE_WINDOW_MS', 60_000)
);

const db = openDb(dbPath);

const bootstrap = parseOrExit(() => bootstrapAuth(db, { authMode, apiKey, adminKeyEnv }));
if (bootstrap.legacyApiKeyIgnored) {
  console.warn('CT_API_KEY is set but CT_AUTH=key is active: CT_API_KEY has no effect in key mode.');
}
if (bootstrap.generatedAdminKey) {
  console.log('');
  console.log('======================================================================');
  console.log(' context-trace: generated an admin key for CT_AUTH=key mode.');
  console.log(' STORE THIS NOW — it is only ever shown once, and only the hash is kept:');
  console.log('');
  console.log(`   ${bootstrap.generatedAdminKey}`);
  console.log('');
  console.log(' Use it to mint project keys via the admin API or `npm run keys`.');
  console.log('======================================================================');
  console.log('');
}

const app = createApp(db, { apiKey, corsOrigin, authMode, adminRateLimit, adminRateWindowMs });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`context-trace server listening on http://localhost:${info.port} (db: ${dbPath}, auth: ${authMode})`);
});
