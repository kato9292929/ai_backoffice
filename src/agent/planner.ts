import type { ActionPlan, ActionType, Inquiry } from '../types.js';
import {
  chargeForCustomer,
  customerId,
  subscriptionForCustomer,
  type SeedManifest,
} from '../manifest.js';

/**
 * The "agent" decision layer (M3 step 2).
 *
 * This is a deterministic, keyword-driven planner rather than an LLM call: for
 * a reference demo, reproducibility beats cleverness, and the point being
 * demonstrated is the APPROVAL boundary, not natural-language understanding.
 * The classifier reads the Japanese inquiry, picks one action, resolves the
 * target object from the seed manifest, and extracts the amount from the text.
 *
 * Swapping this for a real LLM planner is a drop-in change: produce the same
 * ActionPlan shape and the rest of the pipeline is unaffected.
 */

/** Extract the first "12,345円" style amount from Japanese text. */
export function extractYen(text: string): number | undefined {
  const m = text.match(/([0-9０-９][0-9０-９,，]*)\s*円/);
  if (!m) return undefined;
  const normalized = m[1]!
    .replace(/[０-９]/g, (d) => String('０１２３４５６７８９'.indexOf(d)))
    .replace(/[,，]/g, '');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Classify the action. Order matters: "解約" (cancel) is checked before "返金"
 * (refund) because a cancellation inquiry often mentions "日割り返金は不要"
 * (no pro-rated refund needed), which must NOT be read as a refund request.
 */
export function classifyAction(text: string): ActionType {
  if (/(解約|契約.*(止め|停止)|次回以降の請求を止め)/.test(text)) {
    return 'cancel_subscription';
  }
  if (/(請求書|インボイス|発行してください)/.test(text)) {
    return 'create_invoice';
  }
  if (/(メタデータ|部署|表記|登録.*変更)/.test(text) && !/返金|請求書/.test(text)) {
    return 'update_customer_metadata';
  }
  if (/(返金|返して|戻して|リファンド|払い戻)/.test(text)) {
    return 'create_refund';
  }
  // Fallback: treat unknown as a metadata note so nothing money-moving fires
  // by accident.
  return 'update_customer_metadata';
}

/** Heuristic reason code for a refund, used in the justification. */
function refundReasonCode(text: string): { code: string; summary: string } {
  if (/(二重|重複|2回|２回|ダブ)/.test(text)) {
    return {
      code: 'duplicate_charge',
      summary: '同一課金の重複が申告されており、重複分の返金が妥当と判断。',
    };
  }
  if (/(覚えてない|覚えていない|なんとなく|たぶん|思ってたのと違|使ったか)/.test(text)) {
    return {
      code: 'weak_justification',
      summary:
        '利用実態が不明で返金理由が曖昧。承認者の判断を仰ぐべき低信頼の依頼。',
    };
  }
  return {
    code: 'customer_request',
    summary: '顧客都合による返金依頼。金額・対象を確認のうえ承認を要する。',
  };
}

/** Extract a new metadata value like 「事業開発部」に更新. */
function extractNewMetadataValue(text: string): string | undefined {
  const m = text.match(/「([^」]+)」に(?:更新|変更)/);
  return m?.[1];
}

export function plan(inquiry: Inquiry, manifest: SeedManifest): ActionPlan {
  const action = classifyAction(inquiry.text);
  const customer = customerId(manifest, inquiry.customerRef);
  const textAmount = extractYen(inquiry.text);

  switch (action) {
    case 'create_refund': {
      const charge = chargeForCustomer(manifest, inquiry.customerRef);
      const { code, summary } = refundReasonCode(inquiry.text);
      return {
        action,
        targetId: charge.chargeId || charge.paymentIntentId,
        amount: charge.amount, // full refund of the seeded charge
        currency: charge.currency,
        rationale: { customerId: customer.id, reasonCode: code, summary },
        params: { paymentIntentId: charge.paymentIntentId },
        expectedGated: true,
      };
    }
    case 'create_invoice': {
      const amount = textAmount ?? 30000;
      return {
        action,
        targetId: customer.id, // invoice is created for the customer
        amount,
        currency: 'jpy',
        rationale: {
          customerId: customer.id,
          reasonCode: 'agreed_service_fee',
          summary: '見積り合意済みの追加作業費用の請求書発行。',
        },
        params: {
          description: '初期設定 追加サポート費用',
          daysUntilDue: 7,
        },
        expectedGated: true,
      };
    }
    case 'cancel_subscription': {
      const sub = subscriptionForCustomer(manifest, inquiry.customerRef);
      return {
        action,
        targetId: sub.id,
        rationale: {
          customerId: customer.id,
          reasonCode: 'customer_requested_cancellation',
          summary: '顧客からの解約希望。不可逆操作のため承認を要する。',
        },
        expectedGated: true,
      };
    }
    case 'update_customer_metadata': {
      const newValue = extractNewMetadataValue(inquiry.text) ?? '更新済み';
      return {
        action,
        targetId: customer.id,
        rationale: {
          customerId: customer.id,
          reasonCode: 'metadata_update',
          summary: '金額に影響しない登録情報の更新。承認対象外。',
        },
        params: { metadata: { dept: newValue, updated_by: 'ai-backoffice-agent' } },
        expectedGated: false,
      };
    }
  }
}
