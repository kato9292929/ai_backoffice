import { log } from './logger.js';
import { appendAudit, readLatestByKey } from './audit-store.js';
import { listApprovalRequests } from './stripe-client.js';
import type { AuditRecord, FinalResult } from './types.js';

/**
 * Fill in approval outcomes the webhook missed (e.g. the local webhook server
 * or `stripe listen` was down while a reviewer clicked). Reads the approval
 * requests with the agent key — only the creating key can see them — and, for
 * each audit record still `proposed`, appends a snapshot built from the
 * request's status_transitions. Events added this way are typed
 * `reconciled:<status>` so they are never mistaken for delivered webhooks.
 *
 *   npm run reconcile
 */

const FINAL: Record<string, FinalResult | undefined> = {
  succeeded: 'executed',
  rejected: 'rejected',
  canceled: 'canceled',
  expired: 'expired',
  failed: 'failed',
};
const ORDER = ['approved', 'rejected', 'canceled', 'expired', 'succeeded', 'failed'];

async function main(): Promise<void> {
  const listed = await listApprovalRequests();
  if (!listed.ok) {
    throw new Error(`list failed HTTP ${listed.response.status}: ${JSON.stringify(listed.response.body)}`);
  }
  const byId = new Map(listed.data.map((r) => [r.id as string, r]));
  let updated = 0;
  for (const rec of readLatestByKey().values()) {
    const id = rec.approvalRequest?.id;
    if (!id || rec.finalResult !== 'proposed') continue;
    const r = byId.get(id);
    if (!r) {
      log.warn(`${rec.fixtureId} ${id} not visible to the agent key`);
      continue;
    }
    const tr = r.status_transitions ?? {};
    const have = new Set(rec.events.map((e) => e.status));
    const events = [...rec.events];
    for (const st of ORDER) {
      const at = tr[`${st}_at`];
      if (at && !have.has(st)) events.push({ receivedAt: at, type: `reconciled:${st}`, status: st });
    }
    const final = FINAL[r.status as string];
    if (!final && events.length === rec.events.length) continue;
    const sd = r.status_details ?? {};
    const result = sd.succeeded?.result ?? sd.execution_succeeded?.result;
    const next: AuditRecord = {
      ...rec,
      events,
      finalResult: final ?? rec.finalResult,
      ...(result?.id ? { resultObject: { id: result.id, object: result.object } } : {}),
      ...(r.status === 'failed' ? { failureDetails: r.status_details ?? null } : {}),
    };
    appendAudit(next);
    updated++;
    log.ok(`${rec.fixtureId} ${id} → ${r.status}${result?.id ? ` result=${result.object}:${result.id}` : ''}`);
  }
  log.info(`reconciled ${updated} record(s)`);
}

main().catch((err) => {
  log.error('reconcile failed', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
