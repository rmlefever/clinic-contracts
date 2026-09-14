import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';

// Route tests for the template management API. The app opens its database and
// directories at import time, so the environment is set first and the module
// is imported dynamically. Requests are driven with app.inject(): no port.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contracts-template-api-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
process.env.STORAGE_DIR = path.join(tmpDir, 'storage');
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.APP_URL = 'http://localhost:4321';
process.env.RESEND_API_KEY = '';
process.env.LOG_LEVEL = 'silent';

const { app } = await import('../src/app.js');
const { db } = await import('../src/db.js');
const { verifyAuditChain } = await import('../src/audit.js');

const AUTH = { authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
const ACTOR = 'Jane Doe <jane@clinic.example>';

type Field = { id: string; label: string; type: string; required: boolean; source?: string; page: number; x: number; y: number; w: number; h: number };
type AuditRow = { id: string; contract_id: string | null; actor: string; event_type: string; data_json: string };

async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

/** Build a multipart/form-data body by hand (no form-data dependency). Text fields may come before or after the file. */
function multipart(parts: { fields?: Record<string, string>; file?: { name: string; bytes: Buffer }; fileFirst?: boolean }) {
  const boundary = `----test${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  const text = (name: string, value: string) => {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  };
  const file = () => {
    if (!parts.file) return;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${parts.file.name}"\r\nContent-Type: application/pdf\r\n\r\n`));
    chunks.push(parts.file.bytes, Buffer.from('\r\n'));
  };
  if (parts.fileFirst) file();
  for (const [k, v] of Object.entries(parts.fields ?? {})) text(k, v);
  if (!parts.fileFirst) file();
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function upload(opts: { name?: string; clinicId?: string; copyFieldsFrom?: string; pages?: number; bytes?: Buffer; actor?: string | null; fileFirst?: boolean }) {
  const fields: Record<string, string> = {};
  if (opts.name !== undefined) fields.name = opts.name;
  if (opts.clinicId !== undefined) fields.clinicId = opts.clinicId;
  if (opts.copyFieldsFrom !== undefined) fields.copyFieldsFrom = opts.copyFieldsFrom;
  const body = multipart({ fields, file: { name: 'contract.pdf', bytes: opts.bytes ?? await makePdf(opts.pages ?? 2) }, fileFirst: opts.fileFirst });
  const headers: Record<string, string> = { ...AUTH, ...body.headers };
  if (opts.actor !== null) headers['x-acting-user'] = opts.actor ?? ACTOR;
  return app.inject({ method: 'POST', url: '/api/templates/upload', headers, payload: body.payload });
}

function field(overrides: Partial<Field> = {}): Field {
  return { id: `fld_${Math.random().toString(36).slice(2, 8)}`, label: 'Payer Signature', type: 'signature', required: true, source: 'manual', page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.05, ...overrides };
}

function json(method: 'PUT' | 'PATCH' | 'POST', url: string, body: unknown, extra: Record<string, string> = {}) {
  return app.inject({ method, url, headers: { ...AUTH, 'content-type': 'application/json', 'x-acting-user': ACTOR, ...extra }, payload: JSON.stringify(body) });
}

function templateEvents(templateId: string): AuditRow[] {
  return db.prepare("SELECT * FROM audit_events WHERE json_extract(data_json, '$.templateId') = ? ORDER BY rowid ASC").all(templateId) as AuditRow[];
}

// --- upload ------------------------------------------------------------------

test('upload creates a draft template with pageCount and records template.uploaded with the acting user', async () => {
  const res = await upload({ name: 'Room Contract v1', clinicId: 'clinic_cardinal', pages: 3 });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.match(body.id, /^tpl_/);
  assert.equal(body.status, 'draft');
  assert.equal(body.name, 'Room Contract v1');
  assert.equal(body.clinic_id, 'clinic_cardinal');
  assert.equal(body.pageCount, 3);
  assert.deepEqual(body.fields, []);
  assert.equal(body.fields_json, undefined);
  assert.equal(body.page_count, undefined);
  assert.ok(fs.existsSync(body.pdf_path));

  const events = templateEvents(body.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'template.uploaded');
  assert.equal(events[0].actor, ACTOR);
  assert.equal(events[0].contract_id, null);
  const data = JSON.parse(events[0].data_json);
  assert.equal(data.pageCount, 3);
  assert.equal(data.actingUser, ACTOR);
  assert.match(data.fileSha256, /^[0-9a-f]{64}$/);
});

