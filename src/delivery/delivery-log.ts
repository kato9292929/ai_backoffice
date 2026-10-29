import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Delivery records (M12-2): one JSONL line per paid API call, saying whether
 * the buyer actually received what it paid for. The shape is payment-rail
 * neutral so the sandbox card PaymentIntents can later be swapped for x402
 * PaymentIntents (transaction_verification) without changing the fields the
 * refund decision reads.
 */

export const DELIVERY_LOG_PATH = 'logs/delivery.jsonl';

export type DeliveryOutcome = 'delivered' | 'empty' | 'server_error' | 'timeout';

/** Where the payment came from (M12-3). In sandbox this is declared per
 * purchase; with x402 it is derived from the paying wallet. */
export type PayerWallet = 'durable' | 'ephemeral' | 'card';

export interface DeliveryRecord {
  purchase_id: string;
  payment_intent_id: string;
  customer_id: string;
  amount: number;
  currency: string;
  /** `card_sandbox` today; `x402` once the payment side is swapped. */
  payment_rail: 'card_sandbox' | 'x402';
  payer_wallet: PayerWallet;
  request_url: string;
  /** null when the seller never answered (timeout). */
  http_status: number | null;
  outcome: DeliveryOutcome;
  paid_at: string;
  responded_at: string | null;
}

export function classifyDelivery(status: number | null, body: string): DeliveryOutcome {
  if (status === null) return 'timeout';
  if (status >= 500) return 'server_error';
  const t = body.trim();
  if (status === 200 && t !== '' && t !== '{}' && t !== '[]' && t !== 'null') return 'delivered';
  if (status === 200) return 'empty';
  return 'server_error'; // any other non-2xx counts as not delivered
}

export function appendDelivery(rec: DeliveryRecord, path = DELIVERY_LOG_PATH): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
}

export function readDeliveries(path = DELIVERY_LOG_PATH): DeliveryRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as DeliveryRecord);
}
