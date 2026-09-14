import { Resend } from 'resend';
import { config } from './config.js';

const SAFETY_FOOTER = `
  <p style="color:#68726d;font-size:13px">If you were not expecting this document, please contact the clinic before signing anything.</p>
`;

export async function sendSigningEmail(input: {
  to: string;
  from?: string | null;
  signerName: string;
  patientName: string;
  signingUrl: string;
  clinicName?: string | null;
}) {
  if (!config.resendApiKey) return { sent: false, reason: 'RESEND_API_KEY is not configured' };

  const resend = new Resend(config.resendApiKey);
  const result = await resend.emails.send({
    from: input.from || config.emailFrom,
    to: input.to,
    subject: `Contract for ${input.patientName}`,
    html: `
      <p>Dear ${escapeHtml(input.signerName)},</p>
      <p>Please review and sign the contract for ${escapeHtml(input.patientName)}.</p>
      <p><a href="${input.signingUrl}">Open secure signing link</a></p>
      <p>If the button does not work, copy this link into your browser:<br>${input.signingUrl}</p>
      <p>The link expires ${expiryText()}. When you open it, we will email you a verification code to confirm it is really you.</p>
      ${SAFETY_FOOTER}
    `
  });

  if (result.error) {
    return { sent: false, reason: result.error.message, error: result.error };
  }

  return { sent: true, id: result.data.id };
}

export async function sendOtpEmail(input: {
  to: string;
  from?: string | null;
  signerName: string;
  code: string;
}) {
  if (!config.resendApiKey) return { sent: false, reason: 'RESEND_API_KEY is not configured' };

  const resend = new Resend(config.resendApiKey);
  const result = await resend.emails.send({
    from: input.from || config.emailFrom,
    to: input.to,
    subject: `Your verification code: ${input.code}`,
    html: `
      <p>Dear ${escapeHtml(input.signerName)},</p>
      <p>Your verification code is:</p>
      <p style="font-size:28px;letter-spacing:6px;font-weight:600">${escapeHtml(input.code)}</p>
      <p>Enter this code to continue signing. It expires in ${config.otpTtlMinutes} minutes.</p>
      <p style="color:#68726d;font-size:13px">We did not send this? Someone may have your signing link — you can safely ignore this code, but please contact the clinic.</p>
    `
  });

  if (result.error) {
    return { sent: false, reason: result.error.message, error: result.error };
  }

  return { sent: true, id: result.data.id };
}

export async function sendCompletedEmail(input: {
  to: string;
  from?: string | null;
  signerName: string;
  patientName: string;
  pdfBase64: string;
  pdfName: string;
}) {
  if (!config.resendApiKey) return { sent: false, reason: 'RESEND_API_KEY is not configured' };

  const resend = new Resend(config.resendApiKey);
  const result = await resend.emails.send({
    from: input.from || config.emailFrom,
    to: input.to,
    subject: `Signed: contract for ${input.patientName}`,
    html: `
      <p>Dear ${escapeHtml(input.signerName)},</p>
      <p>The contract for ${escapeHtml(input.patientName)} has been signed and completed.</p>
      <p>Your copy is attached. Please keep it for your records.</p>
    `,
    attachments: [{ filename: input.pdfName, content: input.pdfBase64 }]
  });

  if (result.error) {
    return { sent: false, reason: result.error.message, error: result.error };
  }

  return { sent: true, id: result.data.id };
}

function expiryText(): string {
  const days = config.signingTokenDays;
  if (days === 1) return 'in 1 day';
  if (days === 30) return 'in 30 days';
  return `in ${days} days`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[char] ?? char);
}
