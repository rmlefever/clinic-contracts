import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { db, type AuditEventRecord } from './db.js';

// --- Hash-chained audit log -------------------------------------------------
//
// Every event stores sha256(prev_hash + canonical_json(event)), so any
// retroactive edit or deletion anywhere in the table is detectable by
// re-walking the chain (verifyAuditChain). The chain spans ALL events,
// regardless of contract, ordered by insertion (rowid).

const GENESIS_PREV = '';

/** Deterministic JSON serialisation with fixed key order (never reorder — it would break every existing hash). */
function canonicalJson(record: Omit<AuditEventRecord, 'prev_hash' | 'hash'>): string {
  return JSON.stringify({
    id: record.id,
    contract_id: record.contract_id,
    actor: record.actor,
    event_type: record.event_type,
    ip: record.ip,
    user_agent: record.user_agent,
    data_json: record.data_json,
    created_at: record.created_at
  });
}

export function eventHash(record: Omit<AuditEventRecord, 'prev_hash' | 'hash'>, prevHash: string): string {
  return createHash('sha256').update(prevHash + canonicalJson(record)).digest('hex');
}

// Migration for databases created before chaining: add the columns and
// backfill the chain over existing rows in insertion order.
{
  const hasHash = (db.prepare('PRAGMA table_info(audit_events)').all() as { name: string }[])
    .some((row) => row.name === 'hash');
  if (!hasHash) {
    db.prepare('ALTER TABLE audit_events ADD COLUMN prev_hash TEXT').run();
    db.prepare('ALTER TABLE audit_events ADD COLUMN hash TEXT').run();
  }
  const unchained = db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE hash IS NULL').get() as { count: number };
  if (unchained.count > 0) {
    db.transaction(() => {
      let prev = GENESIS_PREV;
      for (const row of db.prepare('SELECT * FROM audit_events ORDER BY rowid ASC').all() as AuditEventRecord[]) {
        const hash = eventHash(row, prev);
        db.prepare('UPDATE audit_events SET prev_hash = ?, hash = ? WHERE id = ?').run(prev, hash, row.id);
        prev = hash;
      }
    })();
  }
}

export function audit(input: {
  contractId?: string;
  actor: string;
  eventType: string;
  ip?: string;
  userAgent?: string;
  data?: unknown;
}) {
  const record: Omit<AuditEventRecord, 'prev_hash' | 'hash'> = {
    id: `evt_${nanoid(12)}`,
    contract_id: input.contractId ?? null,
    actor: input.actor,
    event_type: input.eventType,
    ip: input.ip ?? null,
    user_agent: input.userAgent ?? null,
    data_json: JSON.stringify(input.data ?? {}),
    created_at: new Date().toISOString()
  };

  db.transaction(() => {
    const prev = (db.prepare('SELECT hash FROM audit_events ORDER BY rowid DESC LIMIT 1').get() as { hash: string | null } | undefined)?.hash ?? GENESIS_PREV;
    const hash = eventHash(record, prev);
    db.prepare(`
      INSERT INTO audit_events (id, contract_id, actor, event_type, ip, user_agent, data_json, prev_hash, hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.id, record.contract_id, record.actor, record.event_type, record.ip, record.user_agent, record.data_json, prev, hash, record.created_at);
  })();
}

export function verifyAuditChain(): { ok: boolean; eventCount: number; firstBadId: string | null } {
  const rows = db.prepare('SELECT * FROM audit_events ORDER BY rowid ASC').all() as AuditEventRecord[];
  let prev = GENESIS_PREV;
  for (const row of rows) {
    if (row.prev_hash !== prev || eventHash(row, row.prev_hash ?? GENESIS_PREV) !== row.hash) {
      return { ok: false, eventCount: rows.length, firstBadId: row.id };
    }
    prev = row.hash ?? GENESIS_PREV;
  }
  return { ok: true, eventCount: rows.length, firstBadId: null };
}

/** Copy a contract's full audit trail (with chain values) to the archive table. Called before permanent deletion. */
export function archiveContractAudit(contractId: string) {
  db.prepare(`
    INSERT OR REPLACE INTO audit_events_archive
      (id, contract_id, actor, event_type, ip, user_agent, data_json, prev_hash, hash, created_at)
    SELECT id, contract_id, actor, event_type, ip, user_agent, data_json, prev_hash, hash, created_at
    FROM audit_events WHERE contract_id = ?
  `).run(contractId);
}
