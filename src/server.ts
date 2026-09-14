import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { config } from './config.js';
import { ipAllowed, isInternalIp, isPublicPath, hostFromUrl, requestHost } from './ip-allowlist.js';
import { audit, verifyAuditChain, archiveContractAudit } from './audit.js';
import { db, fieldsFor, type ClinicRecord, type ContractRecord, type TemplateRecord, type TemplateField } from './db.js';
import { sendSigningEmail, sendOtpEmail, sendCompletedEmail } from './email.js';
import { stampSignedPdf } from './pdf.js';
import { generateOtpCode, otpHash, constantTimeEqual, maskEmail } from './otp.js';

fs.mkdirSync(config.uploadDir, { recursive: true });
fs.mkdirSync(config.storageDir, { recursive: true });

const app = Fastify({ logger: true, bodyLimit: 25 * 1024 * 1024, trustProxy: true });
await app.register(cors, { origin: true, credentials: true });
await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
await app.register(fastifyStatic, { root: path.resolve('public'), prefix: '/' });
await app.register(fastifyStatic, { root: config.uploadDir, prefix: '/uploads/', decorateReply: false });
await app.register(fastifyStatic, { root: config.storageDir, prefix: '/storage/', decorateReply: false });

// Admin-surface gate. Signer routes stay public; everything else is reachable
// only from internal networks. The public domain is admin-blocked (the reverse
// proxy routes on Host, so a public request always carries the public host);
// direct tailnet access (Host = the IP) is allowed when the source IP is internal.
// Denials return 404 so the admin surface is invisible, not just forbidden.
const publicHost = hostFromUrl(config.appUrl);
app.addHook('onRequest', async (request, reply) => {
  if (isPublicPath(request.url)) return; // signer flow stays public from anywhere
  if (publicHost && requestHost(request.headers.host) === publicHost) {
    // Public domain: allow admin only from an explicitly allowlisted IP (default none).
    if (config.adminAllowCidrs.length && ipAllowed(request.ip, config.adminAllowCidrs)) return;
    request.log.info({ ip: request.ip, path: request.url.split('?')[0] }, 'admin route blocked: via public domain');
    return reply.code(404).send();
  }
  // Direct access (not the public domain): allow only from internal networks.
  if (isInternalIp(request.ip)) return;
  request.log.info({ ip: request.ip, path: request.url.split('?')[0] }, 'admin route blocked: source ip not internal');
  return reply.code(404).send();
});

function requireAdmin(request: { headers: Record<string, unknown> }) {
  const header = String(request.headers.authorization ?? '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== config.adminToken) {
    const error = new Error('Unauthorized') as Error & { statusCode?: number };
    error.statusCode = 401;
    throw error;
  }
}

// Zod validation failures (e.g. missing consent) are client errors, not 500s.
app.setErrorHandler((error: Error & { issues?: { path: (string | number)[]; message: string }[] }, _request, reply) => {
  if (error.name === 'ZodError') {
    const issues = error.issues ?? [];
    const message = issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') || 'Invalid request body';
    return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message });
  }
  return reply.send(error);
});

function publicTemplate(t: TemplateRecord) {
  return { ...t, fields: fieldsFor(t), fields_json: undefined };
}

// --- Signer evidence: consent, identity verification, link expiry ----------

/** The consent statement presented to the signer and recorded verbatim at completion. Never reword retroactively — bump the version instead. */
export const CONSENT_STATEMENT = 'I confirm that I am the signer named above, that I have read the document shown, and that I consent to sign it electronically with the same effect as a handwritten signature.';
export const CONSENT_VERSION = '1';

const SESSION_COOKIE = 'signer_session';

/** Email OTP is enforced whenever it can actually deliver codes (provider configured and not disabled). */
function otpActive(): boolean {
  return config.signerOtpEnabled && !!config.resendApiKey;
}

function signerSessionValid(request: { cookies: Record<string, string | undefined> }, contractId: string): boolean {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return false;
  const row = db.prepare('SELECT * FROM signer_sessions WHERE token = ?').get(token) as { contract_id: string; expires_at: string } | undefined;
  return !!row && row.contract_id === contractId && row.expires_at > new Date().toISOString();
}

function contractExpired(contract: ContractRecord): boolean {
  return contract.status !== 'completed' && contract.expires_at !== null && contract.expires_at < new Date().toISOString();
}

