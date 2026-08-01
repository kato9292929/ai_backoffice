import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditRecord } from './types.js';

/**
 * Append-only JSONL audit log (M4).
 *
 * Every record is written once at propose time and then RE-appended (not
 * mutated in place) each time its state changes. The file is therefore a true
 * event log: the last record for a given approvalRequest id is authoritative.
 * This keeps the format append-only and crash-safe — we never rewrite history.
 */

export const AUDIT_LOG_PATH = 'logs/audit.jsonl';

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Append one record snapshot to the JSONL log. */
export function appendAudit(
  record: AuditRecord,
  path: string = AUDIT_LOG_PATH,
): void {
  ensureDir(path);
  appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
}

/** Read every snapshot ever written (chronological). */
export function readAllSnapshots(path: string = AUDIT_LOG_PATH): AuditRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as AuditRecord);
}

/**
 * Collapse the append-only log into the latest snapshot per approval request
 * (or per fixture, for un-gated actions that never got an approvalRequest).
 */
export function readLatestByKey(
  path: string = AUDIT_LOG_PATH,
): Map<string, AuditRecord> {
  const latest = new Map<string, AuditRecord>();
  for (const rec of readAllSnapshots(path)) {
    const key = rec.approvalRequest?.id ?? `fixture:${rec.fixtureId}`;
    latest.set(key, rec);
  }
  return latest;
}

/** Find the most recent snapshot for a given approval-request id. */
export function findByApprovalId(
  approvalId: string,
  path: string = AUDIT_LOG_PATH,
): AuditRecord | undefined {
  let found: AuditRecord | undefined;
  for (const rec of readAllSnapshots(path)) {
    if (rec.approvalRequest?.id === approvalId) found = rec;
  }
  return found;
}
