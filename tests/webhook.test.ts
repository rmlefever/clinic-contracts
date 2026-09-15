import test from 'node:test';
import assert from 'node:assert/strict';
import { signWebhook, verifyWebhookSignature, WEBHOOK_TOLERANCE_SECONDS } from '../src/webhook.js';

const BODY = JSON.stringify({ event: 'contract.completed', contractId: 'ctr_test', occurredAt: '2026-09-14T12:00:00.000Z' });

test('signWebhook produces ts.hmac and round-trips', () => {
  const header = signWebhook('secret', BODY, 1770000000);
  assert.match(header, /^1770000000\.[0-9a-f]{64}$/);
  assert.equal(verifyWebhookSignature('secret', BODY, header, 1770000000), true);
});

test('verification is secret-bound', () => {
  const header = signWebhook('secret', BODY, 1770000000);
  assert.equal(verifyWebhookSignature('other', BODY, header, 1770000000), false);
});

test('verification is body-bound (tampered payload rejected)', () => {
  const header = signWebhook('secret', BODY, 1770000000);
  assert.equal(verifyWebhookSignature('secret', BODY.replace('ctr_test', 'ctr_evil'), header, 1770000000), false);
});

test('replayed signatures outside the tolerance window are rejected', () => {
  const header = signWebhook('secret', BODY, 1770000000);
  const now = 1770000000 + WEBHOOK_TOLERANCE_SECONDS + 1;
  assert.equal(verifyWebhookSignature('secret', BODY, header, now), false);
  // ...but within it is fine
  assert.equal(verifyWebhookSignature('secret', BODY, header, 1770000000 + WEBHOOK_TOLERANCE_SECONDS), true);
});

test('malformed headers are rejected, never thrown', () => {
  assert.equal(verifyWebhookSignature('secret', BODY, ''), false);
  assert.equal(verifyWebhookSignature('secret', BODY, 'not-a-signature'), false);
  assert.equal(verifyWebhookSignature('secret', BODY, 'abc.def'), false); // non-integer ts
  assert.equal(verifyWebhookSignature('secret', BODY, '1770000000.shortmac'), false); // wrong length
});
