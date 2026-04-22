import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../auth';
import { searchBanAddresses } from '../services/ban';

export const geocodingRouter = Router();

geocodingRouter.use(authMiddleware);

const searchQuerySchema = z.object({
  q: z.string().trim().min(3),
  limit: z.coerce.number().int().min(1).max(10).optional(),
});

geocodingRouter.get('/search', requireRole('admin', 'gestionnaire', 'controleur', 'contribuable'), async (req, res) => {
  const parsed = searchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parametres de recherche invalides' });
  }

  const { q, limit } = parsed.data;

  try {
    const suggestions = await searchBanAddresses(q, limit ?? 5);
    return res.json({ suggestions });
  } catch {
    return res.status(503).json({
      error: 'Service BAN indisponible, veuillez saisir l’adresse manuellement.',
    });
  }
});
