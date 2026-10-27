/**
 * Shared domain types for the AI back-office demo.
 */

/** The money-moving actions this demo can propose. All are in Stripe
 * Approvals' Supported actions list (Set up two-party approvals, 2026-10-20):
 * refund / credit note / subscription cancel / customer balance transaction.
 * (Invoice creation is NOT a supported action — M8 replaced it.) */
export type ActionType =
  | 'create_refund'
  | 'create_credit_note'
  | 'cancel_subscription'
  /** Compensation by customer-balance credit instead of a refund (M8, opt-in). */
  | 'create_balance_transaction'
  /** A deliberately un-gated action, used as a contrast case (M3 #6). */
  | 'update_customer_metadata';

/** A customer-inquiry fixture (M3 input). */
export interface Inquiry {
  /** Stable fixture id, e.g. "INQ-001". Threaded through every log line. */
  id: string;
  /** Free-text inquiry in Japanese, as the "customer" wrote it. */
  text: string;
  /** Which seeded customer this inquiry is about (customer id from seed). */
  customerRef: string;
  /** Human-readable note about what this case is meant to demonstrate. */
  expectation: string;
  /** Opt-in feature flag. Inquiries carrying one are skipped unless that flag
   * is enabled (e.g. "balance" → ENABLE_BALANCE_COMPENSATION / --with-balance). */
  flag?: string;
}

/** The agent's decision about what to do with an inquiry (M3 step 2). */
export interface ActionPlan {
  action: ActionType;
  /** Target Stripe object id (charge/pi id, subscription id, customer id...). */
  targetId: string;
  /** Amount in the smallest currency unit (JPY has no minor unit → yen). */
  amount?: number;
  currency?: string;
  /** Structured facts the justification text is built from. */
  rationale: {
    customerId: string;
    /** Short machine reason code, e.g. "duplicate_charge". */
    reasonCode: string;
    /** One-line human summary of why this action is warranted. */
    summary: string;
  };
  /** Action-specific extras (credit note reason, new metadata value, ...). */
  params?: Record<string, unknown>;
  /** Whether this action is expected to be gated by an approval rule. Used to
   * detect a rule that silently failed to enforce (M3 requirement). */
  expectedGated: boolean;
}

/** Parsed contents of an `approval_required` error (M3 step 4). */
export interface ApprovalRequestRef {
  id: string;
  action: string;
  status: string;
  dashboardUrl?: string;
  expiresAt?: string;
}

/** Terminal outcome recorded in the audit log. */
export type FinalResult =
  | 'proposed' // submitted, awaiting human decision
  | 'executed' // approved by human AND succeeded on Stripe
  | 'rejected' // human rejected
  | 'canceled' // approval request withdrawn/canceled
  | 'expired' // approval request lapsed
  | 'failed' // approved but Stripe execution failed
  | 'blocked' // rejected outright by a Block rule (M9)
  | 'auto_executed' // no rule matched; ran without approval (contrast case)
  | 'rule_not_enforced'; // WARNING: gated action ran without approval

/** How Stripe answered one agent request (M9: one line per request). */
export type RequestOutcome =
  | 'executed' // 2xx: ran immediately
  | 'approval_required' // intercepted by a Require-approval rule
  | 'blocked' // rejected by a Block rule (live: 403 action_blocked)
  | 'duplicate_pending' // refused: an approval request is already pending for this target (live: 400, no code)
  | 'error'; // anything else — raw body kept for diagnosis

/** Which client path made the request (M10). */
export type Route = 'cli' | 'mcp';

/** One JSONL audit record. Written at propose time and appended to as
 * webhook events arrive. */
export interface AuditRecord {
  timestamp: string;
  fixtureId: string;
  customerId: string;
  action: ActionType;
  targetId: string;
  amount?: number;
  currency?: string;
  /** Full justification text the agent generated. */
  justification: string;
  approvalRequest?: ApprovalRequestRef;
  /** Client path the proposal went through (absent on pre-M10 records = cli). */
  route?: Route;
  /** Object Stripe created when it executed the approved action (from the
   * approval request's status_details on `succeeded`). */
  resultObject?: { id: string; object: string };
  /** State transitions appended as webhook events land. */
  events: Array<{
    receivedAt: string;
    type: string;
    status: string;
  }>;
  finalResult: FinalResult;
}
