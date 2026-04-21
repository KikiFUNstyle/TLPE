import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
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

const JWT_SECRET = process.env.TLPE_JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES_IN = '12h';

export function hashPassword(pwd: string): string {
  return bcrypt.hashSync(pwd, 10);
}

export function verifyPassword(pwd: string, hash: string): boolean {
  return bcrypt.compareSync(pwd, hash);
}

export function signToken(user: AuthUser): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function loadUserByEmail(email: string) {
  return db
    .prepare(
      `SELECT id, email, password_hash, nom, prenom, role, assujetti_id, actif
       FROM users WHERE lower(email) = lower(?)`,
    )
    .get(email) as
    | {
        id: number;
        email: string;
        password_hash: string;
        nom: string;
        prenom: string;
        role: Role;
        assujetti_id: number | null;
        actif: number;
      }
    | undefined;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
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
