import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptBuffer,
  decryptText,
  encryptBuffer,
  encryptText,
  resetDataEncryptionState,
  rotateEncryptedText,
} from './crypto';

const ORIGINAL_ENV = {
  TLPE_DATA_KEY: process.env.TLPE_DATA_KEY,
  TLPE_DATA_KEYS: process.env.TLPE_DATA_KEYS,
  TLPE_DATA_KEY_VERSION: process.env.TLPE_DATA_KEY_VERSION,
};

function setSingleKey(base64: string) {
  process.env.TLPE_DATA_KEY = base64;
  delete process.env.TLPE_DATA_KEYS;
  delete process.env.TLPE_DATA_KEY_VERSION;
  resetDataEncryptionState();
}

test.afterEach(() => {
  if (ORIGINAL_ENV.TLPE_DATA_KEY === undefined) delete process.env.TLPE_DATA_KEY;
  else process.env.TLPE_DATA_KEY = ORIGINAL_ENV.TLPE_DATA_KEY;

  if (ORIGINAL_ENV.TLPE_DATA_KEYS === undefined) delete process.env.TLPE_DATA_KEYS;
  else process.env.TLPE_DATA_KEYS = ORIGINAL_ENV.TLPE_DATA_KEYS;

  if (ORIGINAL_ENV.TLPE_DATA_KEY_VERSION === undefined) delete process.env.TLPE_DATA_KEY_VERSION;
  else process.env.TLPE_DATA_KEY_VERSION = ORIGINAL_ENV.TLPE_DATA_KEY_VERSION;

  resetDataEncryptionState();
});

test('AES-256-GCM roundtrip works for text and binary payloads', () => {
  setSingleKey(Buffer.alloc(32, 7).toString('base64'));

  const encryptedText = encryptText('iban:FR7630006000011234567890189');
  assert.notEqual(encryptedText, 'iban:FR7630006000011234567890189');
  assert.equal(decryptText(encryptedText), 'iban:FR7630006000011234567890189');

  const encryptedBuffer = encryptBuffer(Buffer.from('%PDF-1.7\nsecret-piece-jointe', 'utf8'));
  assert.equal(encryptedBuffer.includes('secret-piece-jointe'), false);
  assert.deepEqual(decryptBuffer(encryptedBuffer), Buffer.from('%PDF-1.7\nsecret-piece-jointe', 'utf8'));
});

test('decryptText rejects corrupted IV/tag payloads', () => {
  setSingleKey(Buffer.alloc(32, 9).toString('base64'));

  const encrypted = encryptText('totp-secret');
  const corrupted = encrypted.replace(/.$/, encrypted.endsWith('A') ? 'B' : 'A');

  assert.throws(() => decryptText(corrupted), /chiffr|auth|integr/i);
});

test('rotateEncryptedText re-encrypts existing payloads with the active key version', () => {
  process.env.TLPE_DATA_KEYS = [
    `2026-q1:${Buffer.alloc(32, 1).toString('base64')}`,
    `2026-q2:${Buffer.alloc(32, 2).toString('base64')}`,
  ].join(',');
  process.env.TLPE_DATA_KEY_VERSION = '2026-q1';
  delete process.env.TLPE_DATA_KEY;
  resetDataEncryptionState();

  const oldPayload = encryptText('rotation-target');
  assert.match(oldPayload, /2026-q1/);

  process.env.TLPE_DATA_KEY_VERSION = '2026-q2';
  resetDataEncryptionState();

  const rotated = rotateEncryptedText(oldPayload);
  assert.match(rotated, /2026-q2/);
  assert.equal(decryptText(rotated), 'rotation-target');
});
