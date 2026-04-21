import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { db, logAudit } from '../db';
import { authMiddleware, requireRole } from '../auth';
import { calculerTLPE, findBareme, computeProrata } from '../calculator';

export const declarationsRouter = Router();

declarationsRouter.use(authMiddleware);

interface DispositifRow {
  id: number;
  assujetti_id: number;
  surface: number;
  nombre_faces: number;
  date_pose: string | null;
  date_depose: string | null;
  exonere: number;
  categorie: 'publicitaire' | 'preenseigne' | 'enseigne';
  zone_coefficient: number | null;
}

function genNumeroDeclaration(annee: number): string {
  const count = (
    db.prepare('SELECT COUNT(*) AS c FROM declarations WHERE annee = ?').get(annee) as { c: number }
  ).c;
  return `DEC-${annee}-${String(count + 1).padStart(6, '0')}`;
}

declarationsRouter.get('/', (req, res) => {
  const { annee, statut } = req.query as { annee?: string; statut?: string };

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (req.user!.role === 'contribuable') {
    if (!req.user!.assujetti_id) return res.json([]);
    conditions.push('d.assujetti_id = ?');
    params.push(req.user!.assujetti_id);
  }
  if (annee) {
    conditions.push('d.annee = ?');
    params.push(Number(annee));
  }
  if (statut) {
    conditions.push('d.statut = ?');
    params.push(statut);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT d.*, a.raison_sociale, a.identifiant_tlpe
       FROM declarations d
       LEFT JOIN assujettis a ON a.id = d.assujetti_id
       ${where}
       ORDER BY d.annee DESC, d.numero`,
    )
    .all(...params);
  res.json(rows);
});

declarationsRouter.get('/:id', (req, res) => {
  const decl = db.prepare('SELECT * FROM declarations WHERE id = ?').get(req.params.id) as
    | { id: number; assujetti_id: number }
    | undefined;
  if (!decl) return res.status(404).json({ error: 'Introuvable' });
  if (req.user!.role === 'contribuable' && req.user!.assujetti_id !== decl.assujetti_id) {
    return res.status(403).json({ error: 'Droits insuffisants' });
  }
  const lignes = db
    .prepare(
      `SELECT l.*, d.identifiant AS dispositif_identifiant, d.adresse_rue, d.adresse_ville,
              t.libelle AS type_libelle, t.categorie, z.libelle AS zone_libelle
       FROM lignes_declaration l
       LEFT JOIN dispositifs d ON d.id = l.dispositif_id
       LEFT JOIN types_dispositifs t ON t.id = d.type_id
       LEFT JOIN zones z ON z.id = d.zone_id
       WHERE l.declaration_id = ?`,
    )
    .all(decl.id);
  res.json({ ...decl, lignes });
});

const createSchema = z.object({
  assujetti_id: z.number().int().positive(),
  annee: z.number().int().min(2008).max(2100),
});

// Ouverture d'une declaration (brouillon)
declarationsRouter.post('/', requireRole('admin', 'gestionnaire', 'contribuable'), (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { assujetti_id, annee } = parsed.data;

  if (req.user!.role === 'contribuable' && req.user!.assujetti_id !== assujetti_id) {
    return res.status(403).json({ error: 'Droits insuffisants' });
  }
  const existing = db
    .prepare('SELECT id FROM declarations WHERE assujetti_id = ? AND annee = ?')
    .get(assujetti_id, annee) as { id: number } | undefined;
  if (existing) return res.status(409).json({ error: 'Declaration deja ouverte', id: existing.id });

  const numero = genNumeroDeclaration(annee);
  const info = db
    .prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut) VALUES (?, ?, ?, 'brouillon')`,
    )
    .run(numero, assujetti_id, annee);

  // Pre-remplissage : creation d'une ligne par dispositif actif de l'assujetti
  const dispositifs = db
    .prepare(
      `SELECT id, surface, nombre_faces, date_pose, date_depose FROM dispositifs
       WHERE assujetti_id = ? AND statut != 'depose'`,
    )
    .all(assujetti_id) as Array<{
    id: number;
    surface: number;
    nombre_faces: number;
    date_pose: string | null;
    date_depose: string | null;
  }>;
  const insertLigne = db.prepare(
    `INSERT INTO lignes_declaration
       (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, date_depose)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const dsp of dispositifs) {
    insertLigne.run(info.lastInsertRowid, dsp.id, dsp.surface, dsp.nombre_faces, dsp.date_pose, dsp.date_depose);
  }

  logAudit({ userId: req.user!.id, action: 'create', entite: 'declaration', entiteId: Number(info.lastInsertRowid) });
  res.status(201).json({ id: info.lastInsertRowid, numero });
});

// Mise a jour d'une ligne (ajout/modif d'un dispositif dans la declaration)
const updateLigneSchema = z.object({
  dispositif_id: z.number().int().positive(),
  surface_declaree: z.number().positive(),
  nombre_faces: z.number().int().min(1).max(4),
  date_pose: z.string().nullable().optional(),
  date_depose: z.string().nullable().optional(),
});

declarationsRouter.put('/:id/lignes', requireRole('admin', 'gestionnaire', 'contribuable'), (req, res) => {
  const decl = db.prepare('SELECT * FROM declarations WHERE id = ?').get(req.params.id) as
    | { id: number; assujetti_id: number; statut: string }
    | undefined;
  if (!decl) return res.status(404).json({ error: 'Introuvable' });
  if (req.user!.role === 'contribuable' && req.user!.assujetti_id !== decl.assujetti_id) {
    return res.status(403).json({ error: 'Droits insuffisants' });
  }
  if (decl.statut === 'validee' || decl.statut === 'soumise') {
    return res.status(409).json({ error: 'Declaration non modifiable' });
  }
  const parsed = z.array(updateLigneSchema).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  db.prepare('DELETE FROM lignes_declaration WHERE declaration_id = ?').run(decl.id);
  const insertLigne = db.prepare(
    `INSERT INTO lignes_declaration
       (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, date_depose)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const l of parsed.data) {
    insertLigne.run(
      decl.id,
      l.dispositif_id,
      l.surface_declaree,
      l.nombre_faces,
      l.date_pose ?? null,
      l.date_depose ?? null,
    );
  }
  res.json({ ok: true });
});

