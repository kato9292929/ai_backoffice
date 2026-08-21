import { makeSdk } from './stripe-client.js';
import { loadSeedManifest, chargeForCustomer, subscriptionForCustomer } from './manifest.js';
import { loadInquiries } from './agent/propose.js';
import { plan } from './agent/planner.js';
import { log } from './logger.js';

/**
 * Report, per inquiry fixture, whether its target is still "unconsumed" —
 * i.e. whether a fresh through-run can be executed against it.
 *
 *  - create_refund       : consumed once the charge is (fully) refunded
 *  - cancel_subscription : consumed once the subscription is canceled
 *  - create_invoice      : always re-runnable (each run creates a new invoice)
 *  - update_customer_...  : always re-runnable (idempotent metadata write)
 *
 * Read-only: uses the standard secret key to retrieve objects. Never mutates.
 */

type Consumption = { state: 'ready' | 'consumed' | 'unknown'; detail: string };

async function main(): Promise<void> {
  const stripe = makeSdk(); // read-only retrieves
  const manifest = loadSeedManifest();
  const inquiries = loadInquiries();

  log.section('fixture consumption status');
  const rows: Array<{ id: string; action: string; target: string; c: Consumption }> = [];

  for (const inq of inquiries) {
    const p = plan(inq, manifest);
    let c: Consumption = { state: 'ready', detail: '' };

    try {
      if (p.action === 'create_refund') {
        const ch = chargeForCustomer(manifest, inq.customerRef);
        const charge = await stripe.charges.retrieve(ch.chargeId);
        const refunded = charge.refunded || charge.amount_refunded >= charge.amount;
        c = refunded
          ? { state: 'consumed', detail: `refunded ¥${charge.amount_refunded.toLocaleString('ja-JP')}` }
          : { state: 'ready', detail: `refundable ¥${charge.amount.toLocaleString('ja-JP')}` };
      } else if (p.action === 'cancel_subscription') {
        const sub = subscriptionForCustomer(manifest, inq.customerRef);
        const s = await stripe.subscriptions.retrieve(sub.id);
        c =
          s.status === 'canceled'
            ? { state: 'consumed', detail: 'subscription canceled' }
            : { state: 'ready', detail: `status ${s.status}` };
      } else if (p.action === 'create_invoice') {
        c = { state: 'ready', detail: 're-runnable (creates a new invoice)' };
      } else {
        c = { state: 'ready', detail: 're-runnable (idempotent metadata)' };
      }
    } catch (err) {
      c = { state: 'unknown', detail: err instanceof Error ? err.message : String(err) };
    }

    rows.push({ id: inq.id, action: p.action, target: p.targetId, c });
  }

  console.log('');
  console.log(['fixture', 'action', 'state', 'detail'].join('\t'));
  console.log('─'.repeat(80));
  for (const r of rows) {
    console.log([r.id, r.action, r.c.state, r.c.detail].join('\t'));
  }
  console.log('');

  const ready = rows.filter((r) => r.c.state === 'ready').map((r) => r.id);
  const consumed = rows.filter((r) => r.c.state === 'consumed').map((r) => r.id);
  log.info(`未消費 (ready): ${ready.join(', ') || 'none'}`);
  if (consumed.length) log.warn(`消費済み (consumed): ${consumed.join(', ')} — re-seed to replenish`);
}

main().catch((err) => {
  log.error('status failed', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
