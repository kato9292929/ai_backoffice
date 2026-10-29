import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type Stripe from 'stripe';
import { makeSdk } from './stripe-client.js';
import { log } from './logger.js';
import {
  POOL_CHARGE_HANDLE,
  SEED_PATH,
  loadSeedManifest,
  type SeedManifest,
} from './manifest.js';

/**
 * M1 — seed the minimum test-mode data the demo needs, reproducibly.
 *
 * Idempotency strategy: a local manifest (fixtures/seeded.json) records every
 * created object id. On re-run we retrieve each stored id; if it still exists we
 * reuse it, otherwise we recreate. This makes `npm run seed` idempotent across
 * runs without depending on the Search API's eventual consistency. Every object
 * is also tagged metadata.demo_seed=ai_backoffice / metadata.demo_handle=<h>.
 */

const SEED_TAG = 'ai_backoffice';

function loadManifest(): SeedManifest | null {
  if (!existsSync(SEED_PATH)) return null;
  try {
    return loadSeedManifest(SEED_PATH);
  } catch {
    return null;
  }
}

function saveManifest(m: SeedManifest): void {
  const dir = dirname(SEED_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SEED_PATH, JSON.stringify(m, null, 2) + '\n', 'utf8');
}

/** Retrieve by stored id; return true if it still exists and is not deleted. */
async function stillExists(
  retrieve: () => Promise<unknown>,
): Promise<boolean> {
  try {
    const obj = (await retrieve()) as { deleted?: boolean } | null;
    return !!obj && obj.deleted !== true;
  } catch {
    return false;
  }
}

// --- Definitions (single source of truth for what the demo needs) -----------

const CUSTOMERS = [
  { handle: 'tanaka', name: '田中 太郎', email: 'tanaka@example.jp', dept: '営業部', region: '東京' },
  { handle: 'yamada', name: '山田 花子', email: 'yamada@example.jp', dept: '営業部', region: '大阪' },
  { handle: 'suzuki', name: '鈴木 一郎', email: 'suzuki@example.jp', dept: '管理部', region: '福岡' },
  { handle: 'sato', name: '佐藤 美咲', email: 'sato@example.jp', dept: '技術部', region: '北海道' },
  // M12: buyers of the mock paid-data API. kimura pays by card/durable wallet,
  // hayashi from an ephemeral wallet but with a registered refund destination,
  // mori from an ephemeral wallet with no destination and no invoices.
  { handle: 'kimura', name: '木村 健', email: 'kimura@example.jp', dept: '開発部', region: '東京' },
  { handle: 'hayashi', name: '林 葵', email: 'hayashi@example.jp', dept: '開発部', region: '大阪' },
  { handle: 'mori', name: '森 翔', email: 'mori@example.jp', dept: '開発部', region: '名古屋' },
] as const;

const PRICES = [
  { handle: 'basic', product: 'ベーシックプラン', lookupKey: 'demo_basic_monthly', unitAmount: 1000 },
  { handle: 'pro', product: 'プロプラン', lookupKey: 'demo_pro_monthly', unitAmount: 5000 },
] as const;

// Active subscriptions (multiple).
const SUBSCRIPTIONS = [
  { handle: 'tanaka-basic', customerHandle: 'tanaka', priceHandle: 'basic' },
  { handle: 'yamada-pro', customerHandle: 'yamada', priceHandle: 'pro' },
  { handle: 'suzuki-basic', customerHandle: 'suzuki', priceHandle: 'basic' },
] as const;