test('upload accepts the file part before the text fields', async () => {
  const res = await upload({ name: 'File first', clinicId: 'clinic_promis_london', fileFirst: true });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().name, 'File first');
  assert.equal(res.json().clinic_id, 'clinic_promis_london');
});

test('upload rejects non-PDF bytes, unknown clinics, and missing files', async () => {
  const notPdf = await upload({ name: 'Bad', bytes: Buffer.from('hello, not a pdf') });
  assert.equal(notPdf.statusCode, 400);
  assert.match(notPdf.json().message, /not a readable PDF/);

  const badClinic = await upload({ name: 'Bad', clinicId: 'clinic_nope' });
  assert.equal(badClinic.statusCode, 400);
  assert.match(badClinic.json().message, /Unknown clinic/);

  const noFile = multipart({ fields: { name: 'No file' } });
  const res = await app.inject({ method: 'POST', url: '/api/templates/upload', headers: { ...AUTH, ...noFile.headers }, payload: noFile.payload });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /PDF file is required/);
});

test('upload without the acting-user header falls back to actor "admin"', async () => {
  const res = await upload({ name: 'Anon', actor: null });
  assert.equal(res.statusCode, 200);
  assert.equal(templateEvents(res.json().id)[0].actor, 'admin');
});

test('acting user header is sanitised: control characters stripped, blank means fallback, long values capped', async () => {
  const messy = await upload({ name: 'Messy', actor: '  Jane\r\nDoe\x00 <jane@clinic>  ' });
  assert.equal(templateEvents(messy.json().id)[0].actor, 'JaneDoe <jane@clinic>');
  const blank = await upload({ name: 'Blank', actor: '   ' });
  assert.equal(templateEvents(blank.json().id)[0].actor, 'admin');
  const long = await upload({ name: 'Long', actor: 'x'.repeat(500) });
  assert.equal(templateEvents(long.json().id)[0].actor.length, 200);
});

// --- read ----------------------------------------------------------------------

