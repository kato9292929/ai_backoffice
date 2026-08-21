import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Stripe from 'stripe';
import { Pool } from 'pg';

const PORT = Number(process.env.PORT ?? '4245');
const WEBHOOK_SECRET = requiredEnv('STRIPE_WEBHOOK_SECRET');
const DATABASE_URL = requiredEnv('DATABASE_URL');

const pool = new Pool({ connectionString: DATABASE_URL });

const HANDLED = new Set([
  'v2.core.approval_request.created',
  'v2.core.approval_request.approved',
  'v2.core.approval_request.rejected',
  'v2.core.approval_request.canceled',
  'v2.core.approval_request.expired',
  'v2.core.approval_request.succeeded',
  'v2.core.approval_request.failed',
]);

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') throw new Error(`missing required env ${name}`);
  return v.trim();
}

async function migrate(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, '..', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function statusForType(type: string): string {
  return type.slice(type.lastIndexOf('.') + 1);
}

function approvalIdOf(evt: any): string | undefined {
  return (
    evt?.related_object?.id ??
    evt?.data?.object?.id ??
    evt?.data?.id ??
    evt?.object?.id
  );
}

async function record(evt: any): Promise<'stored' | 'ignored' | 'duplicate'> {
  const type: string = evt?.type ?? '';
  if (!HANDLED.has(type)) return 'ignored';
  const approvalId = approvalIdOf(evt);
  const eventId: string | undefined = evt?.id;
  if (!approvalId || !eventId) return 'ignored';

  const obj = evt?.related_object ?? evt?.data?.object ?? {};
  const res = await pool.query(
    `INSERT INTO stripe_approval_event
       (event_id, approval_request_id, type, status, dashboard_url, expires_at, received_at, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      eventId,
      approvalId,
      type,
      statusForType(type),
      obj?.dashboard_url ?? null,
      obj?.expires_at ?? null,
      Date.now(),
      JSON.stringify(evt),
    ],
  );
  return res.rowCount === 0 ? 'duplicate' : 'stored';
}

async function main(): Promise<void> {
  await migrate();

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/healthz')) {
      res.writeHead(200).end('ok');
      return;
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/webhook')) {
      res.writeHead(404).end('not found');
      return;
    }
    const raw = await readRawBody(req);
    const sig = req.headers['stripe-signature'];
    if (typeof sig !== 'string') {
      res.writeHead(400).end('missing signature');
      return;
    }
    try {
      Stripe.webhooks.signature.verifyHeader(raw.toString('utf8'), sig, WEBHOOK_SECRET);
    } catch {
      res.writeHead(400).end('bad signature');
      return;
    }
    let evt: unknown;
    try {
      evt = JSON.parse(raw.toString('utf8'));
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }
    try {
      const outcome = await record(evt);
      console.log(
        JSON.stringify({
          at: Date.now(),
          approval_request_id: approvalIdOf(evt),
          type: (evt as any)?.type,
          outcome,
        }),
      );
    } catch (err) {
      console.error('record failed', err instanceof Error ? err.message : String(err));
      res.writeHead(500).end('error');
      return;
    }
    res.writeHead(200).end('ok');
  });

  server.listen(PORT, () => {
    console.log(`stripe-approvals-sink listening on :${PORT}/webhook`);
  });
}

main().catch((err) => {
  console.error('sink failed to start', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
