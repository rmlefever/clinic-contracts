import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

// Pure helpers for signer email verification (OTP) and sessions.
// Kept free of side effects so they can be unit-tested directly.

export function generateOtpCode(): string {
  return String(randomInt(100000, 1000000));
}

/** HMAC of contractId|code with a server-side secret. Only the hash is stored. */
export function otpHash(secret: string, contractId: string, code: string): string {
  return createHmac('sha256', secret).update(`${contractId}|${code}`).digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** jane.doe@example.com -> j***@ex***.com (shown to the signer; never reveals the full address). */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const name = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  const localPart = local[0] ?? '';
  const namePart = name.slice(0, 2);
  return `${localPart}***@${namePart}***${tld}`;
}