// Paid, refundable charges (amounts aligned with the inquiry fixtures).
// `minRemaining`: the charge is reused only while at least this much is still
// unrefunded. Fixture charges need their full amount (any refund consumes
// them); the pool serves many small partial refunds (M9 runaway / M10 route
// comparison) and is replenished once it runs low.
const CHARGES = [
  { handle: 'tanaka-dup', customerHandle: 'tanaka', amount: 3300, minRemaining: 3300, note: '二重課金の重複分（INQ-001の返金対象）' },
  { handle: 'yamada-annual', customerHandle: 'yamada', amount: 80000, minRemaining: 80000, note: '年間前払い（INQ-002の高額返金対象）' },
  { handle: 'suzuki-month', customerHandle: 'suzuki', amount: 5000, minRemaining: 5000, note: '月額分（INQ-003の疑わしい返金対象）' },
  { handle: POOL_CHARGE_HANDLE, customerHandle: 'suzuki', amount: 20000, minRemaining: 7500, note: '少額返金の連発用プール（M9 暴走シナリオ）' },
  // M10: one charge per route (only one pending approval request per PaymentIntent).
  { handle: 'route-cli', customerHandle: 'yamada', amount: 5000, minRemaining: 5000, note: 'M10 経路比較（CLI 経路の返金対象）' },
  { handle: 'route-mcp', customerHandle: 'yamada', amount: 5000, minRemaining: 5000, note: 'M10 経路比較（MCP 経路の返金対象）' },
  // M12-1: refunded directly by the secret key while the agent's refund waits
  // for approval, so the approved refund fails on execution.
  { handle: 'failed-probe', customerHandle: 'kimura', amount: 2000, minRemaining: 2000, note: 'M12-1 failed 再現用' },
  // M12-2 / M12-3: one purchase of the mock paid-data API per charge.
  { handle: 'purchase-ok', customerHandle: 'kimura', amount: 500, minRemaining: 500, note: 'M12 購入: 正常納品' },
  { handle: 'purchase-empty', customerHandle: 'kimura', amount: 800, minRemaining: 800, note: 'M12 購入: 空の応答' },
  { handle: 'purchase-500', customerHandle: 'kimura', amount: 1000, minRemaining: 1000, note: 'M12 購入: 500' },
  { handle: 'purchase-503', customerHandle: 'hayashi', amount: 1200, minRemaining: 1200, note: 'M12 購入: 503' },
  { handle: 'purchase-timeout', customerHandle: 'kimura', amount: 1500, minRemaining: 1500, note: 'M12 購入: タイムアウト' },
  { handle: 'purchase-cn', customerHandle: 'sato', amount: 900, minRemaining: 900, note: 'M12-3 購入: ephemeral・請求書あり' },
  { handle: 'purchase-bal', customerHandle: 'mori', amount: 700, minRemaining: 700, note: 'M12-3 購入: ephemeral・請求書なし' },
] as const;

// Finalized (open) invoices a credit note is issued against (M8, INQ-004).
// Credit notes need an existing finalized invoice; the agent never creates the
// invoice itself (invoice creation is not an Approvals-supported action).
const INVOICES = [
  {
    handle: 'sato-onsite',
    customerHandle: 'sato',
    amount: 30000,
    description: '初期設定 追加サポート（オンサイト対応2日分）',
    note: 'オンサイト2日分の請求（INQ-004のクレジットノート対象）',
  },
] as const;

/** Credit note amount INQ-004 asks for; an invoice with less remaining is
 * treated as consumed and replenished. */
const CREDIT_NOTE_MIN_REMAINING = 15000;

const CURRENCY = 'jpy';

