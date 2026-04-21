import { Router } from 'express';
import { z } from 'zod';
import { db, logAudit } from '../db';
import { authMiddleware, requireRole } from '../auth';

export const dispositifsRouter = Router();

dispositifsRouter.use(authMiddleware);

function genIdentifiantDispositif(): string {
  const y = new Date().getFullYear();
  const count = (db.prepare('SELECT COUNT(*) AS c FROM dispositifs').get() as { c: number }).c;
  return `DSP-${y}-${String(count + 1).padStart(6, '0')}`;
}

dispositifsRouter.get('/', (req, res) => {
  const { assujetti_id, statut, q } = req.query as {
    assujetti_id?: string;
    statut?: string;
    q?: string;
  };

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (req.user!.role === 'contribuable') {
    if (!req.user!.assujetti_id) return res.json([]);
    conditions.push('d.assujetti_id = ?');
    params.push(req.user!.assujetti_id);
  } else if (assujetti_id) {
    conditions.push('d.assujetti_id = ?');
    params.push(Number(assujetti_id));
  }
  if (statut) {
    conditions.push('d.statut = ?');
    params.push(statut);
  }
  if (q) {
    conditions.push('(d.identifiant LIKE ? OR d.adresse_ville LIKE ? OR d.adresse_rue LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT d.*, t.libelle AS type_libelle, t.categorie, z.libelle AS zone_libelle, z.coefficient AS zone_coefficient,
              a.raison_sociale AS assujetti_raison_sociale, a.identifiant_tlpe
       FROM dispositifs d
       LEFT JOIN types_dispositifs t ON t.id = d.type_id
       LEFT JOIN zones z ON z.id = d.zone_id
       LEFT JOIN assujettis a ON a.id = d.assujetti_id
       ${where}
       ORDER BY d.identifiant`,
    )
    .all(...params);
  res.json(rows);
});

const dispositifSchema = z.object({
  assujetti_id: z.number().int().positive(),
  type_id: z.number().int().positive(),
  zone_id: z.number().int().positive().nullable().optional(),
  adresse_rue: z.string().optional().nullable(),
  adresse_cp: z.string().optional().nullable(),
  adresse_ville: z.string().optional().nullable(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  surface: z.number().positive(),
  nombre_faces: z.number().int().min(1).max(4).default(1),
  date_pose: z.string().optional().nullable(),
  date_depose: z.string().optional().nullable(),
  statut: z.enum(['declare', 'controle', 'litigieux', 'depose', 'exonere']).optional(),
  exonere: z.boolean().optional(),
  notes: z.string().optional().nullable(),
});

dispositifsRouter.post('/', requireRole('admin', 'gestionnaire', 'controleur'), (req, res) => {
  const parsed = dispositifSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;
  // coherence dates (section 5.3)
  if (d.date_pose && d.date_depose && d.date_pose > d.date_depose) {
    return res.status(400).json({ error: 'Date de pose posterieure a la date de depose' });
  }
  const identifiant = genIdentifiantDispositif();
  const info = db
    .prepare(
      `INSERT INTO dispositifs (
        identifiant, assujetti_id, type_id, zone_id,
        adresse_rue, adresse_cp, adresse_ville,
        latitude, longitude,
        surface, nombre_faces, date_pose, date_depose,
        statut, exonere, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      identifiant,
      d.assujetti_id,
      d.type_id,
      d.zone_id ?? null,
      d.adresse_rue ?? null,
      d.adresse_cp ?? null,
      d.adresse_ville ?? null,
      d.latitude ?? null,
      d.longitude ?? null,
      d.surface,
      d.nombre_faces,
      d.date_pose ?? null,
      d.date_depose ?? null,
      d.statut ?? 'declare',
      d.exonere ? 1 : 0,
      d.notes ?? null,
    );
  logAudit({ userId: req.user!.id, action: 'create', entite: 'dispositif', entiteId: Number(info.lastInsertRowid) });
  res.status(201).json({ id: info.lastInsertRowid, identifiant });
});

dispositifsRouter.put('/:id', requireRole('admin', 'gestionnaire', 'controleur'), (req, res) => {
  const parsed = dispositifSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;
  if (d.date_pose && d.date_depose && d.date_pose > d.date_depose) {
    return res.status(400).json({ error: 'Date de pose posterieure a la date de depose' });
  }
  const info = db
    .prepare(
      `UPDATE dispositifs SET
        assujetti_id = ?, type_id = ?, zone_id = ?,
        adresse_rue = ?, adresse_cp = ?, adresse_ville = ?,
        latitude = ?, longitude = ?,
        surface = ?, nombre_faces = ?, date_pose = ?, date_depose = ?,
        statut = ?, exonere = ?, notes = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(
      d.assujetti_id,
      d.type_id,
      d.zone_id ?? null,
      d.adresse_rue ?? null,
      d.adresse_cp ?? null,
      d.adresse_ville ?? null,
      d.latitude ?? null,
      d.longitude ?? null,
      d.surface,
      d.nombre_faces,
      d.date_pose ?? null,
      d.date_depose ?? null,
      d.statut ?? 'declare',
      d.exonere ? 1 : 0,
      d.notes ?? null,
      req.params.id,
    );
  if (info.changes === 0) return res.status(404).json({ error: 'Introuvable' });
  logAudit({ userId: req.user!.id, action: 'update', entite: 'dispositif', entiteId: Number(req.params.id) });
  res.json({ ok: true });
});

dispositifsRouter.delete('/:id', requireRole('admin', 'gestionnaire'), (req, res) => {
  const info = db.prepare('DELETE FROM dispositifs WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Introuvable' });
  logAudit({ userId: req.user!.id, action: 'delete', entite: 'dispositif', entiteId: Number(req.params.id) });
  res.status(204).end();
});
