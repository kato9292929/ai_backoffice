import { config } from './config.js';

/**
 * Minimal MCP client for the Stripe remote MCP server (M10), over Streamable
 * HTTP with JSON-RPC 2.0. Dependency-free on purpose: the demo needs to see
 * the raw tool results (approval_required bodies, confirmation URLs), and
 * only initialize / tools/list / tools/call are used.
 *
 * Auth: the agent-tagged key as `Authorization: Bearer` (docs: "Stripe MCP").
 * From December 2026 Stripe MCP rejects keys without the Agent tag with 401 +
 * an OAuth discovery challenge — surfaced verbatim via McpHttpError.
 *
 * UNVERIFIED against live Stripe: tool input schemas are served by the server
 * at runtime (tools/list); `buildApiWriteArgs` maps our refund onto whatever
 * shape `stripe_api_write` advertises and fails loudly if it cannot.
 */

const PROTOCOL_VERSION = '2025-06-18';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, any>; required?: string[] };
}

export interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export class McpHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly wwwAuthenticate?: string,
  ) {
    super(`MCP HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

export class StripeMcp {
  private sessionId?: string;
  private nextId = 1;

  constructor(
    private readonly key: string = config.agentKey,
    private readonly url: string = config.mcpUrl,
  ) {}

  private async post(payload: Record<string, unknown>): Promise<any> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
      headers['MCP-Protocol-Version'] = PROTOCOL_VERSION;
    }
    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(payload) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const text = await res.text();
    if (!res.ok) {
      throw new McpHttpError(res.status, text, res.headers.get('www-authenticate') ?? undefined);
    }
    if (!('id' in payload)) return undefined; // notification: 202, no body
    const ctype = res.headers.get('content-type') ?? '';
    const messages = ctype.includes('text/event-stream') ? parseSse(text) : [JSON.parse(text)];
    const reply = messages.find((m) => m?.id === payload.id);
    if (!reply) throw new Error(`MCP: no JSON-RPC reply for id ${payload.id}: ${text.slice(0, 300)}`);
    if (reply.error) throw new Error(`MCP JSON-RPC error ${JSON.stringify(reply.error)}`);
    return reply.result;
  }

  private request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return this.post({ jsonrpc: '2.0', id: this.nextId++, method, params });
  }

  async initialize(): Promise<any> {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ai-backoffice-demo', version: '0.1.0' },
    });
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return result;
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.request('tools/list');
    return (result?.tools as McpTool[]) ?? [];
  }

  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return this.request('tools/call', { name, arguments: args });
  }
}

function parseSse(text: string): any[] {
  const out: any[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      /* keep-alive / non-JSON frame */
    }
  }
  return out;
}

/**
 * Build `stripe_api_write` arguments for a v1 POST from the tool's advertised
 * schema. STRIPE_MCP_WRITE_ARGS (a JSON template; "{{params}}" is replaced by
 * the params object) overrides the heuristic once the live schema is known.
 */
export function buildApiWriteArgs(
  tool: McpTool | undefined,
  call: { method: 'POST'; path: string; params: Record<string, unknown> },
): Record<string, unknown> {
  const override = process.env.STRIPE_MCP_WRITE_ARGS?.trim();
  if (override) {
    return JSON.parse(
      override
        .replace('"{{params}}"', JSON.stringify(call.params))
        .replace('{{path}}', call.path)
        .replace('{{method}}', call.method),
    );
  }
  const props = Object.keys(tool?.inputSchema?.properties ?? {});
  // Live schema (2026-10-27): { stripe_api_operation_id, parameters,
  // human_confirmation }. Operation ids follow Stripe's OpenAPI naming:
  // POST /v1/refunds → PostRefunds, POST /v1/credit_notes → PostCreditNotes.
  if (props.includes('stripe_api_operation_id') && props.includes('parameters')) {
    return { stripe_api_operation_id: operationId(call.method, call.path), parameters: call.params };
  }
  const pick = (cands: string[]) => cands.find((c) => props.includes(c));
  const methodKey = pick(['method', 'http_method', 'httpMethod']);
  const pathKey = pick(['path', 'endpoint', 'url', 'resource']);
  const paramsKey = pick(['params', 'body', 'parameters', 'data', 'arguments', 'payload']);
  if (pathKey && paramsKey) {
    const args: Record<string, unknown> = { [pathKey]: call.path, [paramsKey]: call.params };
    if (methodKey) args[methodKey] = call.method;
    return args;
  }
  throw new Error(
    'stripe_api_write の入力スキーマを自動対応できない。logs/mcp-tools.json のスキーマを見て ' +
      'STRIPE_MCP_WRITE_ARGS に JSON テンプレートを設定する（例: ' +
      '{"method":"{{method}}","path":"{{path}}","params":"{{params}}"}）。advertised properties: ' +
      JSON.stringify(props),
  );
}

/** Pull what matters out of a tool result: parsed JSON body (if the text is
 * JSON), any URLs (OAuth-path confirmation links), approval request ids. */
export function inspectToolResult(result: McpToolResult): {
  text: string;
  json: any;
  urls: string[];
  approvalIds: string[];
} {
  const text = (result.content ?? [])
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text!)
    .join('\n');
  let json: any = result.structuredContent ?? null;
  if (!json) {
    try {
      json = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          json = JSON.parse(m[0]);
        } catch {
          json = null;
        }
      }
    }
  }
  const urls = [...new Set(text.match(/https?:\/\/[^\s"'<>)]+/g) ?? [])];
  const approvalIds = [...new Set(text.match(/\b(?:apreq|areq)_(?:test_)?[A-Za-z0-9]+/g) ?? [])];
  return { text, json, urls, approvalIds };
}

/** Stripe OpenAPI operation id for a literal v1 path (no path params). */
export function operationId(method: string, path: string): string {
  const pascal = path
    .replace(/^\/v1\//, '')
    .split(/[/_]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join('');
  return method[0]!.toUpperCase() + method.slice(1).toLowerCase() + pascal;
}