/** Shared signer-route guards: 404 unknown, 410 archived, 410 expired (logged once). */
function loadSignableContract(token: string): ContractRecord {
  const contract = db.prepare('SELECT * FROM contracts WHERE signing_token = ?').get(token) as ContractRecord | undefined;
  if (!contract) throw Object.assign(new Error('Contract not found'), { statusCode: 404 });
  if (contract.archived_at) throw Object.assign(new Error('Contract has been archived'), { statusCode: 410 });
  if (contractExpired(contract)) {
    const already = db.prepare("SELECT 1 FROM audit_events WHERE contract_id = ? AND event_type = 'contract.expired'").get(contract.id);
    if (!already) audit({ contractId: contract.id, actor: 'system', eventType: 'contract.expired', data: { expiresAt: contract.expires_at } });
    throw Object.assign(new Error('This signing link has expired. Please contact the clinic to have it sent again.'), { statusCode: 410 });
  }
  return contract;
}

app.get('/health', async () => ({ ok: true }));

app.get('/api/clinics', async (request) => {
  return db.prepare('SELECT * FROM clinics ORDER BY name ASC').all() as ClinicRecord[];
});

app.post('/api/clinics', async (request) => {
  requireAdmin(request);
  const body = z.object({
    name: z.string().min(1),
    emailFrom: z.string().optional()
  }).parse(request.body);
  const id = `clinic_${body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}_${nanoid(5)}`;
  db.prepare('INSERT INTO clinics (id, name, email_from) VALUES (?, ?, ?)').run(id, body.name, body.emailFrom ?? null);
  return db.prepare('SELECT * FROM clinics WHERE id = ?').get(id) as ClinicRecord;
});

app.delete('/api/clinics/:id', async (request) => {
  requireAdmin(request);
  const id = (request.params as { id: string }).id;
  const counts = {
    templates: (db.prepare('SELECT COUNT(*) AS count FROM templates WHERE clinic_id = ?').get(id) as { count: number }).count,
    contracts: (db.prepare('SELECT COUNT(*) AS count FROM contracts WHERE clinic_id = ?').get(id) as { count: number }).count
  };
  if (counts.templates || counts.contracts) {
    throw Object.assign(new Error('Clinic has templates or contracts and cannot be deleted'), { statusCode: 400 });
  }
  db.prepare('DELETE FROM clinics WHERE id = ?').run(id);
  return { ok: true };
});

app.get('/api/templates', async (request) => {
  requireAdmin(request);
  const clinicId = (request.query as { clinicId?: string }).clinicId;
  const rows = clinicId
    ? db.prepare('SELECT * FROM templates WHERE clinic_id = ? ORDER BY created_at DESC').all(clinicId) as TemplateRecord[]
    : db.prepare('SELECT * FROM templates ORDER BY created_at DESC').all() as TemplateRecord[];
  return rows.map(publicTemplate);
});

app.post('/api/templates/upload', async (request) => {
  requireAdmin(request);
  const data = await request.file();
  if (!data) throw new Error('PDF file is required');

  const id = `tpl_${nanoid(10)}`;
  const filename = `${id}.pdf`;
  const pdfPath = path.join(config.uploadDir, filename);
  await fsp.writeFile(pdfPath, await data.toBuffer());

  const formFields = data.fields as Record<string, { value?: unknown } | undefined>;
  db.prepare(`
    INSERT INTO templates (id, clinic_id, name, pdf_path)
    VALUES (?, ?, ?, ?)
  `).run(id, String(formFields.clinicId?.value ?? 'clinic_cardinal'), String(formFields.name?.value ?? data.filename), pdfPath);

  return publicTemplate(db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRecord);
});

const fieldSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(['text', 'number', 'date', 'signature', 'checkbox']),
  required: z.boolean().default(true),
  source: z.enum(['patientName', 'patientAge', 'payerName', 'payerEmail', 'manual']).optional(),
  page: z.number().int().positive(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0.005).max(1),
  h: z.number().min(0.005).max(1)
});

