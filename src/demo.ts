import { log } from './logger.js';
import { runSeed } from './seed.js';
import { loadSeedManifest } from './manifest.js';
import { loadInquiries, proposeForInquiry, type ProposeOutcome } from './agent/propose.js';
import { findByApprovalId } from './audit-store.js';
import type { FinalResult } from './types.js';

/**
 * M5 — one-command demo: seed → propose → wait → reflect.
 *
 * The webhook server (`npm run webhook`) + `stripe listen` must be running in a
 * separate terminal; this process watches the audit log those write to and
 * reports state transitions as they land. It never auto-approves — approval is
 * a human action in the Stripe Dashboard.
 *
 * Flags:
 *   --skip-seed          skip M1 seeding (data already present)
 *   --only=INQ-001,...   run a subset of inquiries (keep recordings short)
 *   --no-wait            propose and exit without watching for approvals
 *   --timeout=<seconds>  give up waiting after N seconds (default 900)
 *   --poll=<seconds>     poll interval while waiting (default 5)
 */

const TERMINAL: ReadonlySet<FinalResult> = new Set<FinalResult>([
  'executed',
  'rejected',
  'canceled',
  'expired',
  'failed',
  'auto_executed',
  'rule_not_enforced',
]);

function flag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}
function value(name: string, fallback: string): string {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForApprovals(
  pending: ProposeOutcome[],
  timeoutSec: number,
  pollSec: number,
): Promise<void> {
  const ids = pending
    .map((p) => p.approvalRequestId)
    .filter((x): x is string => !!x);
  if (ids.length === 0) return;

  const deadline = Date.now() + timeoutSec * 1000;
  log.section('承認待ち — Dashboard で承認/却下してください');
  for (const p of pending) {
    log.info(`${p.inquiryId} ${p.approvalRequestId}`);
    if (p.dashboardUrl) log.info(`  ${p.dashboardUrl}`);
  }
  log.info(
    `(webhook server + \`stripe listen\` must be running to reflect results)`,
  );

  const resolved = new Set<string>();
  while (Date.now() < deadline && resolved.size < ids.length) {
    await sleep(pollSec * 1000);
    for (const id of ids) {
      if (resolved.has(id)) continue;
      const rec = findByApprovalId(id);
      if (rec && TERMINAL.has(rec.finalResult)) {
        resolved.add(id);
        log.ok(`${rec.fixtureId} ${id} → ${rec.finalResult}`);
      }
    }
    const remaining = ids.length - resolved.size;
    if (remaining > 0) {
      const secsLeft = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      log.info(`…待機中: 未決 ${remaining}/${ids.length} (残り ${secsLeft}s)`);
    }
  }

  if (resolved.size < ids.length) {
    log.warn(
      `timeout: ${ids.length - resolved.size} approval(s) still pending. ` +
        `Run \`npm run audit\` later to see the final state.`,
    );
  } else {
    log.ok('すべての承認リクエストが終端状態に到達しました。');
  }
}

async function main(): Promise<void> {
  if (!flag('skip-seed')) {
    await runSeed();
  } else {
    log.info('skip-seed: reusing existing fixtures/seeded.json');
  }

  const manifest = loadSeedManifest();
  const all = loadInquiries();
  const onlyArg = value('only', '');
  const only = onlyArg
    ? new Set(onlyArg.split(',').map((s) => s.trim().toUpperCase()))
    : null;
  const inquiries = only ? all.filter((i) => only.has(i.id.toUpperCase())) : all;

  log.section(`起案 — ${inquiries.length} 件`);
  const outcomes: ProposeOutcome[] = [];
  for (const inq of inquiries) {
    outcomes.push(await proposeForInquiry(inq, manifest));
  }

  log.section('起案サマリ');
  for (const o of outcomes) log.info(`${o.inquiryId} ${o.action} → ${o.status}`);

  const pending = outcomes.filter((o) => o.status === 'proposed');
  if (flag('no-wait')) {
    log.info('no-wait: exiting without watching for approvals.');
    return;
  }
  if (pending.length === 0) {
    log.info('承認待ちの起案はありません。');
    return;
  }

  await waitForApprovals(
    pending,
    Number(value('timeout', '900')),
    Number(value('poll', '5')),
  );
  log.section('demo 完了 — `npm run audit` で監査ログを確認できます');
}

main().catch((err) => {
  log.error('demo failed', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
