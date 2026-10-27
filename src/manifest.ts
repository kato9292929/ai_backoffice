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
/** A finalized (open) invoice a credit note can be issued against (M8). */
export interface InvoiceSeed {
  handle: string;
  id: string;
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
  /** Absent in manifests written before M8 — re-run `npm run seed`. */
  invoices?: InvoiceSeed[];
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

/** Charge reserved for the runaway / route-comparison scenarios (M9/M10):
 * many small partial refunds are drawn from it, so fixtures stay untouched. */
export const POOL_CHARGE_HANDLE = 'runaway-pool';

/** One charge per M10 route: only one approval request may be pending per
 * PaymentIntent, so the two routes must not share a target. */
export const ROUTE_CHARGE_HANDLES = { cli: 'route-cli', mcp: 'route-mcp' } as const;

/** First refundable fixture charge for a customer handle (pool excluded). */
export function chargeForCustomer(
  m: SeedManifest,
  customerHandle: string,
): ChargeSeed {
  const ch = m.charges.find(
    (x) =>
      x.customerHandle === customerHandle &&
      x.handle !== POOL_CHARGE_HANDLE &&
      !Object.values(ROUTE_CHARGE_HANDLES).includes(x.handle as 'route-cli'),
  );
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

/** Charge by seed handle. */
export function chargeByHandle(m: SeedManifest, handle: string): ChargeSeed {
  const ch = m.charges.find((x) => x.handle === handle);
  if (!ch)
    throw new Error(`no seeded charge "${handle}" — re-run \`npm run seed\` (M8+)`);
  return ch;
}

/** Open invoice for a customer handle (credit note target). */
export function invoiceForCustomer(
  m: SeedManifest,
  customerHandle: string,
): InvoiceSeed {
  const inv = m.invoices?.find((x) => x.customerHandle === customerHandle);
  if (!inv)
    throw new Error(
      `no seeded invoice for customer handle "${customerHandle}" — re-run \`npm run seed\` (M8+)`,
    );
  return inv;
}