export async function runSeed(): Promise<void> {
  log.section('M1 seed — test-mode data');
  const stripe = makeSdk(); // ordinary test key
  const prev = loadManifest();

  const manifest: SeedManifest = {
    createdAt: new Date().toISOString(),
    livemode: false,
    customers: [],
    prices: [],
    subscriptions: [],
    charges: [],
    invoices: [],
  };

  // 1) Customers -------------------------------------------------------------
  for (const c of CUSTOMERS) {
    const existing = prev?.customers.find((x) => x.handle === c.handle);
    if (existing && (await stillExists(() => stripe.customers.retrieve(existing.id)))) {
      // Keep metadata current (e.g. dept) but reuse the id.
      await stripe.customers.update(existing.id, {
        metadata: { demo_seed: SEED_TAG, demo_handle: c.handle, dept: c.dept, region: c.region },
      });
      manifest.customers.push({ handle: c.handle, id: existing.id, name: c.name, email: c.email });
      log.info(`customer reused ${c.handle} → ${existing.id}`);
      continue;
    }
    const created = await stripe.customers.create({
      name: c.name,
      email: c.email,
      description: `デモ顧客（${c.handle}）`,
      metadata: { demo_seed: SEED_TAG, demo_handle: c.handle, dept: c.dept, region: c.region },
    });
    manifest.customers.push({ handle: c.handle, id: created.id, name: c.name, email: c.email });
    log.ok(`customer created ${c.handle} → ${created.id}`);
  }

  const customerId = (handle: string): string => {
    const found = manifest.customers.find((x) => x.handle === handle);
    if (!found) throw new Error(`no seeded customer for handle ${handle}`);
    return found.id;
  };

  // 2) Products + recurring prices ------------------------------------------
  for (const p of PRICES) {
    const existing = prev?.prices.find((x) => x.handle === p.handle);
    // Prices are immutable; a lookup_key makes them addressable & idempotent.
    let priceId = existing?.priceId;
    let productId = existing?.productId;
    const priceOk =
      !!priceId && (await stillExists(() => stripe.prices.retrieve(priceId!)));
    if (!priceOk) {
      const product = await stripe.products.create({
        name: p.product,
        metadata: { demo_seed: SEED_TAG, demo_handle: p.handle },
      });
      productId = product.id;
      const price = await stripe.prices.create({
        product: product.id,
        currency: CURRENCY,
        unit_amount: p.unitAmount,
        recurring: { interval: 'month' },
        lookup_key: p.lookupKey,
        transfer_lookup_key: true,
        metadata: { demo_seed: SEED_TAG, demo_handle: p.handle },
      });
      priceId = price.id;
      log.ok(`price created ${p.handle} → ${priceId} (¥${p.unitAmount}/mo)`);
    } else {
      log.info(`price reused ${p.handle} → ${priceId}`);
    }
    manifest.prices.push({
      handle: p.handle,
      productId: productId!,
      priceId: priceId!,
      lookupKey: p.lookupKey,
      unitAmount: p.unitAmount,
    });
  }

  const priceId = (handle: string): string => {
    const found = manifest.prices.find((x) => x.handle === handle);
    if (!found) throw new Error(`no seeded price for handle ${handle}`);
    return found.priceId;
  };

  // Attach a default test payment method to each customer that needs one.
  async function ensureDefaultPaymentMethod(custId: string): Promise<void> {
    const cust = (await stripe.customers.retrieve(custId)) as Stripe.Customer;
    if (cust.invoice_settings?.default_payment_method) return;
    // pm_card_visa is Stripe's canonical test payment method.
    const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: custId });
    await stripe.customers.update(custId, {
      invoice_settings: { default_payment_method: pm.id },
    });
  }

  // 3) Active subscriptions --------------------------------------------------
  for (const s of SUBSCRIPTIONS) {
    const existing = prev?.subscriptions.find((x) => x.handle === s.handle);
    const subOk =
      !!existing &&
      (await stillExists(async () => {
        const sub = await stripe.subscriptions.retrieve(existing.id);
        return sub.status === 'active' || sub.status === 'trialing' ? sub : null;
      }));
    if (subOk && existing) {
      manifest.subscriptions.push({
        handle: s.handle,
        id: existing.id,
        customerHandle: s.customerHandle,
        priceHandle: s.priceHandle,
      });
      log.info(`subscription reused ${s.handle} → ${existing.id}`);
      continue;
    }
    const cust = customerId(s.customerHandle);
    await ensureDefaultPaymentMethod(cust);
    const sub = await stripe.subscriptions.create({
      customer: cust,
      items: [{ price: priceId(s.priceHandle) }],
      metadata: { demo_seed: SEED_TAG, demo_handle: s.handle },
    });
    manifest.subscriptions.push({
      handle: s.handle,
      id: sub.id,
      customerHandle: s.customerHandle,
      priceHandle: s.priceHandle,
    });
    log.ok(`subscription created ${s.handle} → ${sub.id} (${sub.status})`);
  }

  // 4) Paid, refundable charges (via confirmed PaymentIntents) ---------------
  for (const ch of CHARGES) {
    const existing = prev?.charges.find((x) => x.handle === ch.handle);
    // Reuse a seeded charge ONLY if it still exists AND has not been consumed
    // by a refund. A refunded charge keeps PaymentIntent.status === 'succeeded',
    // so we must also inspect the charge's refund state and replenish a fresh
    // one when the previous demo run already refunded it.
    const piOk =
      !!existing &&
      (await stillExists(async () => {
        const pi = await stripe.paymentIntents.retrieve(existing.paymentIntentId);
        if (pi.status !== 'succeeded') return null;
        const chId =
          typeof pi.latest_charge === 'string'
            ? pi.latest_charge
            : (pi.latest_charge?.id ?? existing.chargeId);
        if (!chId) return null;
        const charge = await stripe.charges.retrieve(chId);
        const remaining = charge.amount - charge.amount_refunded;
        const consumed = charge.refunded || remaining < ch.minRemaining;
        return consumed ? null : pi;
      }));
    if (piOk && existing) {
      manifest.charges.push(existing);
      log.info(`charge reused ${ch.handle} → ${existing.chargeId}`);
      continue;
    }
    if (existing) {
      log.info(`charge ${ch.handle} consumed/missing → replenishing a fresh charge`);
    }
    const pi = await stripe.paymentIntents.create({
      amount: ch.amount,
      currency: CURRENCY,
      customer: customerId(ch.customerHandle),
      payment_method: 'pm_card_visa',
      confirm: true,
      // Prevent redirect-based methods so this completes headlessly.
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      description: ch.note,
      metadata: { demo_seed: SEED_TAG, demo_handle: ch.handle },
    });
    const chargeId =
      typeof pi.latest_charge === 'string'
        ? pi.latest_charge
        : (pi.latest_charge?.id ?? '');
    manifest.charges.push({
      handle: ch.handle,
      paymentIntentId: pi.id,
      chargeId,
      customerHandle: ch.customerHandle,
      amount: ch.amount,
      currency: CURRENCY,
      note: ch.note,
    });
    log.ok(`charge created ${ch.handle} → pi=${pi.id} charge=${chargeId} (${pi.status})`);
  }

  // 5) Open invoices for credit notes (M8) ----------------------------------
  for (const iv of INVOICES) {
    const existing = prev?.invoices?.find((x) => x.handle === iv.handle);
    // Reuse only while the invoice is still open, has no credit notes yet and
    // enough left to credit — a previous demo run's credit note consumes it.
    const invOk =
      !!existing &&
      (await stillExists(async () => {
        const inv = await stripe.invoices.retrieve(existing.id);
        const credited =
          (inv.pre_payment_credit_notes_amount ?? 0) +
          (inv.post_payment_credit_notes_amount ?? 0);
        const usable =
          inv.status === 'open' &&
          credited === 0 &&
          inv.amount_remaining >= CREDIT_NOTE_MIN_REMAINING;
        return usable ? inv : null;
      }));
    if (invOk && existing) {
      manifest.invoices!.push(existing);
      log.info(`invoice reused ${iv.handle} → ${existing.id}`);
      continue;
    }
    if (existing) {
      log.info(`invoice ${iv.handle} consumed/missing → creating a fresh one`);
    }
    const cust = customerId(iv.customerHandle);
    const draft = await stripe.invoices.create({
      customer: cust,
      collection_method: 'send_invoice',
      days_until_due: 7,
      pending_invoice_items_behavior: 'exclude',
      description: iv.note,
      metadata: { demo_seed: SEED_TAG, demo_handle: iv.handle },
    });
    await stripe.invoiceItems.create({
      customer: cust,
      invoice: draft.id,
      amount: iv.amount,
      currency: CURRENCY,
      description: iv.description,
      metadata: { demo_seed: SEED_TAG, demo_handle: iv.handle },
    });
    // Finalize so a credit note can be issued (draft invoices cannot be credited).
    const inv = await stripe.invoices.finalizeInvoice(draft.id, { auto_advance: false });
    manifest.invoices!.push({
      handle: iv.handle,
      id: inv.id,
      customerHandle: iv.customerHandle,
      amount: iv.amount,
      currency: CURRENCY,
      note: iv.note,
    });
    log.ok(`invoice created ${iv.handle} → ${inv.id} (${inv.status}, ¥${inv.amount_due})`);
  }

  saveManifest(manifest);
  log.section('seed complete');
  log.ok(`manifest written → ${SEED_PATH}`);
  log.info(
    `customers=${manifest.customers.length} prices=${manifest.prices.length} ` +
      `subscriptions=${manifest.subscriptions.length} charges=${manifest.charges.length} ` +
      `invoices=${manifest.invoices!.length}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSeed().catch((err) => {
    log.error('seed failed', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
