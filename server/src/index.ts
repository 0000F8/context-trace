import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { bootstrapAuth, parseAuthMode } from './auth.js';
import { openDb } from './db.js';

const port = Number.parseInt(process.env.CT_PORT ?? '4720', 10);
const dbPath = process.env.CT_DB ?? './data/context-trace.db';
const apiKey = process.env.CT_API_KEY && process.env.CT_API_KEY.length > 0 ? process.env.CT_API_KEY : undefined;
const corsOrigin = process.env.CT_CORS_ORIGIN ?? '*';
const adminKeyEnv = process.env.CT_ADMIN_KEY && process.env.CT_ADMIN_KEY.length > 0 ? process.env.CT_ADMIN_KEY : undefined;

// Fail fast on an unrecognized CT_AUTH rather than silently falling open (spec3.md §A).
let authMode;
try {
  authMode = parseAuthMode(process.env.CT_AUTH);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const db = openDb(dbPath);

let bootstrap;
try {
  bootstrap = bootstrapAuth(db, { authMode, apiKey, adminKeyEnv });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
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

const app = createApp(db, { apiKey, corsOrigin, authMode });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`context-trace server listening on http://localhost:${info.port} (db: ${dbPath}, auth: ${authMode})`);
});
