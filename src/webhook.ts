import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { audit } from './audit.js';

// Outbound webhook to a single, operator-configured consumer (the Cardinal
// Framework). Security model:
//
//   - The URL and secret come from env only. No route can change them, so a
//     compromised session can never turn this app into an SSRF probe aimed at
//     tailnet services.
//   - Payloads carry no patient data — just event, contract id, timestamp.
//     The consumer re-fetches everything through the authenticated admin API.
//   - Each delivery is signed: "{unix_ts}.{hmac_sha256(secret, ts + '.' + body)}"
//     in X-Contracts-Signature. The receiver verifies the HMAC in constant
//     time and rejects timestamps older than 5 minutes (replay protection).
//     (Scheme copied from upstream DocuSeal's webhook signing.)
//
// If webhooks ever gain multiple consumers configured via the API, a host
// allowlist becomes mandatory before that.

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export function signWebhook(secret: string, body: string, timestamp: number = Math.floor(Date.now() / 1000)): string {
  return `${timestamp}.${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export function verifyWebhookSignature(secret: string, body: string, header: string, now: number = Math.floor(Date.now() / 1000)): boolean {
  const [tsRaw, sig] = String(header).split('.');
  const ts = Number(tsRaw);
  if (!Number.isInteger(ts) || !sig) return false;
  if (Math.abs(now - ts) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = signWebhook(secret, body, ts).split('.')[1];
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Fire-and-forget with 3 attempts. Failures are audited, never thrown. */
export async function fireWebhook(event: string, contractId: string): Promise<void> {
  if (!config.webhookUrl || !config.webhookSecret) return;
  const body = JSON.stringify({ event, contractId, occurredAt: new Date().toISOString() });
  const signature = signWebhook(config.webhookSecret, body);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Contracts-Signature': signature },
        body,
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.ok) {
        audit({ contractId, actor: 'system', eventType: 'webhook.sent', data: { event, attempt, status: res.status } });
        return;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (error) {
      clearTimeout(timer);
      if (attempt === 3) {
        audit({ contractId, actor: 'system', eventType: 'webhook.failed', data: { event, error: String(error).slice(0, 200) } });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
    }
  }
}
