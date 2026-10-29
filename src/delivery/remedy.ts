import type { ActionPlan } from '../types.js';
import type { DeliveryRecord } from './delivery-log.js';

/**
 * M12-3 — how to make the buyer whole after a failed delivery.
 *
 *   card                                  → refund
 *   durable wallet, or refund dest. set   → refund
 *   ephemeral wallet and no refund dest.  → compensate instead of refunding
 *       customer has an open invoice      → credit note
 *       no invoice                        → customer balance credit
 *
 * A refund to an ephemeral wallet may never reach anyone, so it is only used
 * when the customer registered a durable refund destination.
 */

export type RemedyKind = 'refund' | 'credit_note' | 'balance';

export interface Remedy {
  kind: RemedyKind;
  why: string;
  invoiceId?: string;
}

export function decideRemedy(
  rec: DeliveryRecord,
  refundDestination: string | undefined,
  openInvoiceId: string | undefined,
): Remedy {
  if (rec.payer_wallet === 'card') return { kind: 'refund', why: 'カード払いのため元の支払い手段に返金できる' };
  if (rec.payer_wallet === 'durable') return { kind: 'refund', why: '支払い元が継続利用のウォレットのため返金が届く' };
  if (refundDestination) {
    return { kind: 'refund', why: `支払い元は ephemeral だが返金先が登録済み（${refundDestination}）` };
  }
  if (openInvoiceId) {
    return {
      kind: 'credit_note',
      why: `支払い元が ephemeral で返金先の登録がなく返金が届かない恐れ。未払いの請求書 ${openInvoiceId} があるため減額で補償`,
      invoiceId: openInvoiceId,
    };
  }
  return {
    kind: 'balance',
    why: '支払い元が ephemeral で返金先の登録がなく返金が届かない恐れ。請求書がないため顧客残高の付与で補償',
  };
}

const OUTCOME_LABEL: Record<DeliveryRecord['outcome'], string> = {
  delivered: '納品済み',
  empty: '空の応答',
  server_error: 'サーバーエラー',
  timeout: '応答なし（タイムアウト）',
};
const REMEDY_LABEL: Record<RemedyKind, string> = {
  refund: '返金',
  credit_note: 'クレジットノート',
  balance: '顧客残高の付与',
};

/** Max reason length accepted by the MCP update tool (and kept for the API). */
export const REASON_MAX = 1000;

export function deliveryJustification(
  rec: DeliveryRecord,
  remedy: Remedy,
  refundDestination: string | undefined,
  targetId: string,
): string {
  const lines = [
    '【AIバックオフィス 起案理由（納品失敗）】',
    `起案根拠: ${rec.purchase_id} 納品失敗`,
    `対象顧客: ${rec.customer_id}`,
    `支払い: ${rec.payment_intent_id}（¥${rec.amount.toLocaleString('ja-JP')}、${rec.payment_rail}）`,
    `購入対象: ${rec.request_url}`,
    `応答: ${rec.http_status === null ? 'なし' : `HTTP ${rec.http_status}`}`,
    `判定: ${rec.outcome}（${OUTCOME_LABEL[rec.outcome]}）`,
    `支払い日時: ${rec.paid_at} / 応答日時: ${rec.responded_at ?? '—'}`,
    `支払い元: ${rec.payer_wallet} / 返金先登録: ${refundDestination ? 'あり' : 'なし'}`,
    `補償手段: ${REMEDY_LABEL[remedy.kind]} — ${remedy.why}`,
    `対象オブジェクト: ${targetId}`,
    '起案者: ai-backoffice-agent (agent-tagged key / test mode)',
  ];
  const text = lines.join('\n');
  return text.length <= REASON_MAX ? text : text.slice(0, REASON_MAX - 1) + '…';
}

/** Turn a failed delivery + chosen remedy into an ActionPlan for proposePlan. */
export function remedyPlan(
  rec: DeliveryRecord,
  remedy: Remedy,
  chargeId: string,
): ActionPlan {
  const rationale = {
    customerId: rec.customer_id,
    reasonCode: `delivery_failed:${rec.outcome}`,
    summary: `${rec.purchase_id} の納品失敗（${OUTCOME_LABEL[rec.outcome]}）の補償: ${REMEDY_LABEL[remedy.kind]}`,
  };
  switch (remedy.kind) {
    case 'refund':
      return {
        action: 'create_refund',
        targetId: chargeId,
        amount: rec.amount,
        currency: rec.currency,
        rationale,
        params: { paymentIntentId: rec.payment_intent_id },
        expectedGated: true,
      };
    case 'credit_note':
      return {
        action: 'create_credit_note',
        targetId: remedy.invoiceId!,
        amount: rec.amount,
        currency: rec.currency,
        rationale,
        params: { reason: 'order_change', description: `納品失敗の補償（${rec.purchase_id}）` },
        expectedGated: true,
      };
    case 'balance':
      return {
        action: 'create_balance_transaction',
        targetId: rec.customer_id,
        amount: rec.amount,
        currency: rec.currency,
        rationale,
        params: { description: `納品失敗の補償（${rec.purchase_id}、次回請求から差し引き）` },
        expectedGated: true,
      };
  }
}
