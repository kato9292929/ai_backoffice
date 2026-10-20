import { log } from './logger.js';
import { readLatestByKey } from './audit-store.js';
import { appendRequestLog, newRunId } from './request-log.js';
import { cancelApprovalRequest } from './stripe-client.js';

/**
 * Cancel pending approval requests (B-5): `expired` takes 14 days, so the demo
 * produces a terminal `canceled` event instead to verify webhook delivery.
 * Uses POST /v2/core/approval_requests/{id}/cancel with the agent key (the
 * requester withdraws its own request).
 *
 *   npm run approvals:cancel -- apreq_123 [apreq_456 …]
 *   npm run approvals:cancel -- --fixture=RUNAWAY#4
 */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fixture = args.find((a) => a.startsWith('--fixture='))?.slice('--fixture='.length);
  let ids = args.filter((a) => !a.startsWith('--'));
  if (fixture) {
    const rec = [...readLatestByKey().values()].find(
      (r) => r.fixtureId === fixture && r.finalResult === 'proposed' && r.approvalRequest,
    );
    if (!rec) throw new Error(`no pending approval request recorded for ${fixture}`);
    ids = [rec.approvalRequest!.id];
  }
  if (ids.length === 0) throw new Error('usage: npm run approvals:cancel -- <apreq_id…> | --fixture=<id>');

  const runId = newRunId('cancel');
  for (const id of ids) {
    const resp = await cancelApprovalRequest(id);
    appendRequestLog({
      timestamp: new Date().toISOString(),
      runId,
      route: 'cli',
      kind: 'approval_cancel',
      scenario: fixture ?? id,
      action: 'cancel_approval_request',
      httpStatus: resp.status,
      outcome: resp.ok ? 'executed' : 'error',
      approvalRequestId: id,
      stripeRequestId: resp.requestId,
      raw: resp.body,
    });
    if (resp.ok) log.ok(`${id} → ${resp.body?.status ?? '?'} (webhook should now deliver v2.core.approval_request.canceled)`);
    else log.error(`${id} cancel failed HTTP ${resp.status}`, JSON.stringify(resp.body?.error ?? resp.body));
  }
}

main().catch((err) => {
  log.error('cancel failed', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
