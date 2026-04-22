import { Router } from 'express';
import { z } from 'zod';
import { db, logAudit } from '../db';
import { authMiddleware, requireRole } from '../auth';
import { activateBaremesForYear, getActiveBaremeYear, parseBaremesCsv, upsertBaremes, type BaremeInput, BaremeValidationError } from '../baremes';
import { importGeoJsonZones, normalizeGeometry } from '../zones';

export const referentielsRouter = Router();

referentielsRouter.use(authMiddleware);

// Zones
referentielsRouter.get('/zones', (_req, res) => {
  const zones = db.prepare('SELECT id, code, libelle, coefficient, description FROM zones ORDER BY code').all();
  res.json(zones);
});

referentielsRouter.get('/zones/geojson', (_req, res) => {
  const zones = db
    .prepare(
      `SELECT code, libelle, coefficient, description, geometry
       FROM zones
       WHERE geometry IS NOT NULL
       ORDER BY code`,
    )
    .all() as Array<{
      code: string;
      libelle: string;
      coefficient: number;
      description: string | null;
      geometry: string;
    }>;

  const features = zones.map((zone) => ({
    type: 'Feature' as const,
    properties: {
      code: zone.code,
      libelle: zone.libelle,
      coefficient: zone.coefficient,
      description: zone.description,
    },
    geometry: JSON.parse(zone.geometry),
  }));

  res.json({
    type: 'FeatureCollection',
    features,
  });
});

const zoneSchema = z.object({
  code: z.string().min(1),
  libelle: z.string().min(1),
  coefficient: z.number().positive(),
  description: z.string().optional().nullable(),
  geometry: z.object({
    type: z.enum(['Polygon', 'MultiPolygon']),
    coordinates: z.unknown(),
  }).optional().nullable(),
});

referentielsRouter.post('/zones', requireRole('admin'), (req, res) => {
  const parsed = zoneSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  let geometryJson: string | null = null;
  if (parsed.data.geometry) {
    try {
      geometryJson = JSON.stringify(normalizeGeometry(parsed.data.geometry));
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Geometrie invalide' });
    }
  }

  const info = db
    .prepare(
      `INSERT INTO zones (code, libelle, coefficient, description, geometry) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(parsed.data.code, parsed.data.libelle, parsed.data.coefficient, parsed.data.description ?? null, geometryJson);
  logAudit({ userId: req.user!.id, action: 'create', entite: 'zone', entiteId: Number(info.lastInsertRowid) });
  res.status(201).json({ id: info.lastInsertRowid });
});

const zonesImportBodySchema = z.object({
  geojson: z.unknown().optional(),
  content: z.string().min(1).optional(),
});

referentielsRouter.post('/zones/import', requireRole('admin'), (req, res) => {
  const parsed = zonesImportBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  let geojson: unknown = parsed.data.geojson;
  if (!geojson && parsed.data.content) {
    try {
      geojson = JSON.parse(parsed.data.content);
    } catch {
      return res.status(400).json({ error: 'Contenu GeoJSON invalide' });
    }
  }

  if (!geojson) {
    return res.status(400).json({ error: 'Aucun GeoJSON fourni' });
  }

  try {
    const summary = importGeoJsonZones(geojson);
    logAudit({ userId: req.user!.id, action: 'import', entite: 'zone', details: summary, ip: req.ip ?? null });
    return res.status(201).json(summary);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Import impossible' });
  }
});

// Types de dispositifs
referentielsRouter.get('/types', (_req, res) => {
  const types = db.prepare('SELECT * FROM types_dispositifs ORDER BY categorie, libelle').all();
  res.json(types);
});

const typeSchema = z.object({
  code: z.string().min(1),
  libelle: z.string().min(1),
  categorie: z.enum(['publicitaire', 'preenseigne', 'enseigne']),
});

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;
const isoDateFieldSchema = z
  .string()
  .regex(isoDateRegex, 'Date invalide (format attendu YYYY-MM-DD)')
  .optional()
  .nullable();

const exonerationSchema = z
  .object({
    type: z.enum(['droit', 'deliberee', 'eco']),
    critere: z.record(z.unknown()),
    taux: z.number().min(0).max(1),
    date_debut: isoDateFieldSchema,
    date_fin: isoDateFieldSchema,
    active: z.boolean().optional(),
  })
  .refine(
    (data) => !data.date_debut || !data.date_fin || data.date_fin >= data.date_debut,
    {
      message: 'date_fin doit etre superieure ou egale a date_debut',
      path: ['date_fin'],
    },
  );

referentielsRouter.post('/types', requireRole('admin'), (req, res) => {
  const parsed = typeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const info = db
    .prepare('INSERT INTO types_dispositifs (code, libelle, categorie) VALUES (?, ?, ?)')
    .run(parsed.data.code, parsed.data.libelle, parsed.data.categorie);
  logAudit({ userId: req.user!.id, action: 'create', entite: 'type_dispositif', entiteId: Number(info.lastInsertRowid) });
  res.status(201).json({ id: info.lastInsertRowid });
});

referentielsRouter.get('/exonerations', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, type, critere, taux, date_debut, date_fin, active
       FROM exonerations
       ORDER BY active DESC, id DESC`,
    )
    .all();
  res.json(rows);
});

