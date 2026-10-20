import { config } from './config.js';
import { listApprovalRequests, makeSdk } from './stripe-client.js';
import {
  loadSeedManifest,
  chargeForCustomer,
  invoiceForCustomer,
  subscriptionForCustomer,
} from './manifest.js';
import { loadInquiries } from './agent/propose.js';
import { plan } from './agent/planner.js';
import { readLatestByKey } from './audit-store.js';
import { readRequestLog } from './request-log.js';
import { log } from './logger.js';

/**
 * Read-only status report (`npm run status`). Never mutates anything.
 *
 *  1. environment: Stripe-Version (stable + preview), update path mode, and
 *     whether the agent key is agent-tagged (only as far as can be told)
 *  2. approval requests by status (承認待ち / 承認済み / 却下 / 失効 …) from the
 *     v2 list API; falls back to the local audit log if the API is unavailable
 *  3. approval rules: there is no documented rules API (2026-10-20), so we show
 *     the rule names observed on approval requests and point to the Dashboard
 *  4. per-fixture consumption (can a fresh through-run still be executed?)
 *  5. per-request outcome counts from logs/requests.jsonl (M9)
 */

/** Approval request statuses grouped for display. Deprecated aliases from the
 * API reference are folded into their current names. */
const STATUS_GROUPS: Array<{ label: string; statuses: string[] }> = [
  { label: '承認待ち', statuses: ['requires_review', 'pending'] },
  { label: '承認済み(実行待ち)', statuses: ['approved', 'requires_execution', 'execution_started'] },
  { label: '承認済み→実行成功', statuses: ['succeeded', 'execution_succeeded'] },
  { label: '承認済み→実行失敗', statuses: ['failed', 'execution_failed'] },
  { label: '却下', statuses: ['rejected'] },
  { label: '失効', statuses: ['expired'] },
  { label: '取消', statuses: ['canceled'] },
];

function describeAgentKey(): string {
  const key = process.env.STRIPE_AGENT_KEY?.trim();
  if (!key) return '未設定 (STRIPE_AGENT_KEY)';
  if (key.startsWith('sk_')) {
    return 'agent タグ無し — secret key には agent タグを付けられない（restricted key 作成時のみ選択可）';
  }
  if (key.startsWith('rk_')) {
    return (
      '判別不可 — restricted key だが、agent タグの有無を返す API はドキュメントに無い。' +
      'Dashboard > Developers > API keys の「Agent」バッジで確認'
    );
  }
  return '判別不可 — 想定外のキー形式';
}

function section1(): void {
  log.section('1. 環境');
  console.log(`Stripe-Version (v1 / SDK)        : ${config.apiVersion}`);
  console.log(`Stripe-Version (v2 approvals)    : ${config.previewVersion}` +
    (process.env.STRIPE_PREVIEW_VERSION ? '  (STRIPE_PREVIEW_VERSION で上書き)' : '  (既定値)'));
  console.log(`理由文 update のパス             : ${config.approvalUpdatePath}`);
  console.log(`agent key                        : ${describeAgentKey()}`);
  console.log(`残高付与シナリオ (INQ-007)        : ${config.enableBalanceCompensation ? '有効' : '無効（既定）'}`);
}

async function section2and3(): Promise<void> {
  log.section('2. 承認リクエスト（件数）');
  let listed: Awaited<ReturnType<typeof listApprovalRequests>> | null = null;
  try {
    listed = await listApprovalRequests();
  } catch (err) {
    log.warn('approval_requests list unavailable', err instanceof Error ? err.message : String(err));
  }

  if (listed?.ok) {
    const data = listed.data;
    const byStatus = new Map<string, number>();
    for (const r of data) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    for (const g of STATUS_GROUPS) {
      const n = g.statuses.reduce((sum, st) => sum + (byStatus.get(st) ?? 0), 0);
      console.log(`${g.label}: ${n}`);
    }
    const known = new Set(STATUS_GROUPS.flatMap((g) => g.statuses));
    for (const [st, n] of byStatus) if (!known.has(st)) console.log(`(未知の status ${st}) ${n}`);
    console.log(`合計 ${data.length} 件（GET /v2/core/approval_requests, ${config.previewVersion}）`);
    const fromApiKey = data.filter((r) => r.requested_by?.type === 'api_key').length;
    if (fromApiKey) console.log(`うち API key からの起案: ${fromApiKey} 件`);

    log.section('3. 承認ルール');
    console.log('ルール一覧の API はドキュメントに無い（2026-10-20 時点）→ Dashboard > Settings > Approvals で確認。');
    const ruleNames = new Map<string, number>();
    for (const r of data) {
      const name = r.rule?.name ?? '(rule なし)';
      const key = `${name}  [${r.action}]`;
      ruleNames.set(key, (ruleNames.get(key) ?? 0) + 1);
    }
    if (ruleNames.size) {
      console.log('承認リクエストから観測されたルール名（approval_request.rule.name）:');
      for (const [k, n] of ruleNames) console.log(`  ${k}  × ${n}`);
    }
    return;
  }

  if (listed && !listed.ok) {
    log.warn(
      `list API failed HTTP ${listed.response.status}`,
      JSON.stringify(listed.response.body?.error ?? listed.response.body),
    );
  }
  console.log('→ ローカル監査ログ (logs/audit.jsonl) からの集計で代替:');
  const counts = new Map<string, number>();
  for (const r of readLatestByKey().values()) {
    counts.set(r.finalResult, (counts.get(r.finalResult) ?? 0) + 1);
  }
  const map: Record<string, string> = {
    proposed: '承認待ち',
    executed: '承認済み→実行成功',
    failed: '失敗',
    rejected: '却下',
    expired: '失効',
    canceled: '取消',
    blocked: 'Block',
    auto_executed: '即時実行(対象外)',
    rule_not_enforced: '⚠ ルール未適用',
  };
  for (const [k, n] of counts) console.log(`${map[k] ?? k}: ${n}`);
  if (counts.size === 0) console.log('(記録なし)');

  log.section('3. 承認ルール');
  console.log('ルール一覧の API はドキュメントに無い → Dashboard > Settings > Approvals で確認。');
}

