import bcrypt from 'bcryptjs';
import * as crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { generateSecret, generateSync, generateURI, verifySync } from 'otplib';
import QRCode from 'qrcode';
import type { NextFunction, Request, Response } from 'express';
import { db } from './db';

export type Role = 'admin' | 'gestionnaire' | 'financier' | 'controleur' | 'contribuable';

export interface AuthUser {
  id: number;
  email: string;
  role: Role;
  nom: string;
  prenom: string;
  assujetti_id: number | null;
}

export interface PartialAuthChallenge {
  user_id: number;
  purpose: 'login-2fa';
}

type UserRow = {
  id: number;
  email: string;
  password_hash: string;
  nom: string;
  prenom: string;
  role: Role;
  assujetti_id: number | null;
  actif: number;
  two_factor_enabled?: number;
  two_factor_secret_encrypted?: string | null;
};

const JWT_SECRET = process.env.TLPE_JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES_IN = '12h';
const TWO_FACTOR_CHALLENGE_EXPIRES_IN = '5m';
const TWO_FACTOR_SECRET = process.env.TLPE_2FA_SECRET || process.env.TLPE_JWT_SECRET || 'dev-2fa-secret-change-me';

const RECOVERY_CODE_SEGMENTS = 3;
const RECOVERY_CODE_SEGMENT_LENGTH = 4;
const RECOVERY_CODES_COUNT = 10;
const TOTP_EPOCH_TOLERANCE: [number, number] = [30, 30];

export function hashPassword(pwd: string): string {
  return bcrypt.hashSync(pwd, 10);
}

export function verifyPassword(pwd: string, hash: string): boolean {
  return bcrypt.compareSync(pwd, hash);
}

function normalizeSecretKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptValue(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', normalizeSecretKey(TWO_FACTOR_SECRET), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

function decryptValue(payload: string): string {
  const [ivBase64, tagBase64, encryptedBase64] = payload.split('.');
  if (!ivBase64 || !tagBase64 || !encryptedBase64) {
    throw new Error('Valeur chiffrée invalide');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    normalizeSecretKey(TWO_FACTOR_SECRET),
    Buffer.from(ivBase64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagBase64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function randomUppercaseToken(length: number): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let output = '';
  for (let index = 0; index < length; index += 1) {
    output += alphabet[bytes[index] % alphabet.length];
  }
  return output;
}

function buildRecoveryCode(): string {
  return Array.from({ length: RECOVERY_CODE_SEGMENTS }, () => randomUppercaseToken(RECOVERY_CODE_SEGMENT_LENGTH)).join('-');
}

function hashRecoveryCode(code: string): string {
  return bcrypt.hashSync(code, 10);
}

export function verifyRecoveryCode(code: string, hash: string): boolean {
  return bcrypt.compareSync(code, hash);
}

export function signToken(user: AuthUser): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function signPartialAuthChallenge(userId: number): string {
  return jwt.sign({ user_id: userId, purpose: 'login-2fa' satisfies PartialAuthChallenge['purpose'] }, JWT_SECRET, {
    expiresIn: TWO_FACTOR_CHALLENGE_EXPIRES_IN,
  });
}

export function verifyPartialAuthChallenge(token: string): PartialAuthChallenge {
  const payload = jwt.verify(token, JWT_SECRET) as PartialAuthChallenge & { iat: number; exp: number };
  if (payload.purpose !== 'login-2fa' || typeof payload.user_id !== 'number') {
    throw new Error('Challenge 2FA invalide');
  }
  return {
    user_id: payload.user_id,
    purpose: 'login-2fa',
  };
}

export function loadUserByEmail(email: string): UserRow | undefined {
  return db
    .prepare(
      `SELECT id, email, password_hash, nom, prenom, role, assujetti_id, actif,
              two_factor_enabled, two_factor_secret_encrypted
       FROM users WHERE lower(email) = lower(?)`,
    )
    .get(email) as UserRow | undefined;
}

export function loadUserById(id: number): UserRow | undefined {
  return db
    .prepare(
      `SELECT id, email, password_hash, nom, prenom, role, assujetti_id, actif,
              two_factor_enabled, two_factor_secret_encrypted
       FROM users WHERE id = ?`,
    )
    .get(id) as UserRow | undefined;
}

export function toAuthUser(user: Pick<UserRow, 'id' | 'email' | 'role' | 'nom' | 'prenom' | 'assujetti_id'>): AuthUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    nom: user.nom,
    prenom: user.prenom,
    assujetti_id: user.assujetti_id,
  };
}

export function isTwoFactorEnabled(user: Pick<UserRow, 'two_factor_enabled' | 'two_factor_secret_encrypted'>): boolean {
  return user.two_factor_enabled === 1 && typeof user.two_factor_secret_encrypted === 'string' && user.two_factor_secret_encrypted.length > 0;
}

export function createTwoFactorSetup(user: AuthUser) {
  const secret = generateSecret();
  const otpauthUrl = generateURI({
    secret,
    issuer: 'TLPE Manager',
    label: user.email,
    algorithm: 'sha1',
    digits: 6,
    period: 30,
  });
  return {
    secret,
    otpauth_url: otpauthUrl,
  };
}

export async function createTwoFactorSetupResponse(user: AuthUser) {
  const setup = createTwoFactorSetup(user);
  const qrCodeDataUrl = await QRCode.toDataURL(setup.otpauth_url, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 220,
  });

  db.prepare(
    `UPDATE users
     SET two_factor_pending_secret_encrypted = ?
     WHERE id = ?`,
  ).run(encryptValue(setup.secret), user.id);

  return {
    secret: setup.secret,
    otpauth_url: setup.otpauth_url,
    qr_code_data_url: qrCodeDataUrl,
  };
}

