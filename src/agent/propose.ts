import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { log } from '../logger.js';
import { appendAudit } from '../audit-store.js';
import { loadSeedManifest, type SeedManifest } from '../manifest.js';
import { appendRequestLog, newRunId } from '../request-log.js';
import {
  classifyResponse,
  parseApprovalRequired,
  updateApprovalRequest,
} from '../stripe-client.js';
import type { ApprovalRequestRef, AuditRecord, Inquiry, Route } from '../types.js';
import { plan } from './planner.js';
import { buildJustification } from './justification.js';
import { execute } from './execute.js';

/**
 * M3 — the proposing agent.
 *
 * For each inquiry:
 *   1. read the inquiry
 *   2. decide action / target / amount            (planner)
 *   3. call Stripe with the agent key             (execute)
 *   4. classify the answer: executed / approval_required / blocked / error
 *   5. if gated: generate a reason and ATTACH it via update (updateApprovalRequest)
 *   6. record to the audit log + request log and exit — never block waiting.
 *
 * Explicit invariants (per current Stripe docs):
 *   - Stripe auto-submits the approval request to review when approval_required
 *     is returned. We attach the agent's justification via the update endpoint;
 *     there is no separate submit step.
 *   - If a gated action executes without an approval_required, either Approvals
 *     is not active on the account or no rule matched. We log a WARNING and mark
 *     it, never treat as OK.
 *   - A Block rule rejection is its own outcome (M9), not a generic error.
 *   - We never auto-approve or auto-retry a pending request.
 */

const INQUIRIES_PATH = 'fixtures/inquiries.json';

/** Feature flags that unlock opt-in inquiries (fixture `flag` field). */
export function enabledFlags(argv: string[] = process.argv.slice(2)): Set<string> {
  const flags = new Set<string>();
  if (config.enableBalanceCompensation || argv.includes('--with-balance')) {
    flags.add('balance');
  }
  return flags;
}

export function loadInquiries(
  path: string = INQUIRIES_PATH,
  flags: Set<string> = enabledFlags(),
): Inquiry[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    inquiries: Inquiry[];
  };
  return parsed.inquiries.filter((i) => !i.flag || flags.has(i.flag));
}

export interface ProposeOutcome {
  inquiryId: string;
  action: string;
  status:
    | 'proposed'
    | 'auto_executed'
    | 'rule_not_enforced'
    | 'blocked'
    | 'error';
  approvalRequestId?: string;
  dashboardUrl?: string;
  expiresAt?: string;
}

export interface ProposeContext {
  runId: string;
  route: Route;
}

/**
 * Attach the justification to an approval request and log the update request
 * (B-4 evidence). Returns the request ref with the status the update reported.
 */
export async function attachJustification(
  approval: ApprovalRequestRef,
  justification: string,
  ctx: ProposeContext & { scenario: string; action: string },
): Promise<{ ok: boolean; approval: ApprovalRequestRef; errorSummary?: string }> {
  const updated = await updateApprovalRequest(approval.id, justification);
  appendRequestLog({
    timestamp: new Date().toISOString(),
    runId: ctx.runId,
    route: ctx.route,
    kind: 'approval_update',
    scenario: ctx.scenario,
    action: ctx.action,
    httpStatus: updated.status,
    outcome: updated.ok ? 'executed' : 'error',
    approvalRequestId: approval.id,
    stripeRequestId: updated.requestId,
    raw: updated.body,
    note: `path=${updated.pathUsed} attempts=${updated.attempts
      .map((a) => `${a.path}:${a.status}`)
      .join(',')}`,
  });
  if (!updated.ok) {
    log.error(
      `  update (attach reason) failed HTTP ${updated.status} via ${updated.pathUsed}`,
      JSON.stringify(updated.body?.error ?? updated.body),
    );
    return { ok: false, approval, errorSummary: `update failed: HTTP ${updated.status}` };
  }
  log.ok(`  attached justification via ${updated.pathUsed} (HTTP ${updated.status})`);
  // The live approval_required error carries only the id, so take action /
  // status / dashboard_url / expires_at from the returned approval request.
  const b = updated.body ?? {};
  return {
    ok: true,
    approval: {
      ...approval,
      action: b.action ?? approval.action,
      status: b.status ?? approval.status,
      dashboardUrl: b.dashboard_url ?? approval.dashboardUrl,
      expiresAt: b.expires_at ?? approval.expiresAt,
    },
  };
}

