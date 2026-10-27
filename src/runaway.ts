import { config } from './config.js';
import { log } from './logger.js';
import { appendAudit } from './audit-store.js';
import { POOL_CHARGE_HANDLE, chargeByHandle, customerId, loadSeedManifest } from './manifest.js';
import { appendRequestLog, newRunId } from './request-log.js';
import { agentRequest, classifyResponse } from './stripe-client.js';
import { buildJustification } from './agent/justification.js';
import { attachJustification } from './agent/propose.js';
import type { ActionPlan, Inquiry, RequestOutcome } from './types.js';

/**
 * M9 — runaway agent: fire N small refund proposals at a fixed interval, as an
 * agent stuck in a loop would, and log how Stripe answered each one.
 *
 * Intended rule configurations (only ONE active rule per action, so these are
 * two separate runs with the rule switched in between — see
 * docs/APPROVAL_RULES.md "M9"):
 *   --rule-set=block    : refund, actor=agent-tagged keys AND rate limit
 *                         (> 3 per 10 min) → Block. Expect: executed ×3, then blocked.
 *   --rule-set=approval : refund, actor=agent-tagged keys → Require approval.
 *                         Expect: approval_required every time.
 *
 * Refunds are partial refunds drawn from the seeded pool charge
 * (`runaway-pool`, ¥20,000), so the INQ fixtures are never consumed.
 *
 *   npm run demo:runaway -- --count=6 --interval=10 --amount=1500 --rule-set=block
 */

function value(name: string, fallback: string): string {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : fallback;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const count = Number(value('count', '5'));
  const intervalSec = Number(value('interval', '5'));
  const amount = Number(value('amount', '1500'));
  const ruleSet = value('rule-set', 'unspecified');
  if (!(count > 0) || !(intervalSec >= 0) || !(amount > 0)) {
    throw new Error('--count / --interval / --amount must be positive numbers');
  }

  const manifest = loadSeedManifest();
  const pool = chargeByHandle(manifest, POOL_CHARGE_HANDLE);
  const customer = customerId(manifest, pool.customerHandle);
  const runId = newRunId('runaway');
  if (count * amount > pool.amount) {
    log.warn(
      `count×amount = ¥${count * amount} exceeds the pool (¥${pool.amount}); ` +
        `later requests will fail once it is exhausted. Re-seed to replenish.`,
    );
  }
  if (amount <= config.refundApprovalThresholdJpy) {
    log.warn(
      `amount ¥${amount} ≤ REFUND_APPROVAL_THRESHOLD_JPY (¥${config.refundApprovalThresholdJpy}): ` +
        `a refund rule with that amount condition would NOT gate these.`,
    );
  }

  log.section(
    `M9 runaway — ${count} 件 × ¥${amount} / ${intervalSec}s 間隔 ` +
      `(rule-set=${ruleSet}, run ${runId})`,
  );
  const started = Date.now();
  const rows: Array<{ seq: number; t: number; outcome: RequestOutcome; http: number; detail: string }> = [];

  for (let seq = 1; seq <= count; seq++) {
    if (seq > 1 && intervalSec > 0) await sleep(intervalSec * 1000);
    const scenario = `RUNAWAY#${seq}`;
    const response = await agentRequest('POST', '/v1/refunds', {
      payment_intent: pool.paymentIntentId,
      amount,
      metadata: { demo_action: 'runaway_refund', demo_run: runId, demo_seq: String(seq) },
    });
    const c = classifyResponse(response);
    const t = Math.round((Date.now() - started) / 1000);
    appendRequestLog({
      timestamp: new Date().toISOString(),
      runId,
      route: 'cli',
      kind: 'action',
      scenario,
      action: 'create_refund',
      amount,
      httpStatus: response.status,
      outcome: c.outcome,
      approvalRequestId: c.approval?.id,
      stripeRequestId: response.requestId,
      blockEvidence: c.blockEvidence,
      ruleSet,
      raw: c.outcome === 'executed' ? { id: response.body?.id, object: response.body?.object } : response.body,
    });

    let detail = '';
    if (c.outcome === 'approval_required') {
      // Same treatment as any proposal: attach a reason, record for the webhook.
      const inquiry: Inquiry = {
        id: scenario,
        customerRef: pool.customerHandle,
        text: '(暴走シナリオ: 同一エージェントによる少額返金の連続起案)',
        expectation: 'M9',
      };
      const p: ActionPlan = {
        action: 'create_refund',
        targetId: pool.chargeId,
        amount,
        currency: pool.currency,
        rationale: {
          customerId: customer.id,
          reasonCode: 'runaway_test',
          summary: `暴走検知デモ (${runId}) の ${seq}/${count} 件目。承認せず却下または取消してよい。`,
        },
        expectedGated: true,
      };
      const justification = buildJustification(inquiry, p);
      const attached = await attachJustification(c.approval!, justification, {
        runId,
        route: 'cli',
        scenario,
        action: p.action,
      });
      appendAudit({
        timestamp: new Date().toISOString(),
        fixtureId: scenario,
        customerId: customer.id,
        action: p.action,
        targetId: p.targetId,
        amount,
        currency: pool.currency,
        justification,
        approvalRequest: attached.approval,
        route: 'cli',
        events: [],
        finalResult: attached.ok ? 'proposed' : 'failed',
      });
      detail = c.approval!.id;
    } else if (c.outcome === 'blocked') {
      detail = c.blockEvidence ?? '';
    } else if (c.outcome === 'error') {
      detail = `${response.body?.error?.code ?? ''} ${response.body?.error?.message ?? JSON.stringify(response.body)}`.trim();
    } else {
      detail = response.body?.id ?? '';
    }

    const tag: Record<RequestOutcome, string> = {
      executed: '即時実行',
      approval_required: 'approval_required',
      blocked: 'Block',
      duplicate_pending: '重複（同じ対象に承認待ちあり）',
      error: 'エラー(未分類)',
    };
    log.info(`#${seq} +${t}s HTTP ${response.status} → ${tag[c.outcome]} ${detail}`);
    rows.push({ seq, t, outcome: c.outcome, http: response.status, detail });
  }

  log.section('runaway サマリ');
  const tally = new Map<RequestOutcome, number>();
  for (const r of rows) tally.set(r.outcome, (tally.get(r.outcome) ?? 0) + 1);
  for (const [k, n] of tally) log.info(`${k}: ${n}`);
  const firstBlock = rows.find((r) => r.outcome === 'blocked');
  if (firstBlock) log.info(`最初の Block: #${firstBlock.seq} (+${firstBlock.t}s)`);
  const unknown = rows.filter((r) => r.outcome === 'error');
  if (unknown.length) {
    log.warn(
      `${unknown.length} 件が未分類エラー。Block の形が想定と違う可能性 (B-9) — ` +
        '`npm run evidence -- --run=' + runId + '` で生レスポンスを確認',
    );
  }
}

main().catch((err) => {
  log.error('runaway failed', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
