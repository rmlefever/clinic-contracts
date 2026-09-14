import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The DB path must be set before the app modules (which open the database at
// import time) are loaded, so they are imported dynamically.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contracts-audit-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.sqlite');

const { audit, verifyAuditChain } = await import('../src/audit.js');
const { db } = await import('../src/db.js');

// Realistic events reference real rows (audit_events.contract_id has an FK), so
// seed minimal clinic/template/contract records first.
db.prepare("INSERT OR IGNORE INTO clinics (id, name) VALUES ('clinic_test', 'Test Clinic')").run();
db.prepare("INSERT OR IGNORE INTO templates (id, clinic_id, name, pdf_path) VALUES ('tpl_test', 'clinic_test', 'Test Template', '/tmp/test.pdf')").run();
for (const id of ['ctr_a', 'ctr_b', 'ctr_c']) {
  db.prepare(`
    INSERT OR IGNORE INTO contracts (id, clinic_id, template_id, patient_name, payer_name, payer_email, signing_token)
    VALUES (?, 'clinic_test', 'tpl_test', 'Test Patient', 'Test Payer', 'payer@example.com', ?)
  `).run(id, `token_${id}`);
}

test('audit events form a verifiable hash chain', () => {
  audit({ contractId: 'ctr_a', actor: 'system', eventType: 'contract.created', data: { foo: 1 } });
  audit({ contractId: 'ctr_a', actor: 'signer', eventType: 'contract.opened', ip: '10.0.0.1', userAgent: 'test' });
  audit({ contractId: 'ctr_b', actor: 'signer', eventType: 'identity.verified', ip: '10.0.0.1' });

  const result = verifyAuditChain();
  assert.equal(result.ok, true, `chain should verify: ${JSON.stringify(result)}`);
  assert.equal(result.eventCount, 3);
});

test('tampering with an event breaks the chain and is detectable', () => {
  const before = verifyAuditChain();
  assert.equal(before.ok, true);

  // Retroactively edit an old event's payload.
  db.prepare("UPDATE audit_events SET data_json = '{\"foo\":2}' WHERE event_type = 'contract.created'").run();
  const tampered = verifyAuditChain();
  assert.equal(tampered.ok, false);
  assert.equal(tampered.firstBadId, (db.prepare("SELECT id FROM audit_events WHERE event_type = 'contract.created'").get() as { id: string }).id);

  // A later valid event does not repair the chain.
  audit({ contractId: 'ctr_c', actor: 'admin', eventType: 'contract.archived' });
  const still = verifyAuditChain();
  assert.equal(still.ok, false);
});

test('deleting an event from the middle breaks the chain', () => {
  // Restore a clean chain: rebuild by clearing and re-auditing.
  db.prepare('DELETE FROM audit_events').run();
  audit({ actor: 'system', eventType: 'app.started' });
  audit({ contractId: 'ctr_a', actor: 'signer', eventType: 'identity.verified', ip: '10.0.0.1' });
  audit({ contractId: 'ctr_a', actor: 'signer', eventType: 'contract.completed' });
  assert.equal(verifyAuditChain().ok, true);

  // Remove the middle event — the next event's prev_hash now dangles.
  db.prepare("DELETE FROM audit_events WHERE event_type = 'identity.verified'").run();
  assert.equal(verifyAuditChain().ok, false);
});