referentielsRouter.post('/exonerations', requireRole('admin'), (req, res) => {
  const parsed = exonerationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const info = db
    .prepare(
      `INSERT INTO exonerations (type, critere, taux, date_debut, date_fin, active)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      parsed.data.type,
      JSON.stringify(parsed.data.critere),
      parsed.data.taux,
      parsed.data.date_debut ?? null,
      parsed.data.date_fin ?? null,
      parsed.data.active === false ? 0 : 1,
    );

  logAudit({ userId: req.user!.id, action: 'create', entite: 'exoneration', entiteId: Number(info.lastInsertRowid) });
  res.status(201).json({ id: info.lastInsertRowid });
});

referentielsRouter.delete('/exonerations/:id', requireRole('admin'), (req, res) => {
  const info = db.prepare('DELETE FROM exonerations WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Introuvable' });
  logAudit({ userId: req.user!.id, action: 'delete', entite: 'exoneration', entiteId: Number(req.params.id) });
  res.status(204).end();
});

// Baremes
referentielsRouter.get('/baremes', (req, res) => {
  const annee = req.query.annee ? Number(req.query.annee) : null;
  const rows = annee
    ? db.prepare('SELECT * FROM baremes WHERE annee = ? ORDER BY categorie, surface_min').all(annee)
    : db.prepare('SELECT * FROM baremes ORDER BY annee DESC, categorie, surface_min').all();
  res.json(rows);
});

referentielsRouter.get('/baremes/history', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT b.annee,
              COUNT(*) AS lignes,
              MIN(b.id) AS first_bareme_id,
              ba.activated_at
       FROM baremes b
       LEFT JOIN bareme_activation ba ON ba.annee = b.annee
       GROUP BY b.annee
       ORDER BY b.annee DESC`,
    )
    .all() as Array<{ annee: number; lignes: number; first_bareme_id: number; activated_at: string | null }>;
  res.json(rows);
});

referentielsRouter.get('/baremes/active-year', (_req, res) => {
  const year = getActiveBaremeYear(new Date());
  res.json({ annee_active: year });
});

const baremeSchema = z.object({
  annee: z.number().int().min(2008).max(2100),
  categorie: z.enum(['publicitaire', 'preenseigne', 'enseigne']),
  surface_min: z.number().min(0),
  surface_max: z.number().positive().nullable().optional(),
  tarif_m2: z.number().min(0).nullable().optional(),
  tarif_fixe: z.number().min(0).nullable().optional(),
  exonere: z.boolean().optional(),
  libelle: z.string().min(1),
});

referentielsRouter.post('/baremes', requireRole('admin'), (req, res) => {
  const parsed = baremeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;
  const info = db
    .prepare(
      `INSERT INTO baremes (annee, categorie, surface_min, surface_max, tarif_m2, tarif_fixe, exonere, libelle)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      d.annee,
      d.categorie,
      d.surface_min,
      d.surface_max ?? null,
      d.tarif_m2 ?? null,
      d.tarif_fixe ?? null,
      d.exonere ? 1 : 0,
      d.libelle,
    );
  logAudit({ userId: req.user!.id, action: 'create', entite: 'bareme', entiteId: Number(info.lastInsertRowid) });
  res.status(201).json({ id: info.lastInsertRowid });
});

const baremeImportSchema = z.object({
  csv: z.string().min(1).optional(),
  rows: z.array(baremeSchema).optional(),
});

referentielsRouter.post('/baremes/import', requireRole('admin'), (req, res) => {
  const parsed = baremeImportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  let rows: BaremeInput[] = [];
  if (parsed.data.csv) {
    try {
      rows = parseBaremesCsv(parsed.data.csv);
    } catch (error) {
      if (error instanceof BaremeValidationError) {
        return res.status(400).json({ error: error.message });
      }
      // eslint-disable-next-line no-console
      console.error('[TLPE] Erreur import baremes CSV', error);
      return res.status(500).json({ error: 'Erreur interne' });
    }
  } else if (parsed.data.rows) {
    rows = parsed.data.rows as BaremeInput[];
  }

  if (rows.length === 0) {
    return res.status(400).json({ error: 'Aucune ligne de bareme a importer' });
  }

  try {
    const summary = upsertBaremes(rows, req.user!.id, req.ip ?? null);
    return res.status(201).json(summary);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[TLPE] Erreur import baremes', error);
    return res.status(500).json({ error: 'Erreur interne' });
  }
});

referentielsRouter.post('/baremes/activate-year/:annee', requireRole('admin'), (req, res) => {
  const year = Number(req.params.annee);
  if (!Number.isInteger(year) || year < 2008 || year > 2100) {
    return res.status(400).json({ error: 'Annee invalide' });
  }

  const activated = activateBaremesForYear(year);
  res.json({ annee: year, activated });
});

referentielsRouter.delete('/baremes/:id', requireRole('admin'), (req, res) => {
  const info = db.prepare('DELETE FROM baremes WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Introuvable' });
  logAudit({ userId: req.user!.id, action: 'delete', entite: 'bareme', entiteId: Number(req.params.id) });
  res.status(204).end();
});
