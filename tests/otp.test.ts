import test from 'node:test';
import assert from 'node:assert/strict';
import { generateOtpCode, otpHash, constantTimeEqual, maskEmail } from '../src/otp.js';

test('generateOtpCode produces 6 digits', () => {
  for (let i = 0; i < 50; i++) {
    const code = generateOtpCode();
    assert.match(code, /^\d{6}$/);
  }
});

test('otpHash is deterministic, secret-bound, contract-bound and code-bound', () => {
  const a = otpHash('secret', 'ctr_1', '123456');
  assert.equal(a, otpHash('secret', 'ctr_1', '123456'));
  assert.notEqual(a, otpHash('other-secret', 'ctr_1', '123456'));
  assert.notEqual(a, otpHash('secret', 'ctr_2', '123456'));
  assert.notEqual(a, otpHash('secret', 'ctr_1', '654321'));
  // Only a hash is ever stored, never the code itself.
  assert.ok(!a.includes('123456'));
});

test('constantTimeEqual compares correctly', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual('', ''), true);
});

test('maskEmail hides the address', () => {
  assert.equal(maskEmail('jane.doe@example.com'), 'j***@ex***.com');
  assert.equal(maskEmail('a@b.co'), 'a***@b***.co');
  assert.equal(maskEmail('not-an-email'), '***');
});
