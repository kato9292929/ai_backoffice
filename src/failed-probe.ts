import { log } from './logger.js';
import { chargeByHandle, customerId, loadSeedManifest } from './manifest.js';
import { appendRequestLog, newRunId } from './request-log.js';
import { makeSdk } from './stripe-client.js';
import { buildJustification } from './agent/justification.js';
import { proposePlan } from './agent/propose.js';
import type { ActionPlan } from './types.js';

/**
 * M12-1 — reproduce `v2.core.approval_request.failed` for real.
 *
 *   1. the agent proposes a FULL refund of the dedicated `failed-probe` charge
 *      (→ approval_required, reason attached)
 *   2. while it waits, the secret key refunds the same charge directly — rules
 *      only gate agent-tagged keys, so this executes at once
 *   3. a human approves step 1; Stripe then tries to refund an already fully
 *      refunded charge, which should fail → `failed`
 *
 *   npm run demo:failed      (then approve FAILED-PROBE in the Dashboard)
 */

const SCENARIO = 'FAILED-PROBE';

async function main(): Promise<void> {
  const manifest = loadSeedManifest();
  const ch = chargeByHandle(manifest, 'failed-probe');
  const customer = customerId(manifest, ch.customerHandle);
  const stripe = makeSdk();
  const charge = await stripe.charges.retrieve(ch.chargeId);
  if (charge.amount_refunded > 0) {
    throw new Error(`failed-probe charge ${ch.chargeId} is already refunded — run \`npm run seed\` first`);
  }
  const runId = newRunId('failed');
  log.section(`M12-1 failed 再現 — ${ch.chargeId} ¥${ch.amount} (run ${runId})`);

  // 1) agent proposes the full refund
  const plan: ActionPlan = {
    action: 'create_refund',
    targetId: ch.chargeId,
    amount: ch.amount,
    currency: ch.currency,
    rationale: {
      customerId: customer.id,
      reasonCode: 'failed_probe',
      summary:
        'failed 再現用の試験起案。承認待ちの間に同じ charge を secret key で全額返金済み。承認すると実行が失敗する想定。',
    },
    params: { paymentIntentId: ch.paymentIntentId },
    expectedGated: true,
  };
  const justification = buildJustification(
    { id: SCENARIO, customerRef: ch.customerHandle, text: '', expectation: 'M12-1' },
    plan,
  );
  const outcome = await proposePlan(SCENARIO, plan, justification, { runId, route: 'cli' });
  if (outcome.status !== 'proposed') {
    throw new Error(`expected a pending approval request, got ${outcome.status} — not refunding directly`);
  }

  // 2) the human-side key refunds the same charge directly (no approval)
  const direct = await stripe.refunds.create({
    payment_intent: ch.paymentIntentId,
    metadata: { demo_action: 'failed_probe_direct_refund', demo_run: runId },
  });
  appendRequestLog({
    timestamp: new Date().toISOString(),
    runId,
    route: 'cli',
    kind: 'action',
    scenario: `${SCENARIO}-DIRECT`,
    action: 'create_refund (secret key)',
    amount: direct.amount,
    httpStatus: 200,
    outcome: 'executed',
    raw: { id: direct.id, object: direct.object, status: direct.status, amount: direct.amount },
    note: 'secret key refund while the agent refund is pending approval',
  });
  log.ok(`secret key で同じ charge を直接全額返金: ${direct.id} (${direct.status}, ¥${direct.amount}) — 承認なしで即時実行`);
  log.section('次: Dashboard で FAILED-PROBE を承認 → Stripe の実行が失敗する想定');
  log.info(`approval_request=${outcome.approvalRequestId}`);
}

main().catch((err) => {
  log.error('failed probe', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
