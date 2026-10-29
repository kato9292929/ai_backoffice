import { log } from '../logger.js';
import { chargeByHandle, customerId, loadSeedManifest } from '../manifest.js';
import { newRunId } from '../request-log.js';
import { makeSdk } from '../stripe-client.js';
import { proposePlan, type ProposeOutcome } from '../agent/propose.js';
import { appendDelivery, classifyDelivery, type DeliveryRecord, type PayerWallet } from './delivery-log.js';
import { decideRemedy, deliveryJustification, remedyPlan, type Remedy } from './remedy.js';
import { startSellerMock } from './seller-mock.js';

/**
 * M12-2 / M12-3 — mock seller up → buy → record delivery → judge → propose.
 *
 *   npm run demo:delivery     5 purchases, one per mock behaviour; every
 *                             failure resolves to a refund (card / durable /
 *                             ephemeral with a registered refund destination)
 *   (either accepts --only=COMP-BAL,… to re-run selected purchases)
 *   npm run demo:compensate   2 purchases from ephemeral wallets with no refund
 *                             destination → credit note (customer has an open
 *                             invoice) / customer balance (no invoice)
 *
 * The purchases are paid with seeded sandbox card charges (one PaymentIntent
 * each — only one approval can be pending per PaymentIntent). `payer_wallet`
 * is declared per purchase here; with x402 it would come from the payer.
 */

interface Purchase {
  id: string;
  set: 'delivery' | 'compensate';
  charge: string;
  path: string;
  payerWallet: PayerWallet;
}

const PURCHASES: Purchase[] = [
  { id: 'DELIVERY-OK', set: 'delivery', charge: 'purchase-ok', path: '/v1/data/fx-rates', payerWallet: 'card' },
  { id: 'DELIVERY-EMPTY', set: 'delivery', charge: 'purchase-empty', path: '/v1/data/market-depth', payerWallet: 'card' },
  { id: 'DELIVERY-500', set: 'delivery', charge: 'purchase-500', path: '/v1/data/news-sentiment', payerWallet: 'durable' },
  { id: 'DELIVERY-503', set: 'delivery', charge: 'purchase-503', path: '/v1/data/weather-hourly', payerWallet: 'ephemeral' },
  { id: 'DELIVERY-TIMEOUT', set: 'delivery', charge: 'purchase-timeout', path: '/v1/data/shipping-eta', payerWallet: 'card' },
  { id: 'COMP-CN', set: 'compensate', charge: 'purchase-cn', path: '/v1/data/credit-score', payerWallet: 'ephemeral' },
  { id: 'COMP-BAL', set: 'compensate', charge: 'purchase-bal', path: '/v1/data/geo-ip', payerWallet: 'ephemeral' },
];

const TIMEOUT_MS = 2000;

async function callSeller(url: string): Promise<{ status: number | null; body: string; respondedAt: string | null }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const body = await res.text();
    return { status: res.status, body, respondedAt: new Date().toISOString() };
  } catch {
    return { status: null, body: '', respondedAt: null };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const set = process.argv.includes('--set=compensate') ? 'compensate' : 'delivery';
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');
  const purchases = PURCHASES.filter((p) => p.set === set && (!only || only.includes(p.id)));
  const manifest = loadSeedManifest();
  const stripe = makeSdk();
  const runId = newRunId(set);
  const seller = await startSellerMock();
  log.section(`M12 ${set} — 売り手モック ${seller.baseUrl} (run ${runId})`);

  const rows: Array<{ id: string; outcome: string; remedy: string; result: string }> = [];
  try {
    for (const p of purchases) {
      log.section(p.id);
      const ch = chargeByHandle(manifest, p.charge);
      const customer = customerId(manifest, ch.customerHandle);
      const pi = await stripe.paymentIntents.retrieve(ch.paymentIntentId);
      const charge = await stripe.charges.retrieve(ch.chargeId);
      if (charge.amount_refunded > 0) {
        log.warn(`${p.id} charge ${ch.chargeId} は返金済み — \`npm run seed\` で補充してから流す`);
        rows.push({ id: p.id, outcome: '-', remedy: '-', result: 'skipped (refunded)' });
        continue;
      }

      // Purchase = the seeded payment; now call the paid endpoint and record.
      const url = `${seller.baseUrl}${p.path}`;
      const r = await callSeller(url);
      const rec: DeliveryRecord = {
        purchase_id: p.id,
        payment_intent_id: ch.paymentIntentId,
        customer_id: customer.id,
        amount: ch.amount,
        currency: ch.currency,
        payment_rail: 'card_sandbox',
        payer_wallet: p.payerWallet,
        // Recorded as the public-looking path, not the ephemeral local port.
        request_url: `https://seller.example${p.path}`,
        http_status: r.status,
        outcome: classifyDelivery(r.status, r.body),
        paid_at: new Date(pi.created * 1000).toISOString(),
        responded_at: r.respondedAt,
      };
      appendDelivery(rec);
      log.info(`納品記録: HTTP ${rec.http_status ?? 'なし'} → ${rec.outcome} (payer_wallet=${rec.payer_wallet})`);

      if (rec.outcome === 'delivered') {
        log.ok(`${p.id} 納品済み — 起案しない`);
        rows.push({ id: p.id, outcome: rec.outcome, remedy: '-', result: 'not proposed' });
        continue;
      }

      // Inputs for the remedy branch.
      const cust = (await stripe.customers.retrieve(customer.id)) as { metadata?: Record<string, string> };
      const dest = cust.metadata?.refund_destination || undefined;
      const invoices = await stripe.invoices.list({ customer: customer.id, status: 'open', limit: 10 });
      const openInvoice = invoices.data.find((i) => i.amount_remaining >= rec.amount);
      const remedy: Remedy = decideRemedy(rec, dest, openInvoice?.id);
      log.info(`判定: 納品失敗 → ${remedy.kind}（${remedy.why}）`);

      const plan = remedyPlan(rec, remedy, ch.chargeId);
      const justification = deliveryJustification(rec, remedy, dest, plan.targetId);
      const o: ProposeOutcome = await proposePlan(p.id, plan, justification, { runId, route: 'cli' });
      rows.push({ id: p.id, outcome: rec.outcome, remedy: remedy.kind, result: `${o.status}${o.approvalRequestId ? ' ' + o.approvalRequestId : ''}` });
    }
  } finally {
    await seller.close();
  }

  log.section(`M12 ${set} サマリ`);
  console.log(['purchase', 'delivery', 'remedy', 'result'].join('\t'));
  for (const r of rows) console.log([r.id, r.outcome, r.remedy, r.result].join('\t'));
}

main().catch((err) => {
  log.error(`M12 failed`, err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
