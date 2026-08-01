import { readLatestByKey } from './audit-store.js';
import type { AuditRecord } from './types.js';

/**
 * Read-only renderer for the audit log. `npm run audit` prints the current
 * state of every proposal as a compact table; `npm run audit -- --json` dumps
 * the collapsed latest snapshots.
 */

function fmtAmount(r: AuditRecord): string {
  if (r.amount === undefined) return '-';
  const cur = (r.currency ?? 'jpy').toUpperCase();
  return cur === 'JPY' ? `¥${r.amount.toLocaleString('ja-JP')}` : `${r.amount} ${cur}`;
}

function fmtEvents(r: AuditRecord): string {
  if (r.events.length === 0) return '(no events)';
  return r.events.map((e) => e.status).join(' → ');
}

function main(): void {
  const json = process.argv.includes('--json');
  const latest = [...readLatestByKey().values()].sort((a, b) =>
    a.fixtureId.localeCompare(b.fixtureId),
  );

  if (latest.length === 0) {
    console.log('No audit records yet. Run `npm run propose` first.');
    return;
  }

  if (json) {
    console.log(JSON.stringify(latest, null, 2));
    return;
  }

  console.log('');
  console.log(
    ['fixture', 'action', 'amount', 'final', 'events'].join('\t'),
  );
  console.log('─'.repeat(80));
  for (const r of latest) {
    console.log(
      [r.fixtureId, r.action, fmtAmount(r), r.finalResult, fmtEvents(r)].join('\t'),
    );
  }
  console.log('');

  // Highlight any rule-not-enforced records loudly.
  const notEnforced = latest.filter((r) => r.finalResult === 'rule_not_enforced');
  if (notEnforced.length) {
    console.log(
      `⚠ ${notEnforced.length} gated action(s) executed WITHOUT approval: ` +
        notEnforced.map((r) => r.fixtureId).join(', '),
    );
  }
}

main();
