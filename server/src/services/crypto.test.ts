import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptBuffer,
  decryptBufferOrLegacy,
  decryptText,
  decryptTextOrLegacy,
  encryptBuffer,
  encryptText,
  getDataEncryptionInfo,
  resetDataEncryptionState,
  rotateEncryptedBuffer,
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

test('decryptTextOrLegacy et decryptBufferOrLegacy restituent les payloads non chiffrés tels quels', () => {
  setSingleKey(Buffer.alloc(32, 6).toString('base64'));

  assert.equal(decryptTextOrLegacy('texte-clair'), 'texte-clair');
  assert.deepEqual(decryptBufferOrLegacy(Buffer.from('piece-claire', 'utf8')), Buffer.from('piece-claire', 'utf8'));
});

test('getDataEncryptionInfo indique la source fallback-dev-key quand aucune clé n’est fournie', () => {
  delete process.env.TLPE_DATA_KEY;
  delete process.env.TLPE_DATA_KEYS;
  delete process.env.TLPE_DATA_KEY_VERSION;
  resetDataEncryptionState();

  const info = getDataEncryptionInfo();
  assert.equal(info.active_version, 'v1');
  assert.deepEqual(info.configured_versions, ['v1']);
  assert.equal(info.source, 'fallback-dev-key');
});

test('getDataEncryptionInfo indique la source TLPE_DATA_KEYS et la version active configurée', () => {
  process.env.TLPE_DATA_KEYS = [
    `2026-q1:${Buffer.alloc(32, 1).toString('base64')}`,
    `2026-q2:${Buffer.alloc(32, 2).toString('base64')}`,
  ].join(',');
  process.env.TLPE_DATA_KEY_VERSION = '2026-q2';
  delete process.env.TLPE_DATA_KEY;
  resetDataEncryptionState();

  const info = getDataEncryptionInfo();
  assert.equal(info.active_version, '2026-q2');
  assert.deepEqual(info.configured_versions, ['2026-q1', '2026-q2']);
  assert.equal(info.source, 'TLPE_DATA_KEYS');
});

test('getDataEncryptionInfo indique la source TLPE_DATA_KEY quand une clé unique explicite est fournie', () => {
  process.env.TLPE_DATA_KEY = Buffer.alloc(32, 5).toString('base64');
  delete process.env.TLPE_DATA_KEYS;
  delete process.env.TLPE_DATA_KEY_VERSION;
  resetDataEncryptionState();

  const info = getDataEncryptionInfo();
  assert.equal(info.active_version, 'v1');
  assert.equal(info.source, 'TLPE_DATA_KEY');
});

test('rotateEncryptedText laisse inchangé un payload déjà sur la version active et chiffre un texte legacy', () => {
  setSingleKey(Buffer.alloc(32, 8).toString('base64'));

  const encrypted = encryptText('rotation-same-version');
  assert.equal(rotateEncryptedText(encrypted), encrypted);

  const rotatedLegacy = rotateEncryptedText('legacy-value');
  assert.notEqual(rotatedLegacy, 'legacy-value');
  assert.equal(decryptText(rotatedLegacy), 'legacy-value');
});

test('rotateEncryptedBuffer laisse inchangé un buffer déjà chiffré et chiffre un buffer legacy', () => {
  setSingleKey(Buffer.alloc(32, 10).toString('base64'));

  const encrypted = encryptBuffer(Buffer.from('piece-binaire', 'utf8'));
  assert.deepEqual(rotateEncryptedBuffer(encrypted), encrypted);

  const rotatedLegacy = rotateEncryptedBuffer(Buffer.from('piece-legacy', 'utf8'));
  assert.notDeepEqual(rotatedLegacy, Buffer.from('piece-legacy', 'utf8'));
  assert.deepEqual(decryptBuffer(rotatedLegacy), Buffer.from('piece-legacy', 'utf8'));
});

test('buildConfig rejette une version active inconnue dans TLPE_DATA_KEYS', () => {
  process.env.TLPE_DATA_KEYS = `2026-q1:${Buffer.alloc(32, 1).toString('base64')}`;
  process.env.TLPE_DATA_KEY_VERSION = '2026-q9';
  delete process.env.TLPE_DATA_KEY;
  resetDataEncryptionState();

  assert.throws(() => getDataEncryptionInfo(), /TLPE_DATA_KEY_VERSION inconnu/);
});

test('buildConfig rejette un format TLPE_DATA_KEYS invalide', () => {
  process.env.TLPE_DATA_KEYS = 'not-a-valid-entry';
  delete process.env.TLPE_DATA_KEY;
  delete process.env.TLPE_DATA_KEY_VERSION;
  resetDataEncryptionState();

  assert.throws(() => getDataEncryptionInfo(), /TLPE_DATA_KEYS doit suivre le format/);
});

test('buildConfig exige une clé en production', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  delete process.env.TLPE_DATA_KEY;
  delete process.env.TLPE_DATA_KEYS;
  delete process.env.TLPE_DATA_KEY_VERSION;
  resetDataEncryptionState();

  try {
    assert.throws(() => getDataEncryptionInfo(), /obligatoire en production/);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('buildConfig rejette une clé TLPE_DATA_KEY qui ne fait pas 32 octets', () => {
  process.env.TLPE_DATA_KEY = Buffer.alloc(16, 1).toString('base64');
  delete process.env.TLPE_DATA_KEYS;
  delete process.env.TLPE_DATA_KEY_VERSION;
  resetDataEncryptionState();

  assert.throws(() => getDataEncryptionInfo(), /32 octets/);
});

test('decryptText rejette un payload mal formé ou une version inconnue', () => {
  setSingleKey(Buffer.alloc(32, 11).toString('base64'));
  assert.throws(() => decryptText('enc-v1:missing-parts'), /Valeur chiffrée invalide/);

  const encrypted = encryptText('secret-version');
  const unknownVersionPayload = encrypted.replace('enc-v1:v1:', 'enc-v1:v99:');
  assert.throws(() => decryptText(unknownVersionPayload), /introuvable/);
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

test('rotateEncryptedBuffer re-chiffre aussi un buffer existant avec la version active', () => {
  process.env.TLPE_DATA_KEYS = [
    `2026-q1:${Buffer.alloc(32, 3).toString('base64')}`,
    `2026-q2:${Buffer.alloc(32, 4).toString('base64')}`,
  ].join(',');
  process.env.TLPE_DATA_KEY_VERSION = '2026-q1';
  delete process.env.TLPE_DATA_KEY;
  resetDataEncryptionState();

  const oldPayload = encryptBuffer(Buffer.from('piece-rotation', 'utf8'));
  assert.match(oldPayload.toString('utf8'), /2026-q1/);

  process.env.TLPE_DATA_KEY_VERSION = '2026-q2';
  resetDataEncryptionState();

  const rotated = rotateEncryptedBuffer(oldPayload);
  assert.match(rotated.toString('utf8'), /2026-q2/);
  assert.deepEqual(decryptBuffer(rotated), Buffer.from('piece-rotation', 'utf8'));
});
