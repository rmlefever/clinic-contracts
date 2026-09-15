import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import type { TemplateField, TemplateRecord, ContractRecord } from './db.js';

type Values = Record<string, string>;

function dataUrlToBytes(value: string): Uint8Array | null {
  const match = value.match(/^data:image\/png;base64,(.+)$/);
  if (!match) return null;
  return Buffer.from(match[1], 'base64');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Word-wrap for pdf-lib drawText (which does not wrap). */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/**
 * Parse an uploaded template PDF and return its page count. Throws if the bytes
 * are not a loadable PDF (the caller turns that into a 400). Encrypted files
 * are accepted so a protected-but-readable contract can still be a template.
 */
export async function countPdfPages(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.getPageCount();
}

// Field coordinate model (shared with the admin UI and the Framework editor):
//   page  1-based page number
//   x, y  fraction (0-1) of the page width/height, measured from the TOP-LEFT
//         corner of the page to the field's top-left corner
//   w, h  fraction (0-1) of the page width/height
// pdf-lib's origin is bottom-left, so y is flipped here when stamping.

/**
 * Render a timestamp for the signing certificate in UK local time (GMT in
 * winter, BST in summer), with the exact UTC instant kept in brackets so the
 * certificate still matches the audit record byte for byte.
 */
export function certificateTime(iso: string | null | undefined): string {
  if (!iso) return 'Not recorded';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short'
  }).format(d);
  return `${local} (${d.toISOString()} UTC)`;
}

export async function stampSignedPdf(input: {
  template: TemplateRecord;
  contract: ContractRecord;
  fields: TemplateField[];
  values: Values;
  outputPath: string;
  consentText: string;
  consentVersion: string;
  signerIp: string;
  viewedAt: string | null;
  completedAt: string;
}): Promise<{ contentSha256: string; fileSha256: string }> {
  const pdfBytes = await fs.readFile(input.template.pdf_path);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();

  for (const field of input.fields) {
    const page = pages[field.page - 1];
    if (!page) continue;

    const value = input.values[field.id] ?? '';
    if (!value) continue;

    const { width, height } = page.getSize();
    const x = field.x * width;
    const y = height - field.y * height - field.h * height;
    const w = field.w * width;
    const h = field.h * height;

    if (field.type === 'signature') {
      const imageBytes = dataUrlToBytes(value);
      if (imageBytes) {
        const png = await pdfDoc.embedPng(imageBytes);
        page.drawImage(png, { x, y, width: w, height: h });
      }
      continue;
    }

    if (field.type === 'checkbox') {
      if (value === 'true' || value === 'on') {
        page.drawText('X', { x: x + 3, y: y + 2, size: Math.min(16, h), font, color: rgb(0.05, 0.08, 0.1) });
      }
      continue;
    }

    page.drawText(value, {
      x: x + 3,
      y: y + Math.max(3, h * 0.25),
      size: Math.min(12, h * 0.62),
      font,
      color: rgb(0.05, 0.08, 0.1),
      maxWidth: w - 6
    });
  }

  // Phase 1: seal the completed document content (the filled template without
  // the certificate page) and hash it. This hash is printed on the certificate
  // so the signed content is bound to it.
  const contentBytes = await pdfDoc.save();
  const contentSha256 = sha256(contentBytes);

  // Phase 2: append the signing certificate, including the content hash.
  const certDoc = await PDFDocument.load(contentBytes);
  const certFont = await certDoc.embedFont(StandardFonts.Helvetica);
  const courier = await certDoc.embedFont(StandardFonts.Courier);
  const signedPage = certDoc.addPage([612, 792]);
  const left = 72;
  const maxWidth = 468;
  let y = 710;

  const line = (text: string, size = 11, f: PDFFont = certFont) => {
    signedPage.drawText(text, { x: left, y, size, font: f, color: rgb(0.05, 0.08, 0.1), maxWidth });
    y -= size + 6;
  };
  const para = (text: string, size = 10, f: PDFFont = certFont) => {
    for (const l of wrapText(text, f, size, maxWidth)) line(l, size, f);
  };

  line('Signing Certificate', 20);
  y -= 4;
  line(`Contract: ${input.contract.id}`);
  line(`Patient record: ${input.contract.patient_record_id ?? 'Not supplied'}`);
  line(`Signer: ${input.contract.payer_name} <${input.contract.payer_email}>`);
  line(`Signer IP at completion: ${input.signerIp}`);
  line(`Document first viewed: ${certificateTime(input.viewedAt)}`);
  line(`Completed: ${certificateTime(input.completedAt)}`);
  y -= 6;
  line(`Signer consent (v${input.consentVersion}):`, 10);
  para(`"${input.consentText}"`, 10);
  line('The signer affirmatively accepted the statement above at completion.', 10);
  y -= 6;
  line('Document SHA-256 (content pages, excluding this certificate):', 10);
  para(contentSha256, 9, courier);
  y -= 2;
  para('The SHA-256 of this complete file (including this certificate page) is recorded in the Cardinal Contracts audit record for this contract.', 9);
  y -= 6;
  para('This certificate records the electronic signing event captured by Cardinal Contracts.');

  const finalBytes = await certDoc.save();
  const fileSha256 = sha256(finalBytes);

  await fs.mkdir(input.outputPath.split('/').slice(0, -1).join('/'), { recursive: true });
  await fs.writeFile(input.outputPath, finalBytes);

  return { contentSha256, fileSha256 };
}
