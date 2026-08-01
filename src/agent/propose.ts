import { readFileSync } from 'node:fs';
import { log } from '../logger.js';
import { appendAudit } from '../audit-store.js';
import { loadSeedManifest, type SeedManifest } from '../manifest.js';
import { parseApprovalRequired, submitApprovalRequest } from '../stripe-client.js';
import type { AuditRecord, Inquiry } from '../types.js';
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
 *   4. parse the `approval_required` error         (parseApprovalRequired)
 *   5. generate a reason and SUBMIT it             (submitApprovalRequest)
 *   6. record to the audit log and exit — never block waiting for approval.
 *
 * Explicit invariants from the spec:
 *   - We MUST call submit; an unsubmitted approval request lapses in 24h.
 *   - If a gated action executes without an approval_required, that means the
 *     rule is NOT enforcing — we log a WARNING and mark it, never treat as OK.
 *   - We never auto-approve or auto-retry a pending request.
 */

const INQUIRIES_PATH = 'fixtures/inquiries.json';

export function loadInquiries(path: string = INQUIRIES_PATH): Inquiry[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    inquiries: Inquiry[];
  };
  return parsed.inquiries;
}

export interface ProposeOutcome {
  inquiryId: string;
  action: string;
  status:
    | 'proposed'
    | 'auto_executed'
    | 'rule_not_enforced'
    | 'error';
  approvalRequestId?: string;
  dashboardUrl?: string;
  expiresAt?: string;
}

export async function proposeForInquiry(
  inquiry: Inquiry,
  manifest: SeedManifest,
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
    events: [],
  };

  let result: ExecuteAttempt;
  try {
    result = await runExecute(actionPlan, justification);
  } catch (err) {
    log.error(
      `${inquiry.id} execution error`,
      err instanceof Error ? err.message : String(err),
    );
    appendAudit({ ...base, finalResult: 'failed' });
    return { inquiryId: inquiry.id, action: actionPlan.action, status: 'error' };
  }

  // Path A: the action was gated → an approval request was created & submitted.
  if (result.approval) {
    log.ok(
      `${inquiry.id} 承認待ち: approval_request=${result.approval.id} ` +
        `status=${result.approval.status}`,
    );
    if (result.approval.dashboardUrl) {
      log.info(`  dashboard: ${result.approval.dashboardUrl}`);
    }
    if (result.approval.expiresAt) {
      log.info(`  expires_at: ${result.approval.expiresAt}`);
    }
    appendAudit({
      ...base,
      approvalRequest: result.approval,
      finalResult: 'proposed',
    });
    return {
      inquiryId: inquiry.id,
      action: actionPlan.action,
      status: 'proposed',
      approvalRequestId: result.approval.id,
      dashboardUrl: result.approval.dashboardUrl,
      expiresAt: result.approval.expiresAt,
    };
  }

  // Path B: the action executed with no approval interception.
  if (result.ok) {
    if (actionPlan.expectedGated) {
      // The rule is not enforcing — this is the failure the spec calls out.
      log.warn(
        `${inquiry.id} ⚠ gated action executed WITHOUT approval — ` +
          `rule not enforced. Check the M2 rule for ${actionPlan.action}.`,
      );
      appendAudit({ ...base, finalResult: 'rule_not_enforced' });
      return {
        inquiryId: inquiry.id,
        action: actionPlan.action,
        status: 'rule_not_enforced',
      };
    }
    log.ok(`${inquiry.id} 承認不要のため即時実行 (contrast case)`);
    appendAudit({ ...base, finalResult: 'auto_executed' });
    return {
      inquiryId: inquiry.id,
      action: actionPlan.action,
      status: 'auto_executed',
    };
  }

  // Path C: some other error.
  log.error(`${inquiry.id} Stripe error`, result.errorSummary);
  appendAudit({ ...base, finalResult: 'failed' });
  return { inquiryId: inquiry.id, action: actionPlan.action, status: 'error' };
}

interface ExecuteAttempt {
  ok: boolean;
  approval?: AuditRecord['approvalRequest'];
  errorSummary?: string;
}

/** Execute + (if gated) submit the justification. */
async function runExecute(
  actionPlan: ReturnType<typeof plan>,
  justification: string,
): Promise<ExecuteAttempt> {
  const { response, preSteps } = await execute(actionPlan);
  for (const s of preSteps) {
    log.info(`  pre-step ${s.label}: HTTP ${s.response.status}`);
    // A pre-step should not be gated; if it is, surface it.
    const preApproval = parseApprovalRequired(s.response);
    if (preApproval) {
      log.warn(`  pre-step ${s.label} unexpectedly gated (${preApproval.id})`);
    }
  }

  const approvalRef = parseApprovalRequired(response);
  if (approvalRef) {
    // Step 5: MUST submit, or it lapses unreviewed in 24h.
    const submit = await submitApprovalRequest(approvalRef.id, justification);
    if (!submit.ok) {
      log.error(
        `  submit failed HTTP ${submit.status}`,
        JSON.stringify(submit.body?.error ?? submit.body),
      );
      return {
        ok: false,
        errorSummary: `submit failed: HTTP ${submit.status}`,
      };
    }
    log.ok(`  submitted justification (HTTP ${submit.status})`);
    // Prefer the submit response's status if present.
    const submittedStatus =
      (submit.body?.status as string | undefined) ?? approvalRef.status;
    return { ok: false, approval: { ...approvalRef, status: submittedStatus } };
  }

  if (response.ok) return { ok: true };

  return {
    ok: false,
    errorSummary: `HTTP ${response.status}: ${JSON.stringify(
      response.body?.error ?? response.body,
    )}`,
  };
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
    log.warn('no inquiries matched the --only filter');
    return;
  }

  log.section(`起案エージェント — ${inquiries.length} 件`);
  const outcomes: ProposeOutcome[] = [];
  for (const inq of inquiries) {
    outcomes.push(await proposeForInquiry(inq, manifest));
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
      `⚠ ${notEnforced.length} gated action(s) ran WITHOUT approval — fix M2 rules.`,
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