// Soumission : controles + hash + passage en statut "soumise"
declarationsRouter.post('/:id/soumettre', requireRole('admin', 'gestionnaire', 'contribuable'), (req, res) => {
  const decl = db.prepare('SELECT * FROM declarations WHERE id = ?').get(req.params.id) as
    | { id: number; assujetti_id: number; statut: string; annee: number }
    | undefined;
  if (!decl) return res.status(404).json({ error: 'Introuvable' });
  if (req.user!.role === 'contribuable' && req.user!.assujetti_id !== decl.assujetti_id) {
    return res.status(403).json({ error: 'Droits insuffisants' });
  }
  if (decl.statut !== 'brouillon') {
    return res.status(409).json({ error: `Statut ${decl.statut} : soumission impossible` });
  }
  const lignes = db
    .prepare('SELECT * FROM lignes_declaration WHERE declaration_id = ?')
    .all(decl.id) as Array<{ id: number; surface_declaree: number }>;
  if (lignes.length === 0) {
    return res.status(400).json({ error: 'Aucun dispositif declare' });
  }
  for (const l of lignes) {
    if (l.surface_declaree <= 0) {
      return res.status(400).json({ error: 'Surface invalide sur une ligne' });
    }
  }
  const snapshot = JSON.stringify({ id: decl.id, lignes });
  const hash = crypto.createHash('sha256').update(snapshot).digest('hex');
  db.prepare(
    `UPDATE declarations SET statut = 'soumise', date_soumission = datetime('now'), hash_soumission = ? WHERE id = ?`,
  ).run(hash, decl.id);

  logAudit({ userId: req.user!.id, action: 'submit', entite: 'declaration', entiteId: decl.id, details: { hash } });
  res.json({ ok: true, hash });
});

