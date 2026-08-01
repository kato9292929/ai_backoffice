import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type Stripe from 'stripe';
import { makeSdk } from './stripe-client.js';
import { log } from './logger.js';
import { SEED_PATH, loadSeedManifest, type SeedManifest } from './manifest.js';

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
const CHARGES = [
  { handle: 'tanaka-dup', customerHandle: 'tanaka', amount: 3300, note: '二重課金の重複分（INQ-001の返金対象）' },
  { handle: 'yamada-annual', customerHandle: 'yamada', amount: 80000, note: '年間前払い（INQ-002の高額返金対象）' },
  { handle: 'suzuki-month', customerHandle: 'suzuki', amount: 5000, note: '月額分（INQ-003の疑わしい返金対象）' },
] as const;

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
    const piOk =
      !!existing &&
      (await stillExists(async () => {
        const pi = await stripe.paymentIntents.retrieve(existing.paymentIntentId);
        return pi.status === 'succeeded' ? pi : null;
      }));
    if (piOk && existing) {
      manifest.charges.push(existing);
      log.info(`charge reused ${ch.handle} → ${existing.chargeId}`);
      continue;
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

  saveManifest(manifest);
  log.section('seed complete');
  log.ok(`manifest written → ${SEED_PATH}`);
  log.info(
    `customers=${manifest.customers.length} prices=${manifest.prices.length} ` +
      `subscriptions=${manifest.subscriptions.length} charges=${manifest.charges.length}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSeed().catch((err) => {
    log.error('seed failed', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
