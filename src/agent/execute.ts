import { agentRequest, type RawResponse } from '../stripe-client.js';
import type { ActionPlan } from '../types.js';

/**
 * Turn an ActionPlan into the actual Stripe v1 call, made with the AGENT key so
 * that gated actions are intercepted by Approvals (M3 step 3).
 *
 * We do NOT throw on 4xx — the caller inspects the returned RawResponse for an
 * `approval_required` error. An action that needs a preparatory step reports
 * it separately so it can be logged, but only the final "gated" call's
 * response is returned as `response`. (None of the current actions needs one
 * since M8 replaced the two-step invoice with a credit note.)
 */

export interface ExecuteResult {
  /** Response from the action that is expected to be gated. */
  response: RawResponse;
  /** Any preparatory (un-gated) calls made first, for logging. */
  preSteps: Array<{ label: string; response: RawResponse }>;
}

export async function execute(plan: ActionPlan): Promise<ExecuteResult> {
  const preSteps: ExecuteResult['preSteps'] = [];

  switch (plan.action) {
    case 'create_refund': {
      const paymentIntentId = plan.params?.paymentIntentId as string | undefined;
      const body: Record<string, unknown> = { amount: plan.amount };
      if (paymentIntentId) body.payment_intent = paymentIntentId;
      else body.charge = plan.targetId;
      body['metadata[demo_action]'] = 'create_refund';
      const response = await agentRequest('POST', '/v1/refunds', body);
      return { response, preSteps };
    }

    case 'create_credit_note': {
      // Credit note against a finalized invoice, as one custom line so the
      // credited amount is explicit. "Credit note is created" is an
      // Approvals-supported action (no default agent rule — needs a custom one).
      const response = await agentRequest('POST', '/v1/credit_notes', {
        invoice: plan.targetId,
        reason: (plan.params?.reason as string) ?? 'order_change',
        lines: [
          {
            type: 'custom_line_item',
            description: (plan.params?.description as string) ?? '減額',
            quantity: 1,
            unit_amount: plan.amount,
          },
        ],
        memo: plan.rationale.summary,
        metadata: { demo_action: 'create_credit_note' },
      });
      return { response, preSteps };
    }

    case 'cancel_subscription': {
      const response = await agentRequest(
        'DELETE',
        `/v1/subscriptions/${encodeURIComponent(plan.targetId)}`,
      );
      return { response, preSteps };
    }

    case 'create_balance_transaction': {
      // A negative amount is a credit applied to the customer's next invoice.
      const response = await agentRequest(
        'POST',
        `/v1/customers/${encodeURIComponent(plan.targetId)}/balance_transactions`,
        {
          amount: -(plan.amount ?? 0),
          currency: plan.currency ?? 'jpy',
          description: (plan.params?.description as string) ?? '補償',
          metadata: { demo_action: 'create_balance_transaction' },
        },
      );
      return { response, preSteps };
    }

    case 'update_customer_metadata': {
      const metadata = (plan.params?.metadata as Record<string, string>) ?? {};
      const response = await agentRequest(
        'POST',
        `/v1/customers/${encodeURIComponent(plan.targetId)}`,
        { metadata },
      );
      return { response, preSteps };
    }
  }
}
