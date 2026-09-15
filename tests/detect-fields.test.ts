import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contracts-detect-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.sqlite');

const { validatePdf, detectAcroFields } = await import('../src/detect-fields.js');

async function pdfWithAcroFields() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  form.createTextField('payer_name').addToPage(page, { x: 72, y: 600, width: 200, height: 24 });
  form.createTextField('date_of_signing').addToPage(page, { x: 72, y: 500, width: 150, height: 24 });
  form.createCheckBox('i_agree').addToPage(page, { x: 72, y: 400, width: 18, height: 18 });
  return Buffer.from(await doc.save());
}

async function pdfWithoutFields() {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

test('validatePdf rejects non-PDF bytes and accepts real PDFs', async () => {
  await assert.rejects(() => validatePdf(Buffer.from('this is not a pdf at all')));
  await validatePdf(await pdfWithoutFields());
});

test('detectAcroFields maps AcroForm widgets to normalized template fields', async () => {
  const fields = await detectAcroFields(await pdfWithAcroFields());
  assert.equal(fields.length, 3);

  const payer = fields.find((f) => f.id === 'fld_payer_name');
  assert.ok(payer, 'payer_name detected');
  assert.equal(payer.type, 'text');
  assert.equal(payer.source, 'payerName', 'payer name maps to the payerName prefill source');
  assert.equal(payer.page, 1);
  assert.ok(payer.x > 0.1 && payer.x < 0.13, `x normalized (${payer.x})`);
  assert.ok(payer.w > 0.3 && payer.w < 0.35, `w normalized (${payer.w})`);

  const date = fields.find((f) => f.id === 'fld_date_of_signing');
  assert.ok(date, 'date field detected');
  assert.equal(date.type, 'date', 'date-hinted name detected as date');

  const agree = fields.find((f) => f.id === 'fld_i_agree');
  assert.ok(agree, 'checkbox detected');
  assert.equal(agree.type, 'checkbox');
  assert.ok(agree.w < 0.05, `checkbox normalized (${agree.w})`);

  for (const field of fields) {
    assert.ok(field.label.length > 0, 'human label generated');
    assert.ok(field.y >= 0 && field.y <= 0.98, 'y within bounds');
  }
});

test('detectAcroFields returns [] for PDFs without form fields', async () => {
  assert.deepEqual(await detectAcroFields(await pdfWithoutFields()), []);
});

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
