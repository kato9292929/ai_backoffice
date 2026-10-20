import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { log } from './logger.js';
import { appendAudit } from './audit-store.js';
import { POOL_CHARGE_HANDLE, chargeByHandle, customerId, loadSeedManifest } from './manifest.js';
import { appendRequestLog, newRunId } from './request-log.js';
import {
  agentRequest,
  classifyBody,
  classifyResponse,
  listApprovalRequests,
  type Classified,
} from './stripe-client.js';
import { McpHttpError, StripeMcp, buildApiWriteArgs, inspectToolResult } from './mcp-client.js';
import { buildJustification } from './agent/justification.js';
import { attachJustification } from './agent/propose.js';
import type { ActionPlan, Inquiry, Route } from './types.js';

/**
 * M10 — the same refund proposed through two client paths, side by side:
 *
 *   cli : direct HTTP to api.stripe.com with the agent key (the existing path)
 *   mcp : Stripe MCP (https://mcp.stripe.com), agent key as Bearer, tool
 *         `stripe_api_write` → POST /v1/refunds
 *
 * For each path we record: did it return approval_required, was an approval
 * request created (cross-checked against the v2 list API when the secret key is
 * set), and did the MCP side return a confirmation URL (the OAuth path's human
 * confirmation; not expected with an agent key — OAuth itself is out of scope).
 *
 * Both refunds are small partial refunds from the pool charge, so neither
 * consumes an INQ fixture even if a path executes immediately.
 *
 *   npm run demo:mcp -- --amount=1500 [--route=both|cli|mcp]
 */

const COMPARE_LOG = 'logs/route-compare.jsonl';
const TOOLS_DUMP = 'logs/mcp-tools.json';

function value(name: string, fallback: string): string {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : fallback;
}

interface RouteResult {
  route: Route;
  httpStatus?: number;
  toolIsError?: boolean;
  classified: Classified | null;
  approvalRequestId?: string;
  newApprovalRequests?: string[] | 'unknown';
  confirmationUrls: string[];
  note?: string;
  raw?: unknown;
}

async function approvalIdsSnapshot(): Promise<Set<string> | null> {
  try {
    const r = await listApprovalRequests();
    return r.ok ? new Set(r.data.map((x) => x.id as string)) : null;
  } catch {
    return null; // secret key not set, or list not available
  }
}

async function main(): Promise<void> {
  const amount = Number(value('amount', '1500'));
  const which = value('route', 'both');
  const routes: Route[] = which === 'both' ? ['cli', 'mcp'] : [which as Route];
  const manifest = loadSeedManifest();
  const pool = chargeByHandle(manifest, POOL_CHARGE_HANDLE);
  const customer = customerId(manifest, pool.customerHandle);
  const runId = newRunId('routes');
  const params = {
    payment_intent: pool.paymentIntentId,
    amount,
    metadata: { demo_action: 'route_compare', demo_run: runId },
  };

  log.section(`M10 経路比較 — 返金 ¥${amount} (run ${runId})`);
  const results: RouteResult[] = [];

  for (const route of routes) {
    log.section(`route: ${route}`);
    const before = await approvalIdsSnapshot();
    let r: RouteResult;
    try {
      r = route === 'cli' ? await viaCli(params) : await viaMcp(params);
    } catch (err) {
      const e = err as Error;
      r = {
        route,
        classified: null,
        confirmationUrls: [],
        note: e instanceof McpHttpError
          ? `HTTP ${e.status} www-authenticate=${e.wwwAuthenticate ?? '-'}`
          : e.message,
        raw: e instanceof McpHttpError ? e.body : undefined,
        httpStatus: e instanceof McpHttpError ? e.status : undefined,
      };
      log.error(`${route} failed`, r.note);
    }
    const after = before ? await approvalIdsSnapshot() : null;
    r.newApprovalRequests = before && after ? [...after].filter((id) => !before.has(id)) : 'unknown';

    const scenario = `ROUTE-${route.toUpperCase()}`;
    appendRequestLog({
      timestamp: new Date().toISOString(),
      runId,
      route,
      kind: route === 'mcp' ? 'mcp_tool_call' : 'action',
      scenario,
      action: 'create_refund',
      amount,
      httpStatus: r.httpStatus,
      outcome: r.classified?.outcome ?? 'error',
      approvalRequestId: r.approvalRequestId,
      blockEvidence: r.classified?.blockEvidence,
      raw: r.raw,
      note: r.note,
    });

    if (r.classified?.outcome === 'approval_required' && r.classified.approval) {
      const inquiry: Inquiry = {
        id: scenario,
        customerRef: pool.customerHandle,
        text: '(経路比較: 同一返金を CLI / MCP の2経路で起案)',
        expectation: 'M10',
      };
      const p: ActionPlan = {
        action: 'create_refund',
        targetId: pool.chargeId,
        amount,
        currency: pool.currency,
        rationale: {
          customerId: customer.id,
          reasonCode: 'route_compare_test',
          summary: `経路比較デモ (${runId}, route=${route})。承認せず却下または取消してよい。`,
        },
        expectedGated: true,
      };
      const justification = buildJustification(inquiry, p);
      const attached = await attachJustification(r.classified.approval, justification, {
        runId,
        route,
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
        route,
        events: [],
        finalResult: attached.ok ? 'proposed' : 'failed',
      });
    }
    results.push(r);
  }

  log.section('経路比較');
  console.log(['route', 'HTTP', 'outcome', 'approval_required', '新規 approval request', '確認URL'].join('\t'));
  for (const r of results) {
    const created =
      r.newApprovalRequests === 'unknown'
        ? r.approvalRequestId
          ? `あり(${r.approvalRequestId}) ※list未確認`
          : '不明(list不可)'
        : r.newApprovalRequests!.length
          ? `あり(${r.newApprovalRequests!.join(',')})`
          : 'なし';
    console.log(
      [
        r.route,
        r.httpStatus ?? '-',
        r.classified?.outcome ?? 'error',
        r.classified?.outcome === 'approval_required' ? 'yes' : 'no',
        created,
        r.confirmationUrls.length ? r.confirmationUrls.join(' ') : 'なし',
      ].join('\t'),
    );
  }
  if (!existsSync('logs')) mkdirSync('logs', { recursive: true });
  appendFileSync(
    COMPARE_LOG,
    JSON.stringify({ timestamp: new Date().toISOString(), runId, amount, results }) + '\n',
    'utf8',
  );
  log.ok(`比較結果 → ${COMPARE_LOG}`);
}

