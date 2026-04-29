import * as crypto from 'node:crypto';

type DataKey = {
  version: string;
  key: Buffer;
};

type DataKeyConfig = {
  active: DataKey;
  all: Map<string, Buffer>;
};

type ParsedEnvelope = {
  version: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
};

const ENVELOPE_PREFIX = 'enc-v1';
const FALLBACK_DEV_KEY = Buffer.alloc(32, 84).toString('base64');

let cachedConfig: DataKeyConfig | null = null;

function decodeBase64Key(base64: string, label: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) {
    throw new Error(`${label} doit decoder vers 32 octets pour AES-256-GCM`);
  }
  return key;
}

function buildConfig(): DataKeyConfig {
  const all = new Map<string, Buffer>();
  const isProduction = (process.env.NODE_ENV || '').trim().toLowerCase() === 'production';

  if (isProduction && !process.env.TLPE_DATA_KEY?.trim() && !process.env.TLPE_DATA_KEYS?.trim()) {
    throw new Error('TLPE_DATA_KEY ou TLPE_DATA_KEYS est obligatoire en production');
  }

  const multiKeyConfig = process.env.TLPE_DATA_KEYS?.trim();
  if (multiKeyConfig) {
    for (const entry of multiKeyConfig.split(',')) {
      const [version, base64] = entry.split(':');
      if (!version || !base64) {
        throw new Error('TLPE_DATA_KEYS doit suivre le format version:base64[,version:base64]');
      }
      all.set(version.trim(), decodeBase64Key(base64.trim(), `TLPE_DATA_KEYS(${version.trim()})`));
    }
    const activeVersion = (process.env.TLPE_DATA_KEY_VERSION || Array.from(all.keys())[0]).trim();
    const activeKey = all.get(activeVersion);
    if (!activeKey) {
      throw new Error(`TLPE_DATA_KEY_VERSION inconnu: ${activeVersion}`);
    }
    return { active: { version: activeVersion, key: activeKey }, all };
  }

  const singleKey = (process.env.TLPE_DATA_KEY || FALLBACK_DEV_KEY).trim();
  const activeVersion = (process.env.TLPE_DATA_KEY_VERSION || 'v1').trim();
  const key = decodeBase64Key(singleKey, 'TLPE_DATA_KEY');
  all.set(activeVersion, key);
  return { active: { version: activeVersion, key }, all };
}

function getConfig(): DataKeyConfig {
  if (!cachedConfig) {
    cachedConfig = buildConfig();
  }
  return cachedConfig;
}

function serializeEnvelope(version: string, iv: Buffer, tag: Buffer, ciphertext: Buffer): string {
  return [ENVELOPE_PREFIX, version, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

function parseEnvelope(payload: string): ParsedEnvelope {
  const [prefix, version, ivBase64, tagBase64, ciphertextBase64] = payload.split(':');
  if (!prefix || !version || !ivBase64 || !tagBase64 || !ciphertextBase64 || prefix !== ENVELOPE_PREFIX) {
    throw new Error('Valeur chiffrée invalide');
  }

  return {
    version,
    iv: Buffer.from(ivBase64, 'base64'),
    tag: Buffer.from(tagBase64, 'base64'),
    ciphertext: Buffer.from(ciphertextBase64, 'base64'),
  };
}

function decryptEnvelope(payload: string): Buffer {
  const parsed = parseEnvelope(payload);
  const key = getConfig().all.get(parsed.version);
  if (!key) {
    throw new Error(`Cle de dechiffrement introuvable pour la version ${parsed.version}`);
  }

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, parsed.iv);
    decipher.setAuthTag(parsed.tag);
    return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
  } catch (error) {
    throw new Error(`Echec du dechiffrement/integrite: ${(error as Error).message}`);
  }
}

export function resetDataEncryptionState() {
  cachedConfig = null;
}

export function getDataEncryptionInfo() {
  const config = getConfig();
  return {
    active_version: config.active.version,
    configured_versions: Array.from(config.all.keys()),
    source: process.env.TLPE_DATA_KEYS?.trim() ? 'TLPE_DATA_KEYS' : process.env.TLPE_DATA_KEY ? 'TLPE_DATA_KEY' : 'fallback-dev-key',
  };
}

export function isEncryptedText(payload: string): boolean {
  return payload.startsWith(`${ENVELOPE_PREFIX}:`);
}

export function isEncryptedBuffer(payload: Buffer): boolean {
  return payload.subarray(0, ENVELOPE_PREFIX.length + 1).toString('utf8') === `${ENVELOPE_PREFIX}:`;
}

export function encryptText(value: string): string {
  const config = getConfig();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.active.key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return serializeEnvelope(config.active.version, iv, tag, ciphertext);
}

export function decryptText(payload: string): string {
  return decryptEnvelope(payload).toString('utf8');
}

export function decryptTextOrLegacy(payload: string): string {
  return isEncryptedText(payload) ? decryptText(payload) : payload;
}

export function rotateEncryptedText(payload: string): string {
  if (!isEncryptedText(payload)) {
    return encryptText(payload);
  }
  const parsed = parseEnvelope(payload);
  if (parsed.version === getConfig().active.version) {
    return payload;
  }
  return encryptText(decryptText(payload));
}

export function encryptBuffer(value: Buffer): Buffer {
  return Buffer.from(encryptText(value.toString('base64')), 'utf8');
}

export function decryptBuffer(payload: Buffer): Buffer {
  return Buffer.from(decryptText(payload.toString('utf8')), 'base64');
}

export function decryptBufferOrLegacy(payload: Buffer): Buffer {
  return isEncryptedBuffer(payload) ? decryptBuffer(payload) : payload;
}

export function rotateEncryptedBuffer(payload: Buffer): Buffer {
  if (!isEncryptedBuffer(payload)) {
    return encryptBuffer(payload);
  }
  const textPayload = payload.toString('utf8');
  const parsed = parseEnvelope(textPayload);
  if (parsed.version === getConfig().active.version) {
    return payload;
  }
  return encryptBuffer(decryptBuffer(payload));
}
