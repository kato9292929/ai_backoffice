import Stripe from 'stripe';
import { config, STRIPE_API_BASE } from './config.js';
import type { ApprovalRequestRef, RequestOutcome } from './types.js';

/**
 * Stripe access in three flavours:
 *
 *  1. SDK client (`makeSdk`) — used for M1 seeding with the ordinary test key.
 *     The official SDK is convenient for bulk object creation.
 *
 *  2. Raw form-encoded HTTP (`agentRequest`) — used for the proposing agent's
 *     money-moving calls. We deliberately bypass the SDK here so we can read
 *     the EXACT `approval_required` (or Block) error body, including
 *     `error.approval_request`, which the typed SDK surface does not model.
 *
 *  3. Raw v2 JSON (`v2Request`) — the preview approval_request endpoints
 *     (update / list / retrieve / cancel) need the preview version header and
 *     are not part of the stable typed SDK; we call them directly.
 *
 * NOTE (UNVERIFIED against live Stripe): the shapes of the `approval_required`
 * error, the Block error and the v2 responses were coded from Stripe's
 * published docs (re-read 2026-10-20), not confirmed against a live agent key.
 * See docs/live-verification.md. Classification is defensive: anything that is
 * not clearly approval_required / Block is kept as a raw `error`.
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
  /** Stripe's `Request-Id` header — lets a log line be found in Workbench Logs. */
  requestId?: string;
}

async function toRaw(res: Response): Promise<RawResponse> {
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { _raw: text };
  }
  return {
    status: res.status,
    ok: res.ok,
    body,
    requestId: res.headers.get('request-id') ?? undefined,
  };
}

/**
 * Make a raw v1 request with the AGENT key. `method` is GET/POST/DELETE.
 * Returns status + parsed body without throwing on 4xx, so the caller can
 * inspect an `approval_required` / Block error explicitly.
 */
export async function agentRequest(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params?: Record<string, unknown>,
): Promise<RawResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.agentKey}`,
    'Stripe-Version': config.apiVersion,
  };
  let bodyStr: string | undefined;
  if (params && method !== 'GET') {
    bodyStr = formEncode(params);
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const res = await fetch(`${STRIPE_API_BASE}${path}`, { method, headers, body: bodyStr });
  return toRaw(res);
}

/** Raw v2 JSON request with the preview version header. */
export async function v2Request(
  method: 'GET' | 'POST',
  path: string,
  opts: { key?: string; body?: Record<string, unknown> } = {},
): Promise<RawResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.key ?? config.agentKey}`,
    'Stripe-Version': config.previewVersion,
  };
  let bodyStr: string | undefined;
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    bodyStr = JSON.stringify(opts.body ?? {});
  }
  const res = await fetch(`${STRIPE_API_BASE}${path}`, { method, headers, body: bodyStr });
  return toRaw(res);
}

/**
 * Detect and parse an `approval_required` error body.
 * Returns the ApprovalRequestRef when present, else null.
 */
export function parseApprovalRequired(
  resp: RawResponse,
): ApprovalRequestRef | null {
  return parseApprovalRequiredBody(resp.body);
}

/** Same as parseApprovalRequired, for a body that did not come over HTTP
 * directly (e.g. embedded in an MCP tool result). */
export function parseApprovalRequiredBody(body: any): ApprovalRequestRef | null {
  const err = body?.error;
  if (!err) return null;
  // Live shape (2026-10-24, HTTP 403): a flat `error.approval_request_id`
  // string. The nested `error.approval_request` object is the shape the
  // earlier docs implied; still accepted in case it appears.
  const ar = err.approval_request;
  const id: string | undefined = ar?.id ?? err.approval_request_id;
  const looksLikeApproval =
    err.code === 'approval_required' || err.type === 'approval_required' || !!id;
  if (!looksLikeApproval || !id) return null;
  return {
    id,
    action: ar?.action ?? 'unknown',
    status: ar?.status ?? 'unknown',
    dashboardUrl: ar?.dashboard_url,
    expiresAt: ar?.expires_at,
  };
}

/**
 * Detect a Block-rule rejection (B-9). Live (2026-10-25): HTTP 403 with
 * `error.code = "action_blocked"` and no approval request. Kept heuristic in
 * case the wording drifts. We
 * classify as `blocked` when the error carries no approval_request but its
 * code/type/message mentions "block" or "approval rule". Stripe's own API rate
 * limiter (HTTP 429, code `rate_limit`) is explicitly NOT a Block.
 * Returns the matched evidence string, or null. Confirm/adjust after B-9.
 */
export function detectBlock(body: any, status: number): string | null {
  const err = body?.error;
  if (!err || err.approval_request) return null;
  if (status === 429 || err.code === 'rate_limit') return null;
  const fields: Array<[string, unknown]> = [
    ['code', err.code],
    ['type', err.type],
    ['decline_code', err.decline_code],
    ['message', err.message],
  ];
  for (const [name, v] of fields) {
    if (typeof v !== 'string') continue;
    if (/block/i.test(v) || /approval[ _-]?rule/i.test(v)) return `${name}=${v}`;
  }
  return null;
}

