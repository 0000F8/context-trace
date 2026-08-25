import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { openDb } from './db.js';

const port = Number.parseInt(process.env.CT_PORT ?? '4720', 10);
const dbPath = process.env.CT_DB ?? './data/context-trace.db';
const apiKey = process.env.CT_API_KEY && process.env.CT_API_KEY.length > 0 ? process.env.CT_API_KEY : undefined;
const corsOrigin = process.env.CT_CORS_ORIGIN ?? '*';

const db = openDb(dbPath);
const app = createApp(db, { apiKey, corsOrigin });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`context-trace server listening on http://localhost:${info.port} (db: ${dbPath})`);
});
