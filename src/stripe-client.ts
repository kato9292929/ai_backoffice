import Stripe from 'stripe';
import { config, STRIPE_API_BASE } from './config.js';
import type { ApprovalRequestRef } from './types.js';

/**
 * Stripe access in two flavours:
 *
 *  1. SDK client (`makeSdk`) — used for M1 seeding with the ordinary test key.
 *     The official SDK is convenient for bulk object creation.
 *
 *  2. Raw form-encoded HTTP (`agentRequest`) — used for the proposing agent's
 *     money-moving calls. We deliberately bypass the SDK here so we can read
 *     the EXACT `approval_required` error body, including `error.approval_request`,
 *     which the typed SDK surface does not model as a first-class field.
 *
 *  3. Raw v2 update (`updateApprovalRequest`) — the preview endpoint
 *     `POST /v2/core/approval_requests/{id}/update` (attaches the justification;
 *     Stripe auto-submits the request itself) needs the preview version header
 *     and is not part of the stable typed SDK; we call it directly.
 *
 * NOTE (UNVERIFIED against live Stripe): the precise shape of the
 * `approval_required` error and the update request/response were coded from
 * Stripe's published Approvals docs, not confirmed against a live agent key in
 * this environment. See docs/VERIFICATION.md. Parsing is defensive so that a
 * shape drift surfaces as a clear error rather than a silent wrong branch.
 */

export function makeSdk(key: string = config.secretKey): Stripe {
  return new Stripe(key, {
    apiVersion: config.apiVersion,
    appInfo: { name: 'ai-backoffice-demo', version: '0.1.0' },
  });
}

/** Form-encode nested params the way Stripe's v1 API expects (bracket notation). */
export function formEncode(
  obj: Record<string, unknown>,
  prefix = '',
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const k = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object' && !Array.isArray(value)) {
      parts.push(formEncode(value as Record<string, unknown>, k));
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'object' && item !== null) {
          parts.push(formEncode(item as Record<string, unknown>, `${k}[${i}]`));
        } else {
          parts.push(`${encodeURIComponent(`${k}[${i}]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

export interface RawResponse {
  status: number;
  ok: boolean;
  body: any;
}

/**
 * Make a raw v1 request with the AGENT key. `method` is GET/POST/DELETE.
 * Returns status + parsed body without throwing on 4xx, so the caller can
 * inspect an `approval_required` error explicitly.
 */
export async function agentRequest(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params?: Record<string, unknown>,
): Promise<RawResponse> {
  const url = `${STRIPE_API_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.agentKey}`,
    'Stripe-Version': config.apiVersion,
  };
  let bodyStr: string | undefined;
  if (params && method !== 'GET') {
    bodyStr = formEncode(params);
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const res = await fetch(url, { method, headers, body: bodyStr });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { _raw: text };
  }
  return { status: res.status, ok: res.ok, body };
}

/**
 * Detect and parse an `approval_required` error body.
 * Returns the ApprovalRequestRef when present, else null.
 */
export function parseApprovalRequired(
  resp: RawResponse,
): ApprovalRequestRef | null {
  const err = resp.body?.error;
  if (!err) return null;
  // Stripe signals this as an invalid_request_error whose code/approval_request
  // identify the created (but unsubmitted) approval request.
  const ar = err.approval_request;
  const looksLikeApproval =
    err.code === 'approval_required' ||
    err.type === 'approval_required' ||
    !!ar;
  if (!looksLikeApproval || !ar) return null;
  return {
    id: ar.id,
    action: ar.action ?? 'unknown',
    status: ar.status ?? 'unknown',
    dashboardUrl: ar.dashboard_url,
    expiresAt: ar.expires_at,
  };
}

/**
 * Attach the agent's justification to an approval request (M3 step 5).
 *
 * Current Stripe docs: when an agent-tagged key hits an approval rule, Stripe
 * returns `approval_required` AND automatically submits the approval request to
 * review. There is no separate `/submit` call and no "unsubmitted lapses in 24h"
 * step in the current docs. To attach the reason the agent calls
 * `POST /v2/core/approval_requests/{id}/update` with the preview version header
 * and a `reason` body. (Corrected from the earlier `/submit` + 2026-06-24.preview
 * spec.)
 */
export async function updateApprovalRequest(
  approvalRequestId: string,
  reason: string,
): Promise<RawResponse> {
  const url = `${STRIPE_API_BASE}/v2/core/approval_requests/${encodeURIComponent(
    approvalRequestId,
  )}/update`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.agentKey}`,
      'Stripe-Version': config.previewVersion,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ reason }),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { _raw: text };
  }
  return { status: res.status, ok: res.ok, body };
}