app.put('/api/templates/:id/fields', async (request) => {
  requireAdmin(request);
  const body = z.object({ fields: z.array(fieldSchema), status: z.enum(['draft', 'active']).default('active') }).parse(request.body);
  db.prepare('UPDATE templates SET fields_json = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(JSON.stringify(body.fields), body.status, (request.params as { id: string }).id);
  return publicTemplate(db.prepare('SELECT * FROM templates WHERE id = ?').get((request.params as { id: string }).id) as TemplateRecord);
});

app.get('/api/contracts', async (request) => {
  requireAdmin(request);
  const { clinicId, archived } = request.query as { clinicId?: string; archived?: string };
  const archiveClause = archived === 'true' ? 'archived_at IS NOT NULL' : 'archived_at IS NULL';
  if (clinicId) {
    return db.prepare(`SELECT * FROM contracts WHERE clinic_id = ? AND ${archiveClause} ORDER BY created_at DESC LIMIT 200`).all(clinicId);
  }
  return db.prepare(`SELECT * FROM contracts WHERE ${archiveClause} ORDER BY created_at DESC LIMIT 200`).all();
});

const createContractSchema = z.object({
  templateId: z.string(),
  clinicId: z.string().default('clinic_cardinal'),
  patientRecordId: z.string().optional(),
  patientName: z.string().min(1),
  patientAge: z.string().optional(),
  payerName: z.string().min(1),
  payerEmail: z.string().email()
});

app.post('/api/contracts', async (request) => {
  requireAdmin(request);
  const body = createContractSchema.parse(request.body);
  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(body.templateId) as TemplateRecord | undefined;
  if (!template) throw Object.assign(new Error('Template not found'), { statusCode: 404 });
  if (template.status !== 'active') throw Object.assign(new Error('Template must be active before it can be sent'), { statusCode: 400 });
  const clinic = db.prepare('SELECT * FROM clinics WHERE id = ?').get(body.clinicId) as ClinicRecord | undefined;
  if (!clinic) throw Object.assign(new Error('Clinic not found'), { statusCode: 404 });

  const id = `ctr_${nanoid(12)}`;
  const token = nanoid(32);
  const expiresAt = new Date(Date.now() + config.signingTokenDays * 86_400_000).toISOString();
  db.prepare(`
    INSERT INTO contracts
      (id, clinic_id, template_id, patient_record_id, patient_name, patient_age, payer_name, payer_email, signing_token, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, body.clinicId, body.templateId, body.patientRecordId ?? null, body.patientName, body.patientAge ?? null, body.payerName, body.payerEmail, token, expiresAt);

  const fields = fieldsFor(template);
  const values: Record<string, string> = {};
  for (const field of fields) {
    if (field.source === 'patientName') values[field.id] = body.patientName;
    if (field.source === 'patientAge') values[field.id] = body.patientAge ?? '';
    if (field.source === 'payerName') values[field.id] = body.payerName;
    if (field.source === 'payerEmail') values[field.id] = body.payerEmail;
  }
  const insertValue = db.prepare('INSERT OR REPLACE INTO contract_values (contract_id, field_id, value) VALUES (?, ?, ?)');
  for (const [fieldId, value] of Object.entries(values)) insertValue.run(id, fieldId, value);

  const signingUrl = `${config.appUrl}/sign.html?token=${token}`;
  const email = await sendSigningEmail({
    to: body.payerEmail,
    from: clinic.email_from,
    signerName: body.payerName,
    patientName: body.patientName,
    signingUrl,
    clinicName: clinic.name
  });
  audit({ contractId: id, actor: 'system', eventType: 'contract.created', data: { patientRecordId: body.patientRecordId, email, expiresAt } });
  return { ...(db.prepare('SELECT * FROM contracts WHERE id = ?').get(id) as ContractRecord), signingUrl, email };
});

app.get('/api/sign/:token', async (request) => {
  const token = (request.params as { token: string }).token;
  const contract = loadSignableContract(token);
  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(contract.template_id) as TemplateRecord;
  const values = db.prepare('SELECT field_id, value FROM contract_values WHERE contract_id = ?').all(contract.id) as { field_id: string; value: string }[];
  const identityRequired = otpActive();
  audit({ contractId: contract.id, actor: 'signer', eventType: 'contract.opened', ip: request.ip, userAgent: request.headers['user-agent'], data: {} });
  return {
    contract,
    template: publicTemplate(template),
    values: Object.fromEntries(values.map((v) => [v.field_id, v.value])),
    identity: { required: identityRequired, verified: !identityRequired || signerSessionValid(request, contract.id), emailMasked: maskEmail(contract.payer_email) },
    consent: { text: CONSENT_STATEMENT, version: CONSENT_VERSION }
  };
});

/** Record (once) that the signer actually rendered the contract document. */
app.post('/api/sign/:token/viewed', async (request) => {
  const token = (request.params as { token: string }).token;
  const contract = loadSignableContract(token);
  const already = db.prepare("SELECT 1 FROM audit_events WHERE contract_id = ? AND event_type = 'document.viewed'").get(contract.id);
  if (!already) {
    audit({ contractId: contract.id, actor: 'signer', eventType: 'document.viewed', ip: request.ip, userAgent: request.headers['user-agent'], data: {} });
  }
  return { ok: true };
});

/**
 * Signer email verification.
 *   POST /api/sign/:token/otp            -> send a code to the payer's email
 *   POST /api/sign/:token/otp { code }   -> verify the code, grant a session cookie
 */
app.post('/api/sign/:token/otp', async (request, reply) => {
  const token = (request.params as { token: string }).token;
  const body = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code').optional() }).parse(request.body ?? {});
  const contract = loadSignableContract(token);
  if (!otpActive()) return { enabled: false };

  const clinic = db.prepare('SELECT * FROM clinics WHERE id = ?').get(contract.clinic_id) as ClinicRecord;

  if (!body.code) {
    const existing = db.prepare('SELECT * FROM signer_challenges WHERE contract_id = ?').get(contract.id) as { created_at: string } | undefined;
    if (existing && Date.now() - new Date(existing.created_at).getTime() < config.otpResendThrottleSeconds * 1000) {
      throw Object.assign(new Error(`Please wait ${config.otpResendThrottleSeconds} seconds between code requests`), { statusCode: 429 });
    }
    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + config.otpTtlMinutes * 60_000).toISOString();
    db.prepare(`
      INSERT OR REPLACE INTO signer_challenges (contract_id, otp_hash, expires_at, attempts, created_at)
      VALUES (?, ?, ?, 0, ?)
    `).run(contract.id, otpHash(config.adminToken, contract.id, code), expiresAt, new Date().toISOString());
    const email = await sendOtpEmail({ to: contract.payer_email, from: clinic.email_from, signerName: contract.payer_name, code });
    audit({ contractId: contract.id, actor: 'system', eventType: 'identity.challenged', ip: request.ip, userAgent: request.headers['user-agent'], data: { sent: email.sent, to: maskEmail(contract.payer_email) } });
    return { sent: email.sent, reason: email.sent ? undefined : email.reason };
  }

  const challenge = db.prepare('SELECT * FROM signer_challenges WHERE contract_id = ?').get(contract.id) as { otp_hash: string; expires_at: string; attempts: number } | undefined;
  if (!challenge) throw Object.assign(new Error('Request a verification code first'), { statusCode: 400 });
  if (challenge.expires_at < new Date().toISOString()) throw Object.assign(new Error('That code has expired — request a new one'), { statusCode: 400 });
  if (challenge.attempts >= config.otpMaxAttempts) throw Object.assign(new Error('Too many incorrect attempts — request a new code'), { statusCode: 400 });

  if (!constantTimeEqual(otpHash(config.adminToken, contract.id, body.code), challenge.otp_hash)) {
    db.prepare('UPDATE signer_challenges SET attempts = attempts + 1 WHERE contract_id = ?').run(contract.id);
    throw Object.assign(new Error('Incorrect code'), { statusCode: 400 });
  }

  const sessionToken = nanoid(32);
  db.prepare(`
    INSERT INTO signer_sessions (token, contract_id, expires_at)
    VALUES (?, ?, ?)
  `).run(sessionToken, contract.id, new Date(Date.now() + config.signerSessionHours * 3_600_000).toISOString());
  reply.setCookie(SESSION_COOKIE, sessionToken, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.appUrl.startsWith('https://'),
    maxAge: config.signerSessionHours * 3600
  });
  audit({ contractId: contract.id, actor: 'signer', eventType: 'identity.verified', ip: request.ip, userAgent: request.headers['user-agent'], data: { method: 'email-otp' } });
  return { verified: true };
});

app.post('/api/sign/:token/complete', async (request) => {
  const token = (request.params as { token: string }).token;
  const body = z.object({
    values: z.record(z.string()),
    consentAccepted: z.boolean().refine((v) => v, { message: 'Consent to the electronic signing statement is required' })
  }).parse(request.body);
  const contract = loadSignableContract(token);
  if (contract.status === 'completed') throw Object.assign(new Error('Contract is already completed'), { statusCode: 400 });

  if (otpActive() && !signerSessionValid(request, contract.id)) {
    throw Object.assign(new Error('Verify your email before signing'), { statusCode: 403, code: 'identity_required' });
  }

  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(contract.template_id) as TemplateRecord;
  const fields = fieldsFor(template);
  const missing = fields.filter((field) => field.required && !body.values[field.id]);
  if (missing.length) throw Object.assign(new Error(`Missing required fields: ${missing.map((f) => f.label).join(', ')}`), { statusCode: 400 });

  const insertValue = db.prepare('INSERT OR REPLACE INTO contract_values (contract_id, field_id, value) VALUES (?, ?, ?)');
  for (const [fieldId, value] of Object.entries(body.values)) insertValue.run(contract.id, fieldId, value);

  const viewed = db.prepare("SELECT created_at FROM audit_events WHERE contract_id = ? AND event_type = 'document.viewed' LIMIT 1").get(contract.id) as { created_at: string } | undefined;
  const completedAt = new Date().toISOString();
  const signedPdfPath = path.join(config.storageDir, `${contract.id}.signed.pdf`);
  const { contentSha256, fileSha256 } = await stampSignedPdf({
    template,
    contract,
    fields: fields as TemplateField[],
    values: body.values,
    outputPath: signedPdfPath,
    consentText: CONSENT_STATEMENT,
    consentVersion: CONSENT_VERSION,
    signerIp: request.ip,
    viewedAt: viewed?.created_at ?? null,
    completedAt
  });
  db.prepare(`
    UPDATE contracts
    SET status = 'completed', signed_pdf_path = ?, signed_pdf_sha256 = ?, content_sha256 = ?, completed_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(signedPdfPath, fileSha256, contentSha256, completedAt, contract.id);
  audit({
    contractId: contract.id,
    actor: 'signer',
    eventType: 'contract.completed',
    ip: request.ip,
    userAgent: request.headers['user-agent'],
    data: {
      consentText: CONSENT_STATEMENT,
      consentVersion: CONSENT_VERSION,
      contentSha256,
      signedPdfSha256: fileSha256,
      identityMethod: otpActive() ? 'email-otp' : 'unverified'
    }
  });

  // Send the signer their copy of the completed PDF.
  const clinic = db.prepare('SELECT * FROM clinics WHERE id = ?').get(contract.clinic_id) as ClinicRecord;
  let copy: { sent: boolean; reason?: string | null } = { sent: false, reason: 'RESEND_API_KEY is not configured' };
  if (config.resendApiKey) {
    const bytes = await fsp.readFile(signedPdfPath);
    copy = await sendCompletedEmail({
      to: contract.payer_email,
      from: clinic.email_from,
      signerName: contract.payer_name,
      patientName: contract.patient_name,
      pdfBase64: Buffer.from(bytes).toString('base64'),
      pdfName: `${contract.id}.signed.pdf`
    });
  }
  audit({ contractId: contract.id, actor: 'system', eventType: 'contract.copy_sent', data: { sent: copy.sent, reason: copy.sent ? null : copy.reason } });

  return { ok: true, signedPdfUrl: `/storage/${path.basename(signedPdfPath)}`, copySent: copy.sent };
});

app.get('/api/contracts/:id/audit', async (request) => {
  requireAdmin(request);
  return db.prepare('SELECT * FROM audit_events WHERE contract_id = ? ORDER BY created_at ASC').all((request.params as { id: string }).id);
});

/** Re-hash the stored signed PDF and compare with the hash sealed at completion. */
app.get('/api/contracts/:id/verify', async (request) => {
  requireAdmin(request);
  const id = (request.params as { id: string }).id;
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(id) as ContractRecord | undefined;
  if (!contract) throw Object.assign(new Error('Contract not found'), { statusCode: 404 });
  if (!contract.signed_pdf_path || !contract.signed_pdf_sha256) {
    return { checked: false, reason: 'No sealed signed PDF for this contract' };
  }
  let bytes: Buffer;
  try {
    bytes = await fsp.readFile(contract.signed_pdf_path);
  } catch {
    return { checked: true, ok: false, error: 'Signed PDF file is missing from storage', stored: contract.signed_pdf_sha256, actual: null };
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  return { checked: true, ok: actual === contract.signed_pdf_sha256, stored: contract.signed_pdf_sha256, actual };
});

/** Walk the full audit hash chain — detects any retroactive edit or deletion. */
app.get('/api/audit/verify', async (request) => {
  requireAdmin(request);
  return verifyAuditChain();
});

/** Give a pending contract a fresh expiry window (e.g. the link expired and the payer still needs to sign). */
app.post('/api/contracts/:id/extend', async (request) => {
  requireAdmin(request);
  const id = (request.params as { id: string }).id;
  const days = z.number().int().min(1).max(365).catch(config.signingTokenDays).parse((request.body as { days?: number } | undefined)?.days);
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(id) as ContractRecord | undefined;
  if (!contract) throw Object.assign(new Error('Contract not found'), { statusCode: 404 });
  if (contract.status === 'completed') throw Object.assign(new Error('Cannot extend a completed contract'), { statusCode: 400 });

  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  db.prepare('UPDATE contracts SET expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(expiresAt, id);
  audit({ contractId: id, actor: 'admin', eventType: 'contract.extended', ip: request.ip, userAgent: request.headers['user-agent'], data: { days, expiresAt } });
  return db.prepare('SELECT * FROM contracts WHERE id = ?').get(id) as ContractRecord;
});

/** Re-send the signing email for a pending, unexpired contract. */
app.post('/api/contracts/:id/resend', async (request) => {
  requireAdmin(request);
  const id = (request.params as { id: string }).id;
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(id) as ContractRecord | undefined;
  if (!contract) throw Object.assign(new Error('Contract not found'), { statusCode: 404 });
  if (contract.archived_at) throw Object.assign(new Error('Contract has been archived'), { statusCode: 400 });
  if (contract.status === 'completed') throw Object.assign(new Error('Contract is already completed'), { statusCode: 400 });
  if (contractExpired(contract)) throw Object.assign(new Error('This link has expired — extend the contract first'), { statusCode: 400 });

  const clinic = db.prepare('SELECT * FROM clinics WHERE id = ?').get(contract.clinic_id) as ClinicRecord;
  const email = await sendSigningEmail({
    to: contract.payer_email,
    from: clinic.email_from,
    signerName: contract.payer_name,
    patientName: contract.patient_name,
    signingUrl: `${config.appUrl}/sign.html?token=${contract.signing_token}`,
    clinicName: clinic.name
  });
  audit({ contractId: id, actor: 'admin', eventType: 'contract.resent', ip: request.ip, userAgent: request.headers['user-agent'], data: { sent: email.sent, reason: email.sent ? null : email.reason } });
  return { email };
});

app.post('/api/contracts/:id/archive', async (request) => {
  requireAdmin(request);
  const id = (request.params as { id: string }).id;
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(id) as ContractRecord | undefined;
  if (!contract) throw Object.assign(new Error('Contract not found'), { statusCode: 404 });

  db.prepare(`
    UPDATE contracts
    SET archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
  audit({ contractId: id, actor: 'admin', eventType: 'contract.archived', ip: request.ip, userAgent: request.headers['user-agent'], data: {} });
  return db.prepare('SELECT * FROM contracts WHERE id = ?').get(id) as ContractRecord;
});

app.post('/api/contracts/:id/restore', async (request) => {
  requireAdmin(request);
  const id = (request.params as { id: string }).id;
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(id) as ContractRecord | undefined;
  if (!contract) throw Object.assign(new Error('Contract not found'), { statusCode: 404 });

  db.prepare('UPDATE contracts SET archived_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  audit({ contractId: id, actor: 'admin', eventType: 'contract.restored', ip: request.ip, userAgent: request.headers['user-agent'], data: {} });
  return db.prepare('SELECT * FROM contracts WHERE id = ?').get(id) as ContractRecord;
});

app.delete('/api/contracts/:id', async (request) => {
  requireAdmin(request);
  const id = (request.params as { id: string }).id;
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(id) as ContractRecord | undefined;
  if (!contract) throw Object.assign(new Error('Contract not found'), { statusCode: 404 });
  if (!contract.archived_at) {
    throw Object.assign(new Error('Archive the contract before permanent deletion'), { statusCode: 400 });
  }

  // Preserve the evidence: a terminal event with a snapshot of what is being
  // removed, then the full audit trail (with chain hashes) moves to the
  // archive table before the cascade deletes the live rows.
  const values = db.prepare('SELECT field_id, value FROM contract_values WHERE contract_id = ?').all(id) as { field_id: string; value: string }[];
  audit({
    contractId: id,
    actor: 'admin',
    eventType: 'contract.deleted',
    ip: request.ip,
    userAgent: request.headers['user-agent'],
    data: { snapshot: contract, values, signedPdfDeleted: !!contract.signed_pdf_path }
  });
  archiveContractAudit(id);

  db.prepare('DELETE FROM contracts WHERE id = ?').run(id);
  if (contract.signed_pdf_path) {
    await fsp.rm(contract.signed_pdf_path, { force: true });
  }
  return { ok: true };
});

app.listen({ port: config.port, host: '0.0.0.0' });