function getPendingTwoFactorSecret(userId: number): string | null {
  const row = db
    .prepare('SELECT two_factor_pending_secret_encrypted FROM users WHERE id = ?')
    .get(userId) as { two_factor_pending_secret_encrypted: string | null } | undefined;
  if (!row?.two_factor_pending_secret_encrypted) {
    return null;
  }
  return decryptValue(row.two_factor_pending_secret_encrypted);
}

export function getStoredTwoFactorSecret(userId: number): string | null {
  const row = db
    .prepare('SELECT two_factor_secret_encrypted FROM users WHERE id = ?')
    .get(userId) as { two_factor_secret_encrypted: string | null } | undefined;
  if (!row?.two_factor_secret_encrypted) {
    return null;
  }
  return decryptValue(row.two_factor_secret_encrypted);
}

export function verifyTotpCode(secret: string, code: string): boolean {
  const result = verifySync({
    secret,
    token: code.replace(/\s+/g, ''),
    epochTolerance: TOTP_EPOCH_TOLERANCE,
    algorithm: 'sha1',
    digits: 6,
    period: 30,
  });
  return result.valid;
}

function replaceRecoveryCodesForUser(userId: number, plaintextCodes: string[]) {
  const statement = db.transaction((codes: string[]) => {
    db.prepare('DELETE FROM codes_recuperation WHERE user_id = ?').run(userId);
    const insert = db.prepare(
      `INSERT INTO codes_recuperation (user_id, code_hash, used_at)
       VALUES (?, ?, NULL)`,
    );
    for (const code of codes) {
      insert.run(userId, hashRecoveryCode(code));
    }
  });
  statement(plaintextCodes);
}

export function enableTwoFactorForUser(userId: number, code: string): string[] {
  const secret = getPendingTwoFactorSecret(userId);
  if (!secret) {
    throw new Error('Aucune configuration 2FA en attente');
  }
  if (!verifyTotpCode(secret, code)) {
    throw new Error('Code TOTP invalide');
  }

  const recoveryCodes = Array.from({ length: RECOVERY_CODES_COUNT }, () => buildRecoveryCode());
  const statement = db.transaction((codes: string[]) => {
    db.prepare(
      `UPDATE users
       SET two_factor_enabled = 1,
           two_factor_secret_encrypted = ?,
           two_factor_pending_secret_encrypted = NULL
       WHERE id = ?`,
    ).run(encryptValue(secret), userId);
    replaceRecoveryCodesForUser(userId, codes);
  });
  statement(recoveryCodes);
  return recoveryCodes;
}

export function disableTwoFactorForUser(userId: number, code: string) {
  const secret = getStoredTwoFactorSecret(userId);
  if (!secret) {
    throw new Error('La double authentification n’est pas activée');
  }
  if (!verifyTotpCode(secret, code)) {
    throw new Error('Code TOTP invalide');
  }

  const statement = db.transaction(() => {
    db.prepare(
      `UPDATE users
       SET two_factor_enabled = 0,
           two_factor_secret_encrypted = NULL,
           two_factor_pending_secret_encrypted = NULL
       WHERE id = ?`,
    ).run(userId);
    db.prepare('DELETE FROM codes_recuperation WHERE user_id = ?').run(userId);
  });
  statement();
}

export function consumeRecoveryCode(userId: number, recoveryCode: string): boolean {
  const normalizedInput = recoveryCode.trim().toUpperCase();
  const rows = db
    .prepare(
      `SELECT id, code_hash
       FROM codes_recuperation
       WHERE user_id = ? AND used_at IS NULL
       ORDER BY id`,
    )
    .all(userId) as Array<{ id: number; code_hash: string }>;

  const matched = rows.find((row) => verifyRecoveryCode(normalizedInput, row.code_hash));
  if (!matched) {
    return false;
  }

  db.prepare(
    `UPDATE codes_recuperation
     SET used_at = datetime('now')
     WHERE id = ?`,
  ).run(matched.id);
  return true;
}

export function countRemainingRecoveryCodes(userId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM codes_recuperation
       WHERE user_id = ? AND used_at IS NULL`,
    )
    .get(userId) as { count: number };
  return row.count;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentification requise' });
  }

  const token = header.substring('Bearer '.length);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as AuthUser & { iat: number; exp: number };
    req.user = {
      id: payload.id,
      email: payload.email,
      role: payload.role,
      nom: payload.nom,
      prenom: payload.prenom,
      assujetti_id: payload.assujetti_id,
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Jeton invalide ou expire' });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Authentification requise' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Droits insuffisants' });
    }
    next();
  };
}
