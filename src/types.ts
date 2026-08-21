/**
 * Shared domain types for the AI back-office demo.
 */

/** The three money-moving actions this demo can propose. All are in Stripe
 * Approvals' Supported actions list. */
export type ActionType =
  | 'create_refund'
  | 'create_invoice'
  | 'cancel_subscription'
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
  /** Action-specific extras (invoice due days, new metadata value, ...). */
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
  | 'auto_executed' // no rule matched; ran without approval (contrast case)
  | 'rule_not_enforced'; // WARNING: gated action ran without approval

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
  /** State transitions appended as webhook events land. */
  events: Array<{
    receivedAt: string;
    type: string;
    status: string;
  }>;
  finalResult: FinalResult;
}