type Consumption = { state: 'ready' | 'consumed' | 'unknown'; detail: string };

async function section4(): Promise<void> {
  log.section('4. フィクスチャの消費状況');
  const stripe = makeSdk(); // read-only retrieves
  const manifest = loadSeedManifest();
  const inquiries = loadInquiries(undefined, new Set(['balance']));
  const rows: Array<{ id: string; action: string; c: Consumption }> = [];

  for (const inq of inquiries) {
    let action = '?';
    let c: Consumption = { state: 'ready', detail: '' };
    try {
      const p = plan(inq, manifest);
      action = p.action;
      if (p.action === 'create_refund') {
        const ch = chargeForCustomer(manifest, inq.customerRef);
        const charge = await stripe.charges.retrieve(ch.chargeId);
        const refunded = charge.refunded || charge.amount_refunded >= charge.amount;
        c = refunded
          ? { state: 'consumed', detail: `refunded ¥${charge.amount_refunded.toLocaleString('ja-JP')}` }
          : { state: 'ready', detail: `refundable ¥${charge.amount.toLocaleString('ja-JP')}` };
      } else if (p.action === 'cancel_subscription') {
        const sub = subscriptionForCustomer(manifest, inq.customerRef);
        const s = await stripe.subscriptions.retrieve(sub.id);
        c =
          s.status === 'canceled'
            ? { state: 'consumed', detail: 'subscription canceled' }
            : { state: 'ready', detail: `status ${s.status}` };
      } else if (p.action === 'create_credit_note') {
        const iv = invoiceForCustomer(manifest, inq.customerRef);
        const inv = await stripe.invoices.retrieve(iv.id);
        const credited =
          (inv.pre_payment_credit_notes_amount ?? 0) + (inv.post_payment_credit_notes_amount ?? 0);
        c =
          credited > 0 || inv.status !== 'open'
            ? { state: 'consumed', detail: `invoice ${inv.status}, credited ¥${credited.toLocaleString('ja-JP')}` }
            : { state: 'ready', detail: `invoice open ¥${inv.amount_remaining.toLocaleString('ja-JP')}` };
      } else if (p.action === 'create_balance_transaction') {
        c = { state: 'ready', detail: `re-runnable (each run adds a balance credit)${inq.flag ? ' [flag: ' + inq.flag + ']' : ''}` };
      } else {
        c = { state: 'ready', detail: 're-runnable (idempotent metadata)' };
      }
    } catch (err) {
      c = { state: 'unknown', detail: err instanceof Error ? err.message : String(err) };
    }
    rows.push({ id: inq.id, action, c });
  }

  console.log(['fixture', 'action', 'state', 'detail'].join('\t'));
  console.log('─'.repeat(80));
  for (const r of rows) console.log([r.id, r.action, r.c.state, r.c.detail].join('\t'));

  const ready = rows.filter((r) => r.c.state === 'ready').map((r) => r.id);
  const consumed = rows.filter((r) => r.c.state === 'consumed').map((r) => r.id);
  log.info(`未消費 (ready): ${ready.join(', ') || 'none'}`);
  if (consumed.length) log.warn(`消費済み (consumed): ${consumed.join(', ')} — re-seed to replenish`);
}

function section5(): void {
  log.section('5. リクエスト結果（logs/requests.jsonl）');
  const lines = readRequestLog().filter((l) => l.kind === 'action');
  if (lines.length === 0) {
    console.log('(記録なし)');
    return;
  }
  const counts = new Map<string, number>();
  for (const l of lines) {
    const k = `${l.route}\t${l.outcome}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  console.log('route\toutcome\tcount');
  for (const [k, n] of counts) console.log(`${k}\t${n}`);
}

async function main(): Promise<void> {
  section1();
  // Each section is independent: a missing key or manifest only skips its part.
  for (const run of [section2and3, section4]) {
    try {
      await run();
    } catch (err) {
      log.warn('skipped', err instanceof Error ? err.message : String(err));
    }
  }
  section5();
}

main().catch((err) => {
  log.error('status failed', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
