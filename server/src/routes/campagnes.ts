import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../auth';
import { closeCampagne, createCampagne, getCampagneActive, listCampagnes, openCampagne } from '../campagnes';
import { db } from '../db';
import { sendInvitationsForCampagne } from '../invitations';
import { runRelancesDeclarations } from '../relances';

export const campagnesRouter = Router();

campagnesRouter.use(authMiddleware);
campagnesRouter.use(requireRole('admin', 'gestionnaire'));

const createCampagneSchema = z
  .object({
    annee: z.number().int().min(2008).max(2100),
    date_ouverture: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    date_limite_declaration: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    date_cloture: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    relance_j7_courrier: z.boolean().optional(),
  })
  .refine((data) => data.date_limite_declaration >= data.date_ouverture, {
    message: 'date_limite_declaration doit etre >= date_ouverture',
    path: ['date_limite_declaration'],
  })
  .refine((data) => data.date_cloture >= data.date_limite_declaration, {
    message: 'date_cloture doit etre >= date_limite_declaration',
    path: ['date_cloture'],
  });

campagnesRouter.get('/', (_req, res) => {
  const rows = listCampagnes();
  res.json(rows);
});

campagnesRouter.get('/active', (_req, res) => {
  const row = getCampagneActive();
  res.json({ campagne: row ?? null });
});

campagnesRouter.get('/:id/summary', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Identifiant de campagne invalide' });
  }

  const campagne = db
    .prepare(
      `SELECT c.*, u.email AS created_by_email
       FROM campagnes c
       LEFT JOIN users u ON u.id = c.created_by
       WHERE c.id = ?`,
    )
    .get(id);

  if (!campagne) return res.status(404).json({ error: 'Campagne introuvable' });

  const jobs = db
    .prepare(
      `SELECT id, type, statut, payload, created_at, started_at, completed_at
       FROM campagne_jobs
       WHERE campagne_id = ?
       ORDER BY id ASC`,
    )
    .all(id);

  const misesEnDemeure = (
    db.prepare('SELECT COUNT(*) AS c FROM mises_en_demeure WHERE campagne_id = ?').get(id) as { c: number }
  ).c;

  const declarationsByStatut = db
    .prepare(
      `SELECT statut, COUNT(*) AS total
       FROM declarations
       WHERE annee = ?
       GROUP BY statut`,
    )
    .all((campagne as { annee: number }).annee);

  res.json({
    campagne,
    jobs,
    mises_en_demeure: misesEnDemeure,
    declarations: declarationsByStatut,
  });
});

campagnesRouter.post('/', (req, res) => {
  const parsed = createCampagneSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const data = parsed.data;
    const id = createCampagne({
      annee: data.annee,
      date_ouverture: data.date_ouverture,
      date_limite_declaration: data.date_limite_declaration,
      date_cloture: data.date_cloture,
      relance_j7_courrier: data.relance_j7_courrier ?? false,
      created_by: req.user!.id,
    });
    return res.status(201).json({ id });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('existe deja')) {
        return res.status(409).json({ error: error.message });
      }
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Erreur interne' });
  }
});

campagnesRouter.post('/:id/open', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Identifiant de campagne invalide' });
  }

  try {
    const result = openCampagne(id, req.user!.id, req.ip ?? null);
    return res.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'Campagne introuvable') return res.status(404).json({ error: error.message });
      return res.status(409).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Erreur interne' });
  }
});

campagnesRouter.post('/:id/envoyer-invitations', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Identifiant de campagne invalide' });
  }

  const bodySchema = z.object({ assujetti_id: z.number().int().positive().optional() });
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const campagne = db.prepare('SELECT id, statut FROM campagnes WHERE id = ?').get(id) as
    | { id: number; statut: string }
    | undefined;
  if (!campagne) return res.status(404).json({ error: 'Campagne introuvable' });
  if (campagne.statut !== 'ouverte') {
    return res.status(409).json({ error: 'La campagne doit etre ouverte pour envoyer des invitations' });
  }

  const result = sendInvitationsForCampagne({
    campagneId: id,
    userId: req.user!.id,
    assujettiId: parsed.data.assujetti_id,
    mode: 'manual',
    ip: req.ip ?? null,
  });

  return res.json({ ok: true, ...result });
});

campagnesRouter.post('/:id/run-relances', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Identifiant de campagne invalide' });
  }

  const bodySchema = z
    .object({ run_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
    .optional();
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const campagne = db
    .prepare('SELECT id, statut, date_limite_declaration FROM campagnes WHERE id = ?')
    .get(id) as { id: number; statut: string; date_limite_declaration: string } | undefined;
  if (!campagne) return res.status(404).json({ error: 'Campagne introuvable' });
  if (campagne.statut !== 'ouverte') {
    return res.status(409).json({ error: 'La campagne doit etre ouverte pour lancer les relances' });
  }

  const result = runRelancesDeclarations({
    runDateIso: parsed.data?.run_date ?? undefined,
    userId: req.user!.id,
    ip: req.ip ?? null,
  });

  if (result.campagne_id !== campagne.id) {
    return res.status(409).json({ error: 'Aucune campagne active compatible pour cette date' });
  }

  return res.json({ ok: true, ...result });
});

campagnesRouter.post('/:id/close', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Identifiant de campagne invalide' });
  }

  try {
    const result = closeCampagne(id, req.user!.id, req.ip ?? null);
    return res.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'Campagne introuvable') return res.status(404).json({ error: error.message });
      return res.status(409).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Erreur interne' });
  }
});