test('GET /api/templates/:id returns the list shape; 404 JSON when missing; 401 without the token', async () => {
  const created = (await upload({ name: 'Single' })).json();
  const res = await app.inject({ method: 'GET', url: `/api/templates/${created.id}`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  const list = (await app.inject({ method: 'GET', url: '/api/templates?clinicId=clinic_cardinal', headers: AUTH })).json();
  const fromList = list.find((t: { id: string }) => t.id === created.id);
  assert.deepEqual(res.json(), fromList);
  assert.equal(res.json().pageCount, 2);

  const missing = await app.inject({ method: 'GET', url: '/api/templates/tpl_missing', headers: AUTH });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().message, 'Template not found');

  const unauth = await app.inject({ method: 'GET', url: `/api/templates/${created.id}` });
  assert.equal(unauth.statusCode, 401);
});

test('GET /api/templates/:id/pdf streams the original PDF inline and is admin-gated', async () => {
  const bytes = await makePdf(2);
  const created = (await upload({ name: 'Stream me / "quoted"', bytes })).json();
  const res = await app.inject({ method: 'GET', url: `/api/templates/${created.id}/pdf`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.equal(res.headers['content-length'], String(bytes.length));
  assert.match(String(res.headers['content-disposition']), /^inline; filename="Stream me _ _quoted_\.pdf"$/);
  assert.ok(res.rawPayload.equals(bytes));

  assert.equal((await app.inject({ method: 'GET', url: `/api/templates/${created.id}/pdf` })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/templates/tpl_missing/pdf', headers: AUTH })).statusCode, 404);

  // File missing from disk is a 404 too, not a 500.
  fs.rmSync(created.pdf_path);
  const gone = await app.inject({ method: 'GET', url: `/api/templates/${created.id}/pdf`, headers: AUTH });
  assert.equal(gone.statusCode, 404);
  assert.match(gone.json().message, /missing from storage/);
});

// --- fields --------------------------------------------------------------------

test('PUT fields defaults to active (admin UI back-compat), records fields_saved and status_changed', async () => {
  const created = (await upload({ name: 'Fields default' })).json();
  const f = field();
  const res = await json('PUT', `/api/templates/${created.id}/fields`, { fields: [f] });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'active');
  assert.deepEqual(res.json().fields, [f]);

  const events = templateEvents(created.id).map((e) => e.event_type);
  assert.deepEqual(events, ['template.uploaded', 'template.fields_saved', 'template.status_changed']);
  const change = JSON.parse(templateEvents(created.id)[2].data_json);
  assert.equal(change.from, 'draft');
  assert.equal(change.to, 'active');
  assert.equal(templateEvents(created.id)[2].actor, ACTOR);
});

test('PUT fields keeps an inactive template inactive unless a status is supplied', async () => {
  const created = (await upload({ name: 'Inactive stays' })).json();
  assert.equal((await json('PUT', `/api/templates/${created.id}/fields`, { fields: [field()] })).json().status, 'active');
  assert.equal((await json('PATCH', `/api/templates/${created.id}`, { status: 'inactive' })).json().status, 'inactive');

  const noStatus = await json('PUT', `/api/templates/${created.id}/fields`, { fields: [field(), field({ type: 'date', label: 'Date' })] });
  assert.equal(noStatus.statusCode, 200);
  assert.equal(noStatus.json().status, 'inactive');
  assert.equal(noStatus.json().fields.length, 2);

  const explicit = await json('PUT', `/api/templates/${created.id}/fields`, { fields: [field()], status: 'active' });
  assert.equal(explicit.json().status, 'active');

  const retire = await json('PUT', `/api/templates/${created.id}/fields`, { fields: [field()], status: 'inactive' });
  assert.equal(retire.json().status, 'inactive');
});

test('PUT fields rejects activation with no fields, fields beyond the last page, and unknown templates', async () => {
  const created = (await upload({ name: 'Bad fields', pages: 2 })).json();
  const empty = await json('PUT', `/api/templates/${created.id}/fields`, { fields: [] });
  assert.equal(empty.statusCode, 400);
  assert.match(empty.json().message, /at least one field/);

  const draftEmpty = await json('PUT', `/api/templates/${created.id}/fields`, { fields: [], status: 'draft' });
  assert.equal(draftEmpty.statusCode, 200);
  assert.equal(draftEmpty.json().status, 'draft');

  const beyond = await json('PUT', `/api/templates/${created.id}/fields`, { fields: [field({ page: 3, label: 'Lost' })] });
  assert.equal(beyond.statusCode, 400);
  assert.match(beyond.json().message, /Lost.*beyond the last page.*2 pages/);

  const badShape = await json('PUT', `/api/templates/${created.id}/fields`, { fields: [{ ...field(), x: 1.5 }] });
  assert.equal(badShape.statusCode, 400);

  assert.equal((await json('PUT', '/api/templates/tpl_missing/fields', { fields: [field()] })).statusCode, 404);
});

// --- PATCH ---------------------------------------------------------------------

test('PATCH validates its body: at least one field, known statuses, no extras', async () => {
  const created = (await upload({ name: 'Patch validation' })).json();
  for (const body of [{}, { status: 'archived' }, { name: '' }, { name: '   ' }, { foo: 'bar' }]) {
    const res = await json('PATCH', `/api/templates/${created.id}`, body);
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(body)}: ${res.body}`);
  }
  assert.equal((await json('PATCH', '/api/templates/tpl_missing', { name: 'x' })).statusCode, 404);
});

test('PATCH activation requires at least one field; draft cannot be re-entered', async () => {
  const created = (await upload({ name: 'Activate me' })).json();
  const noFields = await json('PATCH', `/api/templates/${created.id}`, { status: 'active' });
  assert.equal(noFields.statusCode, 400);
  assert.match(noFields.json().message, /no fields/);
  assert.equal(templateEvents(created.id).length, 1, 'no event for a refused activation');

  await json('PUT', `/api/templates/${created.id}/fields`, { fields: [field()], status: 'draft' });
  const ok = await json('PATCH', `/api/templates/${created.id}`, { status: 'active' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().status, 'active');

  const back = await json('PATCH', `/api/templates/${created.id}`, { status: 'draft' });
  assert.equal(back.statusCode, 400);
  assert.match(back.json().message, /cannot return to draft/);

  // Same-status PATCH is a no-op and writes no status event.
  const before = templateEvents(created.id).length;
  assert.equal((await json('PATCH', `/api/templates/${created.id}`, { status: 'active' })).statusCode, 200);
  assert.equal(templateEvents(created.id).length, before);
});

test('PATCH rename and retire record template.renamed and template.status_changed with from/to', async () => {
  const created = (await upload({ name: 'Old name' })).json();
  await json('PUT', `/api/templates/${created.id}/fields`, { fields: [field()] });
  const res = await json('PATCH', `/api/templates/${created.id}`, { name: 'New name', status: 'inactive' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().name, 'New name');
  assert.equal(res.json().status, 'inactive');

  const events = templateEvents(created.id);
  const renamed = events.find((e) => e.event_type === 'template.renamed')!;
  assert.deepEqual(JSON.parse(renamed.data_json), { templateId: created.id, clinicId: 'clinic_cardinal', from: 'Old name', to: 'New name', actingUser: ACTOR });
  const retired = events.filter((e) => e.event_type === 'template.status_changed').at(-1)!;
  assert.equal(JSON.parse(retired.data_json).from, 'active');
  assert.equal(JSON.parse(retired.data_json).to, 'inactive');
  assert.equal(retired.actor, ACTOR);

  const reactivated = await json('PATCH', `/api/templates/${created.id}`, { status: 'active' });
  assert.equal(reactivated.json().status, 'active');
});

test('GET /api/templates/:id/audit lists the lifecycle events in chain order', async () => {
  const created = (await upload({ name: 'Audit list' })).json();
  await json('PUT', `/api/templates/${created.id}/fields`, { fields: [field()] });
  await json('PATCH', `/api/templates/${created.id}`, { name: 'Audit list v2' });
  const res = await app.inject({ method: 'GET', url: `/api/templates/${created.id}/audit`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().map((e: AuditRow) => e.event_type), ['template.uploaded', 'template.fields_saved', 'template.status_changed', 'template.renamed']);
  for (const e of res.json()) assert.match(e.hash, /^[0-9a-f]{64}$/);
});

// --- copyFieldsFrom --------------------------------------------------------------

test('copyFieldsFrom copies the source fields onto a new draft; page boxes beyond the new PDF are dropped', async () => {
  const v1 = (await upload({ name: 'Contract v1', pages: 3 })).json();
  const fields = [field({ page: 1, label: 'Name' }), field({ page: 3, label: 'Signature' })];
  await json('PUT', `/api/templates/${v1.id}/fields`, { fields });

  const v2 = await upload({ name: 'Contract v2', copyFieldsFrom: v1.id, pages: 3 });
  assert.equal(v2.statusCode, 200, v2.body);
  assert.equal(v2.json().status, 'draft');
  assert.deepEqual(v2.json().fields, fields);
  assert.equal(JSON.parse(templateEvents(v2.json().id)[0].data_json).copiedFieldsFrom, v1.id);
  // The source is untouched and still sendable.
  assert.equal((await app.inject({ method: 'GET', url: `/api/templates/${v1.id}`, headers: AUTH })).json().status, 'active');

  const shorter = await upload({ name: 'Contract v3 (2 pages)', copyFieldsFrom: v1.id, pages: 2 });
  assert.equal(shorter.json().fields.length, 1);
  assert.equal(shorter.json().fields[0].label, 'Name');
});

test('copyFieldsFrom must name an existing template in the same clinic', async () => {
  const cardinal = (await upload({ name: 'Cardinal source', clinicId: 'clinic_cardinal' })).json();
  const cross = await upload({ name: 'London copy', clinicId: 'clinic_promis_london', copyFieldsFrom: cardinal.id });
  assert.equal(cross.statusCode, 400);
  assert.match(cross.json().message, /different clinic/);
  const unknown = await upload({ name: 'Copy of nothing', copyFieldsFrom: 'tpl_missing' });
  assert.equal(unknown.statusCode, 400);
  assert.match(unknown.json().message, /not found/);
});

// --- sendability ---------------------------------------------------------------

test('only active templates can be used to create contracts; contract.created records the acting user', async () => {
  const created = (await upload({ name: 'Sendable' })).json();
  const payload = { templateId: created.id, clinicId: 'clinic_cardinal', patientRecordId: 'PT-1', patientName: 'Pat', patientAge: '40', payerName: 'Payer', payerEmail: 'payer@example.com' };

  const draft = await json('POST', '/api/contracts', payload);
  assert.equal(draft.statusCode, 400);
  assert.match(draft.json().message, /still a draft/);

  await json('PUT', `/api/templates/${created.id}/fields`, { fields: [field({ type: 'text', source: 'patientName', label: 'Patient' })] });
  await json('PATCH', `/api/templates/${created.id}`, { status: 'inactive' });
  const inactive = await json('POST', '/api/contracts', payload);
  assert.equal(inactive.statusCode, 400);
  assert.match(inactive.json().message, /retired \(inactive\)/);

  await json('PATCH', `/api/templates/${created.id}`, { status: 'active' });
  const ok = await json('POST', '/api/contracts', payload);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().status, 'pending');
  const createdEvent = db.prepare("SELECT * FROM audit_events WHERE contract_id = ? AND event_type = 'contract.created'").get(ok.json().id) as AuditRow;
  assert.equal(createdEvent.actor, ACTOR);
  assert.equal(JSON.parse(createdEvent.data_json).actingUser, ACTOR);

  const anon = await json('POST', '/api/contracts', payload, { 'x-acting-user': '' });
  assert.equal(anon.statusCode, 200);
  const anonEvent = db.prepare("SELECT * FROM audit_events WHERE contract_id = ? AND event_type = 'contract.created'").get(anon.json().id) as AuditRow;
  assert.equal(anonEvent.actor, 'system');
});

test('other admin contract events carry the acting user too', async () => {
  const created = (await upload({ name: 'Archive me' })).json();
  await json('PUT', `/api/templates/${created.id}/fields`, { fields: [field()] });
  const contract = (await json('POST', '/api/contracts', { templateId: created.id, patientName: 'Pat', payerName: 'Payer', payerEmail: 'payer@example.com' })).json();
  assert.equal((await json('POST', `/api/contracts/${contract.id}/archive`, {})).statusCode, 200);
  const archived = db.prepare("SELECT actor FROM audit_events WHERE contract_id = ? AND event_type = 'contract.archived'").get(contract.id) as { actor: string };
  assert.equal(archived.actor, ACTOR);
});

// --- chain ---------------------------------------------------------------------

test('the audit hash chain still verifies with template and contract events interleaved', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/audit/verify', headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true, JSON.stringify(res.json()));
  assert.equal(res.json().eventCount, (db.prepare('SELECT COUNT(*) AS c FROM audit_events').get() as { c: number }).c);
  assert.ok(res.json().eventCount > 20);
});

test.after(async () => {
  await app.close();
});
