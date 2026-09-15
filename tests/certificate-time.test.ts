import { test } from 'node:test';
import assert from 'node:assert/strict';
import { certificateTime } from '../src/pdf.js';

test('certificate times are UK local with the UTC instant retained', () => {
  assert.equal(
    certificateTime('2026-09-15T06:53:18.558Z'),
    '15 Sept 2026, 07:53:18 BST (2026-09-15T06:53:18.558Z UTC)'
  );
  assert.equal(
    certificateTime('2026-01-15T06:53:18.558Z'),
    '15 Jan 2026, 06:53:18 GMT (2026-01-15T06:53:18.558Z UTC)'
  );
});

test('certificate time handles missing and malformed values', () => {
  assert.equal(certificateTime(null), 'Not recorded');
  assert.equal(certificateTime(undefined), 'Not recorded');
  assert.equal(certificateTime('not a date'), 'not a date');
});