export async function proposeForInquiry(
  inquiry: Inquiry,
  manifest: SeedManifest,
  ctx: ProposeContext = { runId: newRunId('propose'), route: 'cli' },
): Promise<ProposeOutcome> {
  log.section(`${inquiry.id} — 起案`);
  const actionPlan = plan(inquiry, manifest);
  const justification = buildJustification(inquiry, actionPlan);
  log.info(
    `plan: ${actionPlan.action} target=${actionPlan.targetId}` +
      (actionPlan.amount !== undefined ? ` amount=${actionPlan.amount}` : ''),
  );

  const base: Omit<AuditRecord, 'finalResult' | 'approvalRequest'> = {
    timestamp: new Date().toISOString(),
    fixtureId: inquiry.id,
    customerId: actionPlan.rationale.customerId,
    action: actionPlan.action,
    targetId: actionPlan.targetId,
    amount: actionPlan.amount,
    currency: actionPlan.currency,
    justification,
    route: ctx.route,
    events: [],
  };
  const done = (status: ProposeOutcome['status'], extra: Partial<ProposeOutcome> = {}) => ({
    inquiryId: inquiry.id,
    action: actionPlan.action,
    status,
    ...extra,
  });

  let exec: Awaited<ReturnType<typeof execute>>;
  try {
    exec = await execute(actionPlan);
  } catch (err) {
    log.error(
      `${inquiry.id} execution error`,
      err instanceof Error ? err.message : String(err),
    );
    appendAudit({ ...base, finalResult: 'failed' });
    return done('error');
  }

  for (const s of exec.preSteps) {
    log.info(`  pre-step ${s.label}: HTTP ${s.response.status}`);
    // A pre-step should not be gated; if it is, surface it.
    const preApproval = parseApprovalRequired(s.response);
    if (preApproval) {
      log.warn(`  pre-step ${s.label} unexpectedly gated (${preApproval.id})`);
    }
  }

  const { response } = exec;
  const c = classifyResponse(response);
  appendRequestLog({
    timestamp: new Date().toISOString(),
    runId: ctx.runId,
    route: ctx.route,
    kind: 'action',
    scenario: inquiry.id,
    action: actionPlan.action,
    amount: actionPlan.amount,
    httpStatus: response.status,
    outcome: c.outcome,
    approvalRequestId: c.approval?.id,
    stripeRequestId: response.requestId,
    blockEvidence: c.blockEvidence,
    raw: c.outcome === 'executed' ? { id: response.body?.id, object: response.body?.object } : response.body,
  });

  switch (c.outcome) {
    // Path A: gated → Stripe created & auto-submitted an approval request.
    case 'approval_required': {
      const attached = await attachJustification(c.approval!, justification, {
        ...ctx,
        scenario: inquiry.id,
        action: actionPlan.action,
      });
      if (!attached.ok) {
        log.error(`${inquiry.id} Stripe error`, attached.errorSummary);
        appendAudit({ ...base, approvalRequest: c.approval, finalResult: 'failed' });
        return done('error', { approvalRequestId: c.approval!.id });
      }
      const ar = attached.approval;
      log.ok(`${inquiry.id} 承認待ち: approval_request=${ar.id} status=${ar.status}`);
      if (ar.dashboardUrl) log.info(`  dashboard: ${ar.dashboardUrl}`);
      if (ar.expiresAt) log.info(`  expires_at: ${ar.expiresAt}`);
      appendAudit({ ...base, approvalRequest: ar, finalResult: 'proposed' });
      return done('proposed', {
        approvalRequestId: ar.id,
        dashboardUrl: ar.dashboardUrl,
        expiresAt: ar.expiresAt,
      });
    }

    // Path B: the action executed with no approval interception.
    case 'executed': {
      if (actionPlan.expectedGated) {
        log.warn(
          `${inquiry.id} ⚠ gated action executed WITHOUT approval — ` +
            `rule not enforced. Approvals not active on this account, or no ` +
            `active rule matched ${actionPlan.action} (credit notes and balance ` +
            `transactions have no default agent rule — create one).`,
        );
        appendAudit({ ...base, finalResult: 'rule_not_enforced' });
        return done('rule_not_enforced');
      }
      log.ok(`${inquiry.id} 承認不要のため即時実行 (contrast case)`);
      appendAudit({ ...base, finalResult: 'auto_executed' });
      return done('auto_executed');
    }

    // Path C: rejected outright by a Block rule (M9).
    case 'blocked': {
      log.warn(`${inquiry.id} ⛔ Block ルールで拒否 (${c.blockEvidence})`);
      appendAudit({ ...base, finalResult: 'blocked' });
      return done('blocked');
    }

    // Path D: anything else — raw body is in logs/requests.jsonl.
    default: {
      log.error(
        `${inquiry.id} Stripe error HTTP ${response.status}`,
        JSON.stringify(response.body?.error ?? response.body),
      );
      appendAudit({ ...base, finalResult: 'failed' });
      return done('error');
    }
  }
}

// --- CLI --------------------------------------------------------------------

function parseOnly(argv: string[]): Set<string> | null {
  const arg = argv.find((a) => a.startsWith('--only='));
  if (!arg) return null;
  const ids = arg
    .slice('--only='.length)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

async function main(): Promise<void> {
  const manifest = loadSeedManifest();
  const all = loadInquiries();
  const only = parseOnly(process.argv.slice(2));
  const inquiries = only ? all.filter((i) => only.has(i.id.toUpperCase())) : all;

  if (inquiries.length === 0) {
    log.warn('no inquiries matched the --only filter (flagged ones need --with-balance)');
    return;
  }

  const ctx: ProposeContext = { runId: newRunId('propose'), route: 'cli' };
  log.section(`起案エージェント — ${inquiries.length} 件 (run ${ctx.runId})`);
  const outcomes: ProposeOutcome[] = [];
  for (const inq of inquiries) {
    outcomes.push(await proposeForInquiry(inq, manifest, ctx));
  }

  // Summary + pending approvals with dashboard URLs (M5 requirement).
  log.section('起案サマリ');
  for (const o of outcomes) {
    log.info(`${o.inquiryId} ${o.action} → ${o.status}`);
  }
  const pending = outcomes.filter((o) => o.status === 'proposed');
  if (pending.length) {
    log.section('承認待ち — Dashboard で承認/却下してください');
    for (const p of pending) {
      log.info(`${p.inquiryId} ${p.approvalRequestId}`);
      if (p.dashboardUrl) log.info(`  ${p.dashboardUrl}`);
    }
  }
  const notEnforced = outcomes.filter((o) => o.status === 'rule_not_enforced');
  if (notEnforced.length) {
    log.warn(
      `⚠ ${notEnforced.length} gated action(s) ran WITHOUT approval — check Settings > Approvals rules.`,
    );
  }
}

// Run only when invoked directly (not when imported by demo.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log.error('propose failed', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
