import 'dotenv/config';

/**
 * Centralised, fail-fast configuration.
 *
 * Two Stripe keys are used deliberately:
 *  - STRIPE_SECRET_KEY : a normal test key, used ONLY to seed test data (M1).
 *  - STRIPE_AGENT_KEY  : an agent-tagged test key, used by the proposing
 *                        agent (M3). Actions taken with this key are the ones
 *                        Approvals intercepts with `approval_required`.
 *
 * Keeping them separate makes the demo's central claim legible: the human
 * seeds data with an ordinary key, but the agent can only *propose* money
 * movement — it cannot execute it unilaterally.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v.trim();
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

/** Guardrail: refuse to run against a live-mode key. Test mode only. */
function assertTestKey(name: string, key: string): string {
  if (!key.startsWith('sk_test_') && !key.startsWith('rk_test_')) {
    throw new Error(
      `${name} does not look like a TEST key (expected sk_test_/rk_test_ prefix). ` +
        `This demo refuses to run in live mode.`,
    );
  }
  return key;
}

export const config = {
  /** Standard test key for seeding (M1). */
  get secretKey(): string {
    return assertTestKey('STRIPE_SECRET_KEY', required('STRIPE_SECRET_KEY'));
  },

  /** Agent-tagged test key for the proposing agent (M3). */
  get agentKey(): string {
    return assertTestKey('STRIPE_AGENT_KEY', required('STRIPE_AGENT_KEY'));
  },

  /** Webhook signing secret (M4). Optional until you run the webhook server. */
  get webhookSecret(): string {
    return required('STRIPE_WEBHOOK_SECRET');
  },

  /** Preview API version required by the v2 approval endpoints (the
   * approval_request update endpoint). Per current Stripe docs. */
  previewVersion: optional('STRIPE_PREVIEW_VERSION', '2026-07-29.preview'),

  webhookPort: Number(optional('WEBHOOK_PORT', '4242')),

  /** JPY threshold above which a refund requires approval (matches M2 rule). */
  refundApprovalThresholdJpy: Number(
    optional('REFUND_APPROVAL_THRESHOLD_JPY', '10000'),
  ),

  /** Pinned stable API version for the SDK (v1 operations / seeding). Kept in
   * sync with the installed `stripe` SDK's expected version. */
  apiVersion: '2025-02-24.acacia' as const,
} as const;

export const STRIPE_API_BASE = 'https://api.stripe.com';
