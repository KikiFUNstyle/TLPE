import { Router } from 'express';
import { z } from 'zod';
import {
  authMiddleware,
  consumeRecoveryCode,
  countRemainingRecoveryCodes,
  createTwoFactorSetupResponse,
  disableTwoFactorForUser,
  enableTwoFactorForUser,
  getStoredTwoFactorSecret,
  isTwoFactorEnabled,
  loadUserByEmail,
  loadUserById,
  signPartialAuthChallenge,
  signToken,
  toAuthUser,
  verifyPassword,
  verifyPartialAuthChallenge,
  verifyTotpCode,
} from '../auth';
import { logAudit } from '../db';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const verifyTwoFactorSchema = z
  .object({
    challenge_token: z.string().min(1),
    code: z.string().trim().min(6).optional(),
    recovery_code: z.string().trim().min(6).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.code && !value.recovery_code) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Un code TOTP ou un code de récupération est requis',
        path: ['code'],
      });
    }
    if (value.code && value.recovery_code) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Utiliser soit un code TOTP, soit un code de récupération',
        path: ['recovery_code'],
      });
    }
  });

const codeSchema = z.object({
  code: z.string().trim().min(6),
});

authRouter.post('/login', (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Donnees invalides' });

  const user = loadUserByEmail(parsed.data.email);
  if (!user || !user.actif) {
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }
  if (!verifyPassword(parsed.data.password, user.password_hash)) {
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }

  const authUser = toAuthUser(user);
  if (isTwoFactorEnabled(user)) {
    return res.json({
      requires_two_factor: true,
      challenge_token: signPartialAuthChallenge(user.id),
      user: {
        email: authUser.email,
        role: authUser.role,
        nom: authUser.nom,
        prenom: authUser.prenom,
      },
    });
  }

  const token = signToken(authUser);
  res.json({ token, user: authUser });
});

authRouter.post('/login/verify-2fa', (req, res) => {
  const parsed = verifyTwoFactorSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  let challenge;
  try {
    challenge = verifyPartialAuthChallenge(parsed.data.challenge_token);
  } catch {
    return res.status(401).json({ error: 'Challenge 2FA invalide ou expiré' });
  }

  const user = loadUserById(challenge.user_id);
  if (!user || !user.actif || !isTwoFactorEnabled(user)) {
    return res.status(401).json({ error: 'Session 2FA invalide' });
  }

  const authUser = toAuthUser(user);
  if (parsed.data.code) {
    const secret = getStoredTwoFactorSecret(user.id);
    if (!secret || !verifyTotpCode(secret, parsed.data.code)) {
      return res.status(401).json({ error: 'Code 2FA invalide' });
    }
    return res.json({ token: signToken(authUser), user: authUser, recovery_code_used: false });
  }

  if (!parsed.data.recovery_code || !consumeRecoveryCode(user.id, parsed.data.recovery_code)) {
    return res.status(401).json({ error: 'Code de récupération invalide' });
  }

  return res.json({
    token: signToken(authUser),
    user: authUser,
    recovery_code_used: true,
    recovery_codes_remaining: countRemainingRecoveryCodes(user.id),
  });
});

authRouter.get('/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

authRouter.post('/2fa/setup', authMiddleware, async (req, res) => {
  const user = loadUserById(req.user!.id);
  if (!user || !user.actif) {
    return res.status(404).json({ error: 'Utilisateur introuvable' });
  }

  const payload = await createTwoFactorSetupResponse(req.user!);
  return res.json(payload);
});

authRouter.post('/2fa/enable', authMiddleware, (req, res) => {
  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const recoveryCodes = enableTwoFactorForUser(req.user!.id, parsed.data.code);
    logAudit({
      userId: req.user!.id,
      action: 'enable-2fa',
      entite: 'user',
      entiteId: req.user!.id,
      ip: req.ip ?? null,
    });
    return res.json({ enabled: true, recovery_codes: recoveryCodes });
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
});

authRouter.post('/2fa/disable', authMiddleware, (req, res) => {
  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    disableTwoFactorForUser(req.user!.id, parsed.data.code);
    logAudit({
      userId: req.user!.id,
      action: 'disable-2fa',
      entite: 'user',
      entiteId: req.user!.id,
      ip: req.ip ?? null,
    });
    return res.json({ enabled: false });
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
});

authRouter.get('/2fa/status', authMiddleware, (req, res) => {
  const user = loadUserById(req.user!.id);
  const enabled = user ? isTwoFactorEnabled(user) : false;
  return res.json({
    enabled,
    recovery_codes_remaining: user ? countRemainingRecoveryCodes(user.id) : 0,
  });
});
