import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Backward compatibility of the audit hash chain. A database is seeded with
// "old-style" events (contract-scoped, hashed by an independent inline copy of
// the canonical form as it existed before template events were introduced),
// then the current code appends template events on top. Both the pre-existing
// hashes and the whole chain must still verify. If canonicalJson() in
// src/audit.ts ever changes key order, this test fails.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contracts-audit-compat-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.sqlite');

const { db } = await import('../src/db.js');

type OldEvent = { id: string; contract_id: string | null; actor: string; event_type: string; ip: string | null; user_agent: string | null; data_json: string; created_at: string };

/** Independent re-implementation of the pre-change canonical hash. Deliberately not imported from src/audit.ts. */
function legacyHash(prev: string, e: OldEvent): string {
  const canonical = JSON.stringify({
    id: e.id,
    contract_id: e.contract_id,
    actor: e.actor,
    event_type: e.event_type,
    ip: e.ip,
    user_agent: e.user_agent,
    data_json: e.data_json,
    created_at: e.created_at
  });
  return createHash('sha256').update(prev + canonical).digest('hex');
}

db.prepare("INSERT OR IGNORE INTO clinics (id, name) VALUES ('clinic_test', 'Test Clinic')").run();
db.prepare("INSERT OR IGNORE INTO templates (id, clinic_id, name, pdf_path, status) VALUES ('tpl_old', 'clinic_test', 'Old Template', '/nonexistent/old.pdf', 'active')").run();
db.prepare(`
  INSERT OR IGNORE INTO contracts (id, clinic_id, template_id, patient_name, payer_name, payer_email, signing_token)
  VALUES ('ctr_old', 'clinic_test', 'tpl_old', 'Test Patient', 'Test Payer', 'payer@example.com', 'token_old')
`).run();

const legacy: OldEvent[] = [
  { id: 'evt_legacy_1', contract_id: 'ctr_old', actor: 'system', event_type: 'contract.created', ip: null, user_agent: null, data_json: '{"patientRecordId":"PT-9","email":{"sent":true},"expiresAt":"2026-10-01T00:00:00.000Z"}', created_at: '2026-09-01T10:00:00.000Z' },
  { id: 'evt_legacy_2', contract_id: 'ctr_old', actor: 'signer', event_type: 'contract.opened', ip: '203.0.113.5', user_agent: 'Mozilla/5.0', data_json: '{}', created_at: '2026-09-01T10:05:00.000Z' },
  { id: 'evt_legacy_3', contract_id: 'ctr_old', actor: 'signer', event_type: 'contract.completed', ip: '203.0.113.5', user_agent: 'Mozilla/5.0', data_json: '{"consentVersion":"1","identityMethod":"email-otp"}', created_at: '2026-09-01T10:20:00.000Z' }
];
const legacyHashes: string[] = [];
{
  let prev = '';
  const insert = db.prepare('INSERT INTO audit_events (id, contract_id, actor, event_type, ip, user_agent, data_json, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const e of legacy) {
    const hash = legacyHash(prev, e);
    insert.run(e.id, e.contract_id, e.actor, e.event_type, e.ip, e.user_agent, e.data_json, prev, hash, e.created_at);
    legacyHashes.push(hash);
    prev = hash;
  }
}

// Import the audit module only now: its startup migration must leave already-hashed rows alone.
const { audit, verifyAuditChain, eventHash } = await import('../src/audit.js');

test('pre-existing rows are untouched by startup and still verify', () => {
  const rows = db.prepare('SELECT * FROM audit_events ORDER BY rowid ASC').all() as (OldEvent & { hash: string; prev_hash: string })[];
  assert.equal(rows.length, 3);
  rows.forEach((row, i) => assert.equal(row.hash, legacyHashes[i]));
  assert.deepEqual(verifyAuditChain(), { ok: true, eventCount: 3, firstBadId: null });
});

test('the current canonical form reproduces the legacy hashes exactly', () => {
  legacy.forEach((e, i) => assert.equal(eventHash(e, i === 0 ? '' : legacyHashes[i - 1]), legacyHashes[i]));
});

test('template events (contract_id NULL, new data keys) extend the chain without breaking it', () => {
  const actor = 'Jane Doe <jane@clinic.example>';
  audit({ actor, eventType: 'template.uploaded', ip: '100.64.0.1', data: { templateId: 'tpl_new', clinicId: 'clinic_test', name: 'New', pageCount: 4, fileSha256: 'ab'.repeat(32), copiedFieldsFrom: 'tpl_old', fieldCount: 5, actingUser: actor } });
  audit({ actor, eventType: 'template.fields_saved', data: { templateId: 'tpl_new', clinicId: 'clinic_test', fieldCount: 5, fieldIds: ['a', 'b'], status: 'draft', actingUser: actor } });
  audit({ actor, eventType: 'template.status_changed', data: { templateId: 'tpl_new', clinicId: 'clinic_test', from: 'draft', to: 'active', actingUser: actor } });
  audit({ actor, eventType: 'template.renamed', data: { templateId: 'tpl_new', clinicId: 'clinic_test', from: 'New', to: 'Newer', actingUser: actor } });
  audit({ contractId: 'ctr_old', actor, eventType: 'contract.created', ip: '100.64.0.1', data: { patientRecordId: 'PT-10', email: { sent: false }, expiresAt: '2026-11-01T00:00:00.000Z', actingUser: actor } });

  const result = verifyAuditChain();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.eventCount, 8);

  const templateRows = db.prepare("SELECT contract_id, actor FROM audit_events WHERE event_type LIKE 'template.%'").all() as { contract_id: string | null; actor: string }[];
  assert.equal(templateRows.length, 4);
  for (const row of templateRows) {
    assert.equal(row.contract_id, null);
    assert.equal(row.actor, actor);
  }
  // The legacy rows keep their hashes after new events are appended.
  const first = db.prepare("SELECT hash FROM audit_events WHERE id = 'evt_legacy_3'").get() as { hash: string };
  assert.equal(first.hash, legacyHashes[2]);
});

test('editing a legacy row after template events were added is still detected', () => {
  db.prepare("UPDATE audit_events SET actor = 'admin' WHERE id = 'evt_legacy_2'").run();
  const result = verifyAuditChain();
  assert.equal(result.ok, false);
  assert.equal(result.firstBadId, 'evt_legacy_2');
});
