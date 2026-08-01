import { agentRequest, type RawResponse } from '../stripe-client.js';
import type { ActionPlan } from '../types.js';

/**
 * Turn an ActionPlan into the actual Stripe v1 call, made with the AGENT key so
 * that gated actions are intercepted by Approvals (M3 step 3).
 *
 * We do NOT throw on 4xx — the caller inspects the returned RawResponse for an
 * `approval_required` error. Some actions take a preparatory step (e.g. an
 * invoice needs a pending invoice item first); those are reported separately so
 * they can be logged, but only the final "gated" call's response is returned as
 * `response`.
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

    case 'create_invoice': {
      const customer = plan.targetId;
      // Step 1 (un-gated): create a pending invoice item to give the invoice a
      // line. Tagged so re-runs are identifiable.
      //
      // UNVERIFIED against live Stripe (M0 §B): we assume that when the gated
      // invoice creation is later approved and auto-executed by Stripe, the
      // pending invoice item created here is pulled into that invoice
      // (pending_invoice_items_behavior: 'include'). This is not confirmed
      // against a live agent key. If the live behaviour differs, the invoice
      // will surface with an unexpected total/lines rather than being silently
      // "fixed" — inspect the created invoice in Workbench Logs to confirm.
      const itemResp = await agentRequest('POST', '/v1/invoiceitems', {
        customer,
        amount: plan.amount,
        currency: plan.currency ?? 'jpy',
        description: (plan.params?.description as string) ?? '追加費用',
        metadata: { demo_action: 'create_invoice_item' },
      });
      preSteps.push({ label: 'invoiceitem', response: itemResp });

      // Step 2 (gated): create the invoice. This is the action Approvals gates.
      const response = await agentRequest('POST', '/v1/invoices', {
        customer,
        collection_method: 'send_invoice',
        days_until_due: (plan.params?.daysUntilDue as number) ?? 7,
        pending_invoice_items_behavior: 'include',
        metadata: { demo_action: 'create_invoice' },
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