// Validation gestionnaire + calcul + passage en "validee"
declarationsRouter.post('/:id/valider', requireRole('admin', 'gestionnaire'), (req, res) => {
  const decl = db.prepare('SELECT * FROM declarations WHERE id = ?').get(req.params.id) as
    | { id: number; assujetti_id: number; statut: string; annee: number }
    | undefined;
  if (!decl) return res.status(404).json({ error: 'Introuvable' });
  if (decl.statut !== 'soumise' && decl.statut !== 'en_instruction') {
    return res.status(409).json({ error: `Validation impossible (statut ${decl.statut})` });
  }

  // Recuperation des lignes avec le contexte du dispositif (categorie, zone)
  const lignes = db
    .prepare(
      `SELECT l.id, l.dispositif_id, l.surface_declaree, l.nombre_faces, l.date_pose, l.date_depose,
              d.exonere, t.categorie, z.coefficient AS zone_coefficient
       FROM lignes_declaration l
       JOIN dispositifs d ON d.id = l.dispositif_id
       JOIN types_dispositifs t ON t.id = d.type_id
       LEFT JOIN zones z ON z.id = d.zone_id
       WHERE l.declaration_id = ?`,
    )
    .all(decl.id) as Array<{
    id: number;
    dispositif_id: number;
    surface_declaree: number;
    nombre_faces: number;
    date_pose: string | null;
    date_depose: string | null;
    exonere: number;
    categorie: 'publicitaire' | 'preenseigne' | 'enseigne';
    zone_coefficient: number | null;
  }>;

  let total = 0;
  const updateLigne = db.prepare(
    `UPDATE lignes_declaration SET
       bareme_id = ?, tarif_applique = ?, coefficient_zone = ?, prorata = ?, montant_ligne = ?
     WHERE id = ?`,
  );

  for (const l of lignes) {
    const result = calculerTLPE({
      annee: decl.annee,
      categorie: l.categorie,
      surface: l.surface_declaree,
      nombre_faces: l.nombre_faces,
      coefficient_zone: l.zone_coefficient ?? 1,
      date_pose: l.date_pose,
      date_depose: l.date_depose,
      exonere: !!l.exonere,
    });
    updateLigne.run(
      result.detail.bareme_id,
      result.detail.tarif_m2 ?? result.detail.tarif_fixe,
      result.detail.coefficient_zone,
      result.detail.prorata,
      result.detail.montant_arrondi,
      l.id,
    );
    total += result.detail.montant_arrondi;
  }
  // Arrondi global a l'euro inferieur (specs 6.2)
  const totalArrondi = Math.floor(total);
  db.prepare(
    `UPDATE declarations SET statut = 'validee', date_validation = datetime('now'), montant_total = ? WHERE id = ?`,
  ).run(totalArrondi, decl.id);

  logAudit({ userId: req.user!.id, action: 'validate', entite: 'declaration', entiteId: decl.id, details: { total: totalArrondi } });
  res.json({ ok: true, montant_total: totalArrondi });
});

// Rejet
declarationsRouter.post('/:id/rejeter', requireRole('admin', 'gestionnaire'), (req, res) => {
  const { motif } = req.body as { motif?: string };
  const info = db
    .prepare(
      `UPDATE declarations SET statut = 'rejetee', commentaires = ? WHERE id = ? AND statut IN ('soumise','en_instruction')`,
    )
    .run(motif || null, req.params.id);
  if (info.changes === 0) return res.status(409).json({ error: 'Rejet impossible' });
  logAudit({ userId: req.user!.id, action: 'reject', entite: 'declaration', entiteId: Number(req.params.id), details: { motif } });
  res.json({ ok: true });
});

// Utilitaires exportes pour tests
export { findBareme, computeProrata };
