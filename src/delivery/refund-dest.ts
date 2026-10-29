import { log } from '../logger.js';
import { customerId, loadSeedManifest } from '../manifest.js';
import { makeSdk } from '../stripe-client.js';

/**
 * Register (or clear) a customer's refund destination (M12-3), stored as
 * Customer metadata `refund_destination`. A registered destination lets a
 * failed delivery paid from an ephemeral wallet be refunded instead of
 * compensated. Uses the secret key: this is customer data maintenance, not a
 * money-moving action.
 *
 *   npm run refund-dest -- --customer=hayashi --value=wallet:0xABC…
 *   npm run refund-dest -- --customer=cus_123 --value=      (clears it)
 */

function arg(name: string): string | undefined {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const who = arg('customer');
  const value = arg('value');
  if (!who || value === undefined) {
    throw new Error('usage: npm run refund-dest -- --customer=<handle|cus_id> --value=<destination or empty to clear>');
  }
  const id = who.startsWith('cus_') ? who : customerId(loadSeedManifest(), who).id;
  const stripe = makeSdk();
  // Stripe deletes a metadata key when it is set to an empty string.
  await stripe.customers.update(id, { metadata: { refund_destination: value } });
  log.ok(value ? `${id} refund_destination = ${value}` : `${id} refund_destination cleared`);
}

main().catch((err) => {
  log.error('refund-dest failed', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