export interface Classified {
  outcome: RequestOutcome;
  approval?: ApprovalRequestRef;
  /** Why it was classified as blocked (raw evidence), when outcome=blocked. */
  blockEvidence?: string;
}

/** Map one agent response to executed / approval_required / blocked / error. */
export function classifyBody(body: any, status: number, ok: boolean): Classified {
  const approval = parseApprovalRequiredBody(body);
  if (approval) return { outcome: 'approval_required', approval };
  if (ok) return { outcome: 'executed' };
  const blockEvidence = detectBlock(body, status);
  if (blockEvidence) return { outcome: 'blocked', blockEvidence };
  // Live (2026-10-27): while a request is pending for the same PaymentIntent,
  // another gated attempt gets HTTP 400 with no code and this message.
  if (/already an approval request waiting/i.test(String(body?.error?.message ?? ''))) {
    return { outcome: 'duplicate_pending' };
  }
  return { outcome: 'error' };
}

export function classifyResponse(resp: RawResponse): Classified {
  return classifyBody(resp.body, resp.status, resp.ok);
}

export interface UpdateResult extends RawResponse {
  /** Which path finally answered (`/update` per the guide, `/{id}` per the
   * API reference) — recorded so B-4 can settle the doc discrepancy. */
  pathUsed: string;
  attempts: Array<{ path: string; status: number }>;
}

/**
 * Attach the agent's justification to an approval request (M3 step 5).
 *
 * Stripe auto-submits the approval request to review when it returns
 * `approval_required`; the agent only attaches `reason`. As of 2026-10-20 the
 * docs disagree on the path:
 *   - Set up two-party approvals: POST /v2/core/approval_requests/{id}/update
 *   - API reference (Update an Approval Request): POST /v2/core/approval_requests/{id}
 * Both use Stripe-Version 2026-09-30.preview and a JSON `{ "reason" }` body.
 * Live (2026-10-24): the reference path answers 200, the guide path 404. In
 * `auto` mode we try the reference path first and fall back to the guide
 * path only on a route-level 404 (a 404 whose code is not
 * `approval_request_not_found`, which would mean the id itself is unknown).
 */
export async function updateApprovalRequest(
  approvalRequestId: string,
  reason: string,
): Promise<UpdateResult> {
  const id = encodeURIComponent(approvalRequestId);
  const guidePath = `/v2/core/approval_requests/${id}/update`;
  const refPath = `/v2/core/approval_requests/${id}`;
  const order =
    config.approvalUpdatePath === 'id'
      ? [refPath]
      : config.approvalUpdatePath === 'update'
        ? [guidePath]
        : [refPath, guidePath]; // live 2026-10-24: refPath 200, guidePath 404

  const attempts: UpdateResult['attempts'] = [];
  let last: RawResponse | undefined;
  for (const path of order) {
    last = await v2Request('POST', path, { body: { reason } });
    attempts.push({ path, status: last.status });
    const routeMissing =
      last.status === 404 && last.body?.error?.code !== 'approval_request_not_found';
    if (!routeMissing) return { ...last, pathUsed: path, attempts };
  }
  return { ...last!, pathUsed: order[order.length - 1]!, attempts };
}

/** Retrieve one approval request (used on webhook terminal events).
 * Live (2026-10-24): only the API key that created the request may read it —
 * the account secret key gets 403 `not_authorized` — so default to the agent key. */
export function retrieveApprovalRequest(
  approvalRequestId: string,
  key: string = config.agentKey,
): Promise<RawResponse> {
  return v2Request('GET', `/v2/core/approval_requests/${encodeURIComponent(approvalRequestId)}`, {
    key,
  });
}

/** Cancel a pending approval request (B-5: produces `canceled` without
 * waiting 14 days for `expired`). The requester (agent key) withdraws it. */
export function cancelApprovalRequest(
  approvalRequestId: string,
  key: string = config.agentKey,
): Promise<RawResponse> {
  return v2Request(
    'POST',
    `/v2/core/approval_requests/${encodeURIComponent(approvalRequestId)}/cancel`,
    { key },
  );
}

/** List every approval request (follows next_page_url). Scoped to the
 * requesting key (live: the secret key lists none of the agent's requests). */
export async function listApprovalRequests(
  key: string = config.agentKey,
  maxPages = 20,
): Promise<{ ok: true; data: any[] } | { ok: false; response: RawResponse }> {
  const data: any[] = [];
  let path: string | null = '/v2/core/approval_requests?limit=100';
  for (let i = 0; path && i < maxPages; i++) {
    const resp = await v2Request('GET', path, { key });
    if (!resp.ok) return { ok: false, response: resp };
    data.push(...((resp.body?.data as any[]) ?? []));
    const next: string | null = resp.body?.next_page_url ?? null;
    path = next ? next.replace(STRIPE_API_BASE, '') : null;
  }
  return { ok: true, data };
}
