import { Router } from 'express';
import { z } from 'zod';
import {
  authMiddleware,
  loadUserByEmail,
  signToken,
  verifyPassword,
} from '../auth';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
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

  const authUser = {
    id: user.id,
    email: user.email,
    role: user.role,
    nom: user.nom,
    prenom: user.prenom,
    assujetti_id: user.assujetti_id,
  };
  const token = signToken(authUser);
  res.json({ token, user: authUser });
});

authRouter.get('/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});
