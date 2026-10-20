import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RequestOutcome, Route } from './types.js';

/**
 * Per-request JSONL log (M9): one line per agent request saying whether Stripe
 * executed it, intercepted it with approval_required, or rejected it with a
 * Block rule. Non-2xx bodies are kept RAW (unredacted, local only — logs/ is
 * gitignored) because the Block error shape is still unknown (B-9); use
 * `npm run evidence` to print redacted copies for docs/live-verification.md.
 */

export const REQUEST_LOG_PATH = 'logs/requests.jsonl';

export interface RequestLogLine {
  timestamp: string;
  /** Groups the lines of one CLI invocation (e.g. one runaway run). */
  runId: string;
  route: Route;
  /** What this request was: the gated action, the reason update, an MCP call… */
  kind: 'action' | 'approval_update' | 'approval_cancel' | 'mcp_tool_call';
  /** Fixture id or synthetic label (e.g. "RUNAWAY#3"). */
  scenario: string;
  action: string;
  amount?: number;
  httpStatus?: number;
  outcome: RequestOutcome;
  approvalRequestId?: string;
  stripeRequestId?: string;
  blockEvidence?: string;
  /** Free-form label for the rule configuration under test ("block" / "approval"). */
  ruleSet?: string;
  /** Raw response body for anything that is not a plain success. */
  raw?: unknown;
  note?: string;
}

export function newRunId(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
}

export function appendRequestLog(
  line: RequestLogLine,
  path: string = REQUEST_LOG_PATH,
): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, JSON.stringify(line) + '\n', 'utf8');
}

export function readRequestLog(path: string = REQUEST_LOG_PATH): RequestLogLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as RequestLogLine);
}
