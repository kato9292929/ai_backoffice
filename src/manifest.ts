import { existsSync, readFileSync } from 'node:fs';

/** Types describing fixtures/seeded.json (written by seed.ts). */
export interface CustomerSeed {
  handle: string;
  id: string;
  name: string;
  email: string;
}
export interface PriceSeed {
  handle: string;
  productId: string;
  priceId: string;
  lookupKey: string;
  unitAmount: number;
}
export interface SubscriptionSeed {
  handle: string;
  id: string;
  customerHandle: string;
  priceHandle: string;
}
export interface ChargeSeed {
  handle: string;
  paymentIntentId: string;
  chargeId: string;
  customerHandle: string;
  amount: number;
  currency: string;
  note: string;
}
export interface SeedManifest {
  createdAt: string;
  livemode: false;
  customers: CustomerSeed[];
  prices: PriceSeed[];
  subscriptions: SubscriptionSeed[];
  charges: ChargeSeed[];
}

export const SEED_PATH = 'fixtures/seeded.json';

export function loadSeedManifest(path: string = SEED_PATH): SeedManifest {
  if (!existsSync(path)) {
    throw new Error(
      `Seed manifest not found at ${path}. Run \`npm run seed\` first (M1).`,
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as SeedManifest;
}

/** Resolve a customer handle to its live id. */
export function customerId(m: SeedManifest, handle: string): CustomerSeed {
  const c = m.customers.find((x) => x.handle === handle);
  if (!c) throw new Error(`no seeded customer for handle "${handle}"`);
  return c;
}

/** First refundable charge for a customer handle. */
export function chargeForCustomer(
  m: SeedManifest,
  customerHandle: string,
): ChargeSeed {
  const ch = m.charges.find((x) => x.customerHandle === customerHandle);
  if (!ch)
    throw new Error(`no seeded charge for customer handle "${customerHandle}"`);
  return ch;
}

/** Active subscription for a customer handle. */
export function subscriptionForCustomer(
  m: SeedManifest,
  customerHandle: string,
): SubscriptionSeed {
  const s = m.subscriptions.find((x) => x.customerHandle === customerHandle);
  if (!s)
    throw new Error(
      `no seeded subscription for customer handle "${customerHandle}"`,
    );
  return s;
}
