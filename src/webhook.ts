import { createServer, type IncomingMessage } from 'node:http';
import Stripe from 'stripe';
import { config } from './config.js';
import { log } from './logger.js';
import { appendAudit, findByApprovalId } from './audit-store.js';
import { retrieveApprovalRequest } from './stripe-client.js';
import type { ActionType, AuditRecord, FinalResult } from './types.js';

/**
 * M4 — receive Approvals webhook events (via `stripe listen`) and reflect the
 * human decision into the audit log.
 *
 * Handled event types (7, per current Stripe docs):
 *   v2.core.approval_request.created    (request created & submitted to review)
 *   v2.core.approval_request.approved   (human approved; execution pending)
 *   v2.core.approval_request.succeeded  (Stripe executed the action)
 *   v2.core.approval_request.rejected   (human rejected)
 *   v2.core.approval_request.canceled   (request withdrawn)
 *   v2.core.approval_request.expired    (request lapsed)
 *   v2.core.approval_request.failed     (approved but execution failed)
 *
 * On `succeeded` we retrieve the approval request and record the object Stripe
 * created (status_details.succeeded.result), checking it matches the proposed
 * action — e.g. a credit-note proposal must yield a `credit_note` (M8).
 *
 * We NEVER re-execute the action here — after approval Stripe runs it itself.
 * `approved` and `succeeded` are distinct events and both are recorded so the
 * audit trail shows the approval and its execution as separate transitions.
 *
 * The audit log is append-only: each event appends a fresh snapshot carrying
 * the accumulated event list and the (possibly updated) finalResult.
 */

/** Map an event type suffix to (status label, terminal finalResult | null). */
function classifyEvent(type: string): {
  status: string;
  finalResult: FinalResult | null;
} {
  if (type.endsWith('.created')) return { status: 'created', finalResult: null };
  if (type.endsWith('.approved')) return { status: 'approved', finalResult: null };
  if (type.endsWith('.succeeded')) return { status: 'succeeded', finalResult: 'executed' };
  if (type.endsWith('.rejected')) return { status: 'rejected', finalResult: 'rejected' };
  if (type.endsWith('.canceled')) return { status: 'canceled', finalResult: 'canceled' };
  if (type.endsWith('.expired')) return { status: 'expired', finalResult: 'expired' };
  if (type.endsWith('.failed')) return { status: 'failed', finalResult: 'failed' };
  return { status: type, finalResult: null };
}

function extractApprovalId(evt: any): string | undefined {
  return (
    evt?.related_object?.id ??
    evt?.data?.object?.id ??
    evt?.data?.id ??
    evt?.object?.id
  );
}

/** Object type Stripe should create when it executes each approved action. */
const EXPECTED_RESULT: Partial<Record<ActionType, string>> = {
  create_refund: 'refund',
  create_credit_note: 'credit_note',
  create_balance_transaction: 'customer_balance_transaction',
  cancel_subscription: 'subscription', // live action name: subscription.update
};

/** Read the executed object from an approval request (current + deprecated field). */
async function fetchResultObject(
  approvalId: string,
): Promise<AuditRecord['resultObject'] | undefined> {
  try {
    const resp = await retrieveApprovalRequest(approvalId);
    if (!resp.ok) {
      log.warn(`retrieve ${approvalId} failed HTTP ${resp.status}`, JSON.stringify(resp.body));
      return undefined;
    }
    const sd = resp.body?.status_details;
    const result = sd?.succeeded?.result ?? sd?.execution_succeeded?.result;
    return result?.id ? { id: result.id, object: result.object } : undefined;
  } catch (err) {
    log.warn(`retrieve ${approvalId} error`, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function handleEvent(evt: any): Promise<void> {
  const type: string = evt?.type ?? 'unknown';
  if (!type.startsWith('v2.core.approval_request.')) {
    log.info(`ignoring non-approval event: ${type}`);
    return;
  }
  const approvalId = extractApprovalId(evt);
  if (!approvalId) {
    log.warn(`event ${type} had no approval_request id; skipping`, JSON.stringify(evt));
    return;
  }
  const { status, finalResult } = classifyEvent(type);

  // `created` fires within the same second as the agent's request — usually
  // before propose has written its audit record (seen live 2026-10-24) — so
  // give the proposer a few seconds before giving up.
  let prior = findByApprovalId(approvalId);
  for (let i = 0; !prior && i < 3; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    prior = findByApprovalId(approvalId);
  }
  if (!prior) {
    log.warn(
      `no audit record for approval ${approvalId} (proposed in another run?). ` +
        `Recording nothing; run propose in the same logs/ context.`,
    );
    return;
  }

  const now = new Date().toISOString();
  const events = [...prior.events, { receivedAt: now, type, status }];
  const next: AuditRecord = {
    ...prior,
    events,
    finalResult: finalResult ?? prior.finalResult,
  };
  if (status === 'succeeded') {
    const result = await fetchResultObject(approvalId);
    if (result) {
      next.resultObject = result;
      const expected = EXPECTED_RESULT[prior.action];
      if (expected && result.object !== expected) {
        log.warn(
          `${prior.fixtureId} executed object is ${result.object}, expected ${expected} for ${prior.action}`,
        );
      }
    }
  }
  appendAudit(next);
  log.ok(
    `${prior.fixtureId} ${approvalId} → ${status}` +
      (finalResult ? ` (final: ${finalResult})` : ' (recorded)') +
      (next.resultObject ? ` result=${next.resultObject.object}:${next.resultObject.id}` : ''),
  );
}

function main(): void {
  const secret = config.webhookSecret; // fail fast if missing
  const port = config.webhookPort;

  const server = createServer(async (req, res) => {
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
      // Verify authenticity without depending on the SDK's typed event schema
      // (v2 thin events are not modelled the same as v1 events).
      Stripe.webhooks.signature.verifyHeader(raw.toString('utf8'), sig, secret);
    } catch (err) {
      log.error(
        'signature verification failed',
        err instanceof Error ? err.message : String(err),
      );
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
      await handleEvent(evt);
    } catch (err) {
      log.error('event handling error', err instanceof Error ? err.message : String(err));
    }
    // Always 200 once verified, so Stripe/CLI does not retry endlessly.
    res.writeHead(200).end('ok');
  });

  server.listen(port, () => {
    log.section('M4 webhook server');
    log.ok(`listening on http://localhost:${port}/webhook`);
    log.info('forward events with:  stripe listen --forward-to localhost:' + port + '/webhook');
    log.info('(the whsec printed by `stripe listen` goes in STRIPE_WEBHOOK_SECRET)');
  });
}

main();
