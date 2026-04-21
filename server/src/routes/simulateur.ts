import { Router } from 'express';
import { z } from 'zod';
import { calculerTLPE } from '../calculator';

export const simulateurRouter = Router();

const simSchema = z.object({
  annee: z.number().int().min(2008).max(2100),
  categorie: z.enum(['publicitaire', 'preenseigne', 'enseigne']),
  surface: z.number().positive(),
  nombre_faces: z.number().int().min(1).max(4).optional(),
  coefficient_zone: z.number().positive().optional(),
  date_pose: z.string().optional().nullable(),
  date_depose: z.string().optional().nullable(),
  exonere: z.boolean().optional(),
});

// Endpoint public pour le simulateur (section 6.3).
simulateurRouter.post('/', (req, res) => {
  const parsed = simSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const result = calculerTLPE(parsed.data);
    res.json(result);
  } catch (e) {
    const err = e as Error;
    res.status(400).json({ error: err.message });
  }
});
