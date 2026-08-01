import type { ActionPlan, Inquiry } from '../types.js';

/**
 * Generate the human-readable justification text submitted with the approval
 * request (M3 step 5).
 *
 * IMPORTANT: the field list here is the SAME as the "custom justification
 * instructions" configured on each approval rule (see docs/APPROVAL_RULES.md).
 * The reviewer sees these instructions in the Dashboard; the agent fills them
 * in. Keep the two in lockstep — if you add a field to the rule instructions,
 * add it here too.
 */

const ACTION_LABEL: Record<ActionPlan['action'], string> = {
  create_refund: '返金',
  create_invoice: '請求書発行',
  cancel_subscription: 'サブスクリプション解約',
  update_customer_metadata: '顧客メタデータ更新',
};

function formatAmount(plan: ActionPlan): string {
  if (plan.amount === undefined) return '—（金額なし）';
  const cur = (plan.currency ?? 'jpy').toUpperCase();
  if (cur === 'JPY') return `¥${plan.amount.toLocaleString('ja-JP')}`;
  return `${plan.amount} ${cur}`;
}

export function buildJustification(inquiry: Inquiry, plan: ActionPlan): string {
  const lines = [
    '【AIバックオフィス 起案理由】',
    `起案根拠(問い合わせ): ${inquiry.id}`,
    `対象顧客: ${plan.rationale.customerId}`,
    `アクション: ${ACTION_LABEL[plan.action]} (${plan.action})`,
    `対象オブジェクト: ${plan.targetId}`,
    `金額: ${formatAmount(plan)}`,
    `判断根拠コード: ${plan.rationale.reasonCode}`,
    `判断根拠: ${plan.rationale.summary}`,
    `起案者: ai-backoffice-agent (agent-tagged key / test mode)`,
  ];
  return lines.join('\n');
}
