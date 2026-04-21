import { Router } from 'express';
import { z } from 'zod';
import { db, logAudit } from '../db';
import { authMiddleware, requireRole } from '../auth';

export const contentieuxRouter = Router();

contentieuxRouter.use(authMiddleware);

function genNumero(): string {
  const y = new Date().getFullYear();
  const c = (db.prepare('SELECT COUNT(*) AS c FROM contentieux WHERE numero LIKE ?').get(`CTX-${y}-%`) as { c: number }).c;
  return `CTX-${y}-${String(c + 1).padStart(5, '0')}`;
}

contentieuxRouter.get('/', (req, res) => {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (req.user!.role === 'contribuable') {
    if (!req.user!.assujetti_id) return res.json([]);
    conditions.push('c.assujetti_id = ?');
    params.push(req.user!.assujetti_id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT c.*, a.raison_sociale FROM contentieux c
       LEFT JOIN assujettis a ON a.id = c.assujetti_id
       ${where}
       ORDER BY c.date_ouverture DESC`,
    )
    .all(...params);
  res.json(rows);
});

const createSchema = z.object({
  assujetti_id: z.number().int().positive(),
  titre_id: z.number().int().positive().nullable().optional(),
  type: z.enum(['gracieux', 'contentieux', 'moratoire', 'controle']),
  montant_litige: z.number().min(0).nullable().optional(),
  description: z.string().min(1),
});

contentieuxRouter.post('/', requireRole('admin', 'gestionnaire', 'contribuable'), (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;
  if (req.user!.role === 'contribuable' && req.user!.assujetti_id !== d.assujetti_id) {
    return res.status(403).json({ error: 'Droits insuffisants' });
  }
  const numero = genNumero();
  const info = db
    .prepare(
      `INSERT INTO contentieux (numero, assujetti_id, titre_id, type, montant_litige, description)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(numero, d.assujetti_id, d.titre_id ?? null, d.type, d.montant_litige ?? null, d.description);
  logAudit({ userId: req.user!.id, action: 'create', entite: 'contentieux', entiteId: Number(info.lastInsertRowid) });
  res.status(201).json({ id: info.lastInsertRowid, numero });
});

const decideSchema = z.object({
  statut: z.enum(['instruction', 'clos_maintenu', 'degrevement_partiel', 'degrevement_total', 'non_lieu']),
  decision: z.string().optional().nullable(),
});

contentieuxRouter.post('/:id/decider', requireRole('admin', 'gestionnaire', 'financier'), (req, res) => {
  const parsed = decideSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const closed = parsed.data.statut !== 'instruction';
  const info = db
    .prepare(
      `UPDATE contentieux SET statut = ?, decision = ?, date_cloture = ${closed ? "date('now')" : 'NULL'} WHERE id = ?`,
    )
    .run(parsed.data.statut, parsed.data.decision ?? null, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Introuvable' });
  logAudit({ userId: req.user!.id, action: 'decide', entite: 'contentieux', entiteId: Number(req.params.id), details: parsed.data });
  res.json({ ok: true });
});
