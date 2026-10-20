import { config } from './config.js';
import { readRequestLog, type RequestLogLine } from './request-log.js';

/**
 * Print logged raw responses as redacted Markdown, ready to paste into
 * docs/live-verification.md (B-2 approval_required, B-4 update, B-9 Block…).
 *
 *   npm run evidence -- [--run=<runId>] [--outcome=blocked] [--kind=approval_update] [--last=5]
 *
 * Redaction: API keys / webhook secrets (sk_, rk_, pk_, whsec_), emails, and
 * name/email/phone/address fields are masked; customer ids keep only their
 * last 4 characters. Object ids that are not personal (re_, apreq_, …) stay.
 */

const SECRET_RE = /\b(sk|rk|pk)_(test|live)_[A-Za-z0-9]+|\bwhsec_[A-Za-z0-9]+/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CUS_RE = /\bcus_[A-Za-z0-9]+/g;
const PERSONAL_KEYS = new Set(['name', 'email', 'phone', 'address', 'shipping', 'receipt_email']);

export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(SECRET_RE, (m) => (m.startsWith('whsec_') ? 'whsec_***' : `${m.split('_').slice(0, 2).join('_')}_***`))
      .replace(EMAIL_RE, '***@***')
      .replace(CUS_RE, (m) => `cus_…${m.slice(-4)}`);
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = PERSONAL_KEYS.has(k) && v !== null ? '***' : redact(v);
    }
    return out;
  }
  return value;
}

function value(name: string): string | undefined {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a?.slice(name.length + 3);
}

function render(l: RequestLogLine): string {
  const head =
    `#### ${l.timestamp} — ${l.scenario} (${l.route}, ${l.kind})\n\n` +
    `- Stripe-Version: v1 \`${config.apiVersion}\` / v2 \`${config.previewVersion}\`\n` +
    `- HTTP ${l.httpStatus ?? '-'} → **${l.outcome}**` +
    (l.ruleSet ? ` (rule-set: ${l.ruleSet})` : '') +
    (l.blockEvidence ? ` — block evidence: \`${redact(l.blockEvidence)}\`` : '') +
    '\n' +
    (l.stripeRequestId ? `- Request-Id: \`${l.stripeRequestId}\`\n` : '') +
    (l.note ? `- note: ${redact(l.note)}\n` : '');
  return `${head}\n\`\`\`json\n${JSON.stringify(redact(l.raw ?? null), null, 2)}\n\`\`\`\n`;
}

function main(): void {
  let lines = readRequestLog();
  const run = value('run');
  const outcome = value('outcome');
  const kind = value('kind');
  if (run) lines = lines.filter((l) => l.runId === run);
  if (outcome) lines = lines.filter((l) => l.outcome === outcome);
  if (kind) lines = lines.filter((l) => l.kind === kind);
  const last = Number(value('last') ?? '10');
  lines = lines.slice(-last);
  if (lines.length === 0) {
    console.log('(該当する記録なし — logs/requests.jsonl)');
    return;
  }
  console.log(lines.map(render).join('\n'));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
