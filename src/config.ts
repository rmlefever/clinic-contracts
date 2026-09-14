import path from 'node:path';

export const config = {
  appUrl: process.env.APP_URL ?? 'http://localhost:4321',
  port: Number(process.env.PORT ?? 4321),
  adminToken: process.env.ADMIN_TOKEN ?? 'change-me',
  // IPs permitted to reach the admin surface VIA THE PUBLIC DOMAIN (escape
  // hatch, e.g. an office IP). Default loopback-only so local dev works; in
  // production the public domain is admin-blocked unless this is set. Direct
  // tailnet access is allowed separately via internal-network checks.
  adminAllowCidrs: (process.env.ADMIN_ALLOW_CIDR ?? '127.0.0.1/8,::1')
    .split(',').map((s) => s.trim()).filter(Boolean),
  uploadDir: path.resolve(process.env.UPLOAD_DIR ?? './uploads'),
  storageDir: path.resolve(process.env.STORAGE_DIR ?? './storage'),
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  emailFrom: process.env.EMAIL_FROM ?? 'DocuSeal <signing@docuseal.ink>',
  // Evidence hardening: signing links expire, and signers verify via email OTP
  // before they may complete (requires RESEND_API_KEY; without an email
  // provider the OTP step is skipped and recorded as unverified).
  signingTokenDays: Number(process.env.SIGNING_TOKEN_DAYS ?? 30),
  signerOtpEnabled: (process.env.SIGNER_OTP_ENABLED ?? 'true') !== 'false',
  otpTtlMinutes: Number(process.env.OTP_TTL_MINUTES ?? 10),
  otpResendThrottleSeconds: Number(process.env.OTP_RESEND_THROTTLE_SECONDS ?? 30),
  otpMaxAttempts: Number(process.env.OTP_MAX_ATTEMPTS ?? 5),
  signerSessionHours: Number(process.env.SIGNER_SESSION_HOURS ?? 2)
};