async function viaCli(params: Record<string, unknown>): Promise<RouteResult> {
  const resp = await agentRequest('POST', '/v1/refunds', params);
  const c = classifyResponse(resp);
  log.info(`cli: HTTP ${resp.status} → ${c.outcome}`);
  return {
    route: 'cli',
    httpStatus: resp.status,
    classified: c,
    approvalRequestId: c.approval?.id,
    confirmationUrls: [],
    raw: resp.body,
  };
}

async function viaMcp(params: Record<string, unknown>): Promise<RouteResult> {
  const mcp = new StripeMcp();
  const init = await mcp.initialize();
  log.info(`mcp: initialized (${init?.serverInfo?.name ?? '?'} ${init?.serverInfo?.version ?? ''})`);
  const tools = await mcp.listTools();
  if (!existsSync('logs')) mkdirSync('logs', { recursive: true });
  writeFileSync(TOOLS_DUMP, JSON.stringify(tools, null, 2) + '\n', 'utf8');
  log.info(`mcp: ${tools.length} tools (schemas → ${TOOLS_DUMP})`);
  const write = tools.find((t) => t.name === 'stripe_api_write');
  if (!write) {
    log.warn('stripe_api_write not advertised — the key may lack write permission (server filters tools by RAK permissions)');
  }
  const args = buildApiWriteArgs(write, { method: 'POST', path: '/v1/refunds', params });
  const result = await mcp.callTool('stripe_api_write', args);
  const seen = inspectToolResult(result);
  // The tool reports Stripe errors inside its result, not as an HTTP status.
  const body = seen.json ?? {};
  const isErrBody = !!body?.error || !!result.isError;
  const c = classifyBody(body, isErrBody ? 400 : 200, !isErrBody);
  const approvalRequestId = c.approval?.id ?? seen.approvalIds[0];
  // Only links that could be the OAuth path's human-confirmation step: drop
  // docs links and the approval request's own dashboard_url (that is the
  // Approvals review page, which both routes share).
  const confirmationUrls = seen.urls.filter(
    (u) => !/docs\.stripe\.com/.test(u) && u !== c.approval?.dashboardUrl,
  );
  log.info(
    `mcp: isError=${!!result.isError} → ${c.outcome}` +
      (approvalRequestId ? ` approval=${approvalRequestId}` : '') +
      (confirmationUrls.length ? ` urls=${confirmationUrls.join(' ')}` : ''),
  );
  return {
    route: 'mcp',
    httpStatus: 200,
    toolIsError: !!result.isError,
    classified: c,
    approvalRequestId,
    confirmationUrls,
    raw: { args, result },
  };
}

main().catch((err) => {
  log.error('route compare failed', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
