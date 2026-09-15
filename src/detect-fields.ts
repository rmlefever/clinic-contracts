import { PDFDocument, PDFName, PDFArray, PDFNumber } from 'pdf-lib';
import type { TemplateField } from './db.js';

// AcroForm field detection: when an uploaded template PDF already carries
// fillable form fields, pre-place them in the template editor so the admin
// only reviews/activates instead of drawing every box by hand. (Upstream
// DocuSeal also heuristically guesses fields from labels; we take only the
// reliable subset — real AcroForm widgets with real coordinates.)

const DATE_HINT = /(date|signed\s*at|datum)/i;
const NUMBER_HINT = /(age|number|qty|quantity|total|price)/i;

export async function validatePdf(bytes: Buffer): Promise<void> {
  // Throws on non-PDFs and on encrypted documents (load defaults to refusing
  // both) — the upload route turns that into a 400.
  await PDFDocument.load(bytes, { updateMetadata: false });
}

export async function detectAcroFields(bytes: Buffer): Promise<TemplateField[]> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = pdf.getPages();
  let form;
  try {
    form = pdf.getForm();
  } catch {
    return [];
  }

  const fields: TemplateField[] = [];
  for (const field of form.getFields()) {
    if (fields.length >= 100) break;
    const name = field.getName();
    const widget = field.acroField.getWidgets()[0];
    if (!widget) continue;

    const pageIdx = pages.findIndex((p) => p.ref === widget.P());
    if (pageIdx < 0) continue;
    const { width, height } = pages[pageIdx].getSize();

    const rectArr = widget.dict.lookup(PDFName.of('Rect'), PDFArray);
    const rect = [0, 1, 2, 3].map((i) => rectArr.lookup(i, PDFNumber).asNumber());
    const w = (rect[2] - rect[0]) / width;
    const h = (rect[3] - rect[1]) / height;
    if (w <= 0.005 || h <= 0.005 || w > 1 || h > 1) continue;

    const ctor = field.constructor.name;
    let type: TemplateField['type'] = 'text';
    if (ctor === 'PDFCheckBox' || ctor === 'PDFRadioGroup') type = 'checkbox';
    else if (DATE_HINT.test(name)) type = 'date';
    else if (NUMBER_HINT.test(name)) type = 'number';

    fields.push({
      id: `fld_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'auto'}`,
      label: name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60),
      type,
      required: field.isRequired?.() ?? false,
      source: /patient\s*name/i.test(name)
        ? 'patientName'
        : /patient\s*age/i.test(name)
          ? 'patientAge'
          : /payer|signatory|parent|guardian/i.test(name) && /name/i.test(name)
            ? 'payerName'
            : /payer|signatory|parent|guardian/i.test(name) && /email/i.test(name)
              ? 'payerEmail'
              : 'manual',
      page: pageIdx + 1,
      x: Math.min(Math.max(rect[0] / width, 0), 0.98),
      y: Math.min(Math.max(1 - rect[3] / height, 0), 0.98),
      w,
      h
    });
  }
  return fields;
}
