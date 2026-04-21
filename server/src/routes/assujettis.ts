import { Router } from 'express';
import { z } from 'zod';
import { db, logAudit } from '../db';
import { authMiddleware, requireRole } from '../auth';

export const assujettisRouter = Router();

assujettisRouter.use(authMiddleware);

// Validation SIRET via algorithme de Luhn (specs section 4.1)
function isValidSiret(siret: string): boolean {
  if (!/^\d{14}$/.test(siret)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    let d = Number(siret[i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function genIdentifiant(): string {
  const y = new Date().getFullYear();
  const count = (db.prepare('SELECT COUNT(*) AS c FROM assujettis').get() as { c: number }).c;
  const next = String(count + 1).padStart(5, '0');
  return `TLPE-${y}-${next}`;
}

assujettisRouter.get('/', (req, res) => {
  const { q, statut } = req.query as { q?: string; statut?: string };

  // les contribuables ne voient que leur fiche
  if (req.user!.role === 'contribuable') {
    if (!req.user!.assujetti_id) return res.json([]);
    const row = db.prepare('SELECT * FROM assujettis WHERE id = ?').get(req.user!.assujetti_id);
    return res.json(row ? [row] : []);
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (q) {
    conditions.push('(raison_sociale LIKE ? OR siret LIKE ? OR identifiant_tlpe LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (statut) {
    conditions.push('statut = ?');
    params.push(statut);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM assujettis ${where} ORDER BY raison_sociale`).all(...params);
  res.json(rows);
});

assujettisRouter.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM assujettis WHERE id = ?').get(req.params.id) as
    | { id: number }
    | undefined;
  if (!row) return res.status(404).json({ error: 'Introuvable' });
  if (req.user!.role === 'contribuable' && req.user!.assujetti_id !== row.id) {
    return res.status(403).json({ error: 'Droits insuffisants' });
  }
  const dispositifs = db
    .prepare(
      `SELECT d.*, t.libelle AS type_libelle, t.categorie, z.libelle AS zone_libelle, z.coefficient AS zone_coefficient
       FROM dispositifs d
       LEFT JOIN types_dispositifs t ON t.id = d.type_id
       LEFT JOIN zones z ON z.id = d.zone_id
       WHERE d.assujetti_id = ?
       ORDER BY d.identifiant`,
    )
    .all(row.id);
  const declarations = db
    .prepare('SELECT * FROM declarations WHERE assujetti_id = ? ORDER BY annee DESC')
    .all(row.id);
  const titres = db
    .prepare('SELECT * FROM titres WHERE assujetti_id = ? ORDER BY annee DESC')
    .all(row.id);
  res.json({ ...row, dispositifs, declarations, titres });
});

const assujettiSchema = z.object({
  raison_sociale: z.string().min(1),
  siret: z.string().optional().nullable(),
  forme_juridique: z.string().optional().nullable(),
  adresse_rue: z.string().optional().nullable(),
  adresse_cp: z.string().optional().nullable(),
  adresse_ville: z.string().optional().nullable(),
  adresse_pays: z.string().optional().nullable(),
  contact_nom: z.string().optional().nullable(),
  contact_prenom: z.string().optional().nullable(),
  contact_fonction: z.string().optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal('')),
  telephone: z.string().optional().nullable(),
  portail_actif: z.boolean().optional(),
  statut: z.enum(['actif', 'inactif', 'radie', 'contentieux']).optional(),
  notes: z.string().optional().nullable(),
});

assujettisRouter.post('/', requireRole('admin', 'gestionnaire'), (req, res) => {
  const parsed = assujettiSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;
  if (d.siret && !isValidSiret(d.siret)) {
    return res.status(400).json({ error: 'SIRET invalide (controle Luhn)' });
  }
  const identifiant = genIdentifiant();
  try {
    const info = db
      .prepare(
        `INSERT INTO assujettis (
          identifiant_tlpe, raison_sociale, siret, forme_juridique,
          adresse_rue, adresse_cp, adresse_ville, adresse_pays,
          contact_nom, contact_prenom, contact_fonction,
          email, telephone, portail_actif, statut, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        identifiant,
        d.raison_sociale,
        d.siret || null,
        d.forme_juridique || null,
        d.adresse_rue || null,
        d.adresse_cp || null,
        d.adresse_ville || null,
        d.adresse_pays || 'France',
        d.contact_nom || null,
        d.contact_prenom || null,
        d.contact_fonction || null,
        d.email || null,
        d.telephone || null,
        d.portail_actif ? 1 : 0,
        d.statut || 'actif',
        d.notes || null,
      );
    logAudit({ userId: req.user!.id, action: 'create', entite: 'assujetti', entiteId: Number(info.lastInsertRowid) });
    res.status(201).json({ id: info.lastInsertRowid, identifiant_tlpe: identifiant });
  } catch (e) {
    const err = e as { message: string };
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Doublon (SIRET ou identifiant deja existant)' });
    }
    throw e;
  }
});

assujettisRouter.put('/:id', requireRole('admin', 'gestionnaire'), (req, res) => {
  const parsed = assujettiSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;
  if (d.siret && !isValidSiret(d.siret)) {
    return res.status(400).json({ error: 'SIRET invalide (controle Luhn)' });
  }
  const info = db
    .prepare(
      `UPDATE assujettis SET
        raison_sociale = ?, siret = ?, forme_juridique = ?,
        adresse_rue = ?, adresse_cp = ?, adresse_ville = ?, adresse_pays = ?,
        contact_nom = ?, contact_prenom = ?, contact_fonction = ?,
        email = ?, telephone = ?, portail_actif = ?, statut = ?, notes = ?,
        updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(
      d.raison_sociale,
      d.siret || null,
      d.forme_juridique || null,
      d.adresse_rue || null,
      d.adresse_cp || null,
      d.adresse_ville || null,
      d.adresse_pays || 'France',
      d.contact_nom || null,
      d.contact_prenom || null,
      d.contact_fonction || null,
      d.email || null,
      d.telephone || null,
      d.portail_actif ? 1 : 0,
      d.statut || 'actif',
      d.notes || null,
      req.params.id,
    );
  if (info.changes === 0) return res.status(404).json({ error: 'Introuvable' });
  logAudit({ userId: req.user!.id, action: 'update', entite: 'assujetti', entiteId: Number(req.params.id) });
  res.json({ ok: true });
});

assujettisRouter.delete('/:id', requireRole('admin'), (req, res) => {
  const info = db.prepare('DELETE FROM assujettis WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Introuvable' });
  logAudit({ userId: req.user!.id, action: 'delete', entite: 'assujetti', entiteId: Number(req.params.id) });
  res.status(204).end();
});
