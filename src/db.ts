import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DATABASE_PATH ?? './data/contracts.sqlite';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS clinics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email_from TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  name TEXT NOT NULL,
  pdf_path TEXT NOT NULL,
  fields_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  template_id TEXT NOT NULL REFERENCES templates(id),
  patient_record_id TEXT,
  patient_name TEXT NOT NULL,
  patient_age TEXT,
  payer_name TEXT NOT NULL,
  payer_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  signing_token TEXT NOT NULL UNIQUE,
  signed_pdf_path TEXT,
  signed_pdf_sha256 TEXT,
  content_sha256 TEXT,
  completed_at TEXT,
  expires_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contract_values (
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (contract_id, field_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  contract_id TEXT REFERENCES contracts(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  prev_hash TEXT,
  hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Retained copy of a contract's audit trail when the contract is permanently
-- deleted. Evidence must outlive the contract: rows are copied here (with their
-- hash-chain values intact) before the ON DELETE CASCADE removes the originals.
CREATE TABLE IF NOT EXISTS audit_events_archive (
  id TEXT PRIMARY KEY,
  contract_id TEXT,
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  prev_hash TEXT,
  hash TEXT,
  created_at TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One-time email verification code challenge for a signer (hashed, expiring).
CREATE TABLE IF NOT EXISTS signer_challenges (
  contract_id TEXT PRIMARY KEY REFERENCES contracts(id) ON DELETE CASCADE,
  otp_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Session granted after a successful OTP verification; the cookie token maps
-- to a row here and is checked on signing completion.
CREATE TABLE IF NOT EXISTS signer_sessions (
  token TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);

INSERT INTO clinics (id, name, email_from) VALUES
  ('clinic_promis_hay_farm', 'PROMIS Hay Farm', 'PROMIS Hay Farm <signing@docuseal.ink>'),
  ('clinic_promis_london', 'PROMIS London', 'PROMIS London <signing@docuseal.ink>'),
  ('clinic_cardinal', 'Cardinal Clinic', 'Cardinal Clinic <signing@docuseal.ink>')
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  email_from = excluded.email_from;
`);

function hasColumn(table: string, column: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .some((row) => row.name === column);
}

if (!hasColumn('contracts', 'archived_at')) {
  db.prepare('ALTER TABLE contracts ADD COLUMN archived_at TEXT').run();
}

// --- Evidence-hardening migrations (2026) ---------------------------------

// Signing links now expire. Existing contracts get a deadline measured from
// their creation so stale pending links do not stay live forever.
const tokenDays = Number(process.env.SIGNING_TOKEN_DAYS ?? 30);

for (const column of ['signed_pdf_sha256', 'content_sha256', 'expires_at']) {
  if (!hasColumn('contracts', column)) {
    db.prepare(`ALTER TABLE contracts ADD COLUMN ${column} TEXT`).run();
  }
}
if ((db.prepare('SELECT COUNT(*) AS count FROM contracts WHERE expires_at IS NULL').get() as { count: number }).count > 0) {
  const backfill = db.prepare('UPDATE contracts SET expires_at = ? WHERE id = ?');
  for (const row of db.prepare('SELECT id, created_at FROM contracts WHERE expires_at IS NULL').all() as { id: string; created_at: string }[]) {
    const created = new Date(row.created_at.includes('T') ? row.created_at : row.created_at.replace(' ', 'T') + 'Z');
    backfill.run(row.id, new Date(created.getTime() + tokenDays * 86_400_000).toISOString());
  }
}

export type TemplateField = {
  id: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'signature' | 'checkbox';
  required: boolean;
  source?: 'patientName' | 'patientAge' | 'payerName' | 'payerEmail' | 'manual';
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type TemplateRecord = {
  id: string;
  clinic_id: string;
  name: string;
  pdf_path: string;
  fields_json: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export type AuditEventRecord = {
  id: string;
  contract_id: string | null;
  actor: string;
  event_type: string;
  ip: string | null;
  user_agent: string | null;
  data_json: string;
  prev_hash: string | null;
  hash: string | null;
  created_at: string;
};

export type ClinicRecord = {
  id: string;
  name: string;
  email_from: string | null;
  created_at: string;
};

export type ContractRecord = {
  id: string;
  clinic_id: string;
  template_id: string;
  patient_record_id: string | null;
  patient_name: string;
  patient_age: string | null;
  payer_name: string;
  payer_email: string;
  status: string;
  signing_token: string;
  signed_pdf_path: string | null;
  signed_pdf_sha256: string | null;
  content_sha256: string | null;
  completed_at: string | null;
  expires_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export function fieldsFor(template: TemplateRecord): TemplateField[] {
  return JSON.parse(template.fields_json) as TemplateField[];
}
