import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { db, logAudit } from '../db';
import { authMiddleware, requireRole } from '../auth';
import {
  assujettisImportTemplateCsv,
  decodeAssujettisImportFile,
  executeAssujettisImport,
  isValidSiret,
  type NormalizedImportRow,
  validateImportRows,
} from '../assujettisImport';
import { enrichAssujettiPayloadWithSirene, fetchSiretData } from '../services/apiEntreprise';

export const assujettisRouter = Router();

assujettisRouter.use(authMiddleware);

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

const assujettiImportSchema = z.object({
  fileName: z.string().min(1),
  contentBase64: z.string().min(1),
  mode: z.enum(['preview', 'commit']).default('preview'),
  onError: z.enum(['abort', 'skip']).default('abort'),
});

const asyncRoute = (handler: RequestHandler): RequestHandler => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

type AssujettiPayload = z.infer<typeof assujettiSchema>;

async function enrichAssujettiWithSiretIfNeeded(payload: AssujettiPayload): Promise<{
  enriched: AssujettiPayload;
  sireneStatus: 'ok' | 'cache' | 'radie' | 'degraded' | null;
  sireneMessage?: string;
}> {
  const siret = payload.siret?.trim();
  if (!siret) return { enriched: payload, sireneStatus: null };

  const result = await fetchSiretData(siret);
  if (result.status === 'radie') {
    return {
      enriched: payload,
      sireneStatus: 'radie',
      sireneMessage: result.message ?? 'SIRET radié',
    };
  }

  if (!result.data) {
    return {
      enriched: payload,
      sireneStatus: result.status,
      sireneMessage: result.message,
    };
  }

  return {
    enriched: enrichAssujettiPayloadWithSirene(payload, result.data),
    sireneStatus: result.status,
    sireneMessage: result.message,
  };
}

async function enrichImportRowsWithSiret(rows: NormalizedImportRow[]): Promise<{
  rows: NormalizedImportRow[];
  anomalies: Array<{ line: number; field: string; message: string }>;
  degradedMessages: string[];
}> {
  const anomalies: Array<{ line: number; field: string; message: string }> = [];
  const degradedMessages: string[] = [];
  const enrichedRows: NormalizedImportRow[] = [];

  for (const row of rows) {
    if (!row.siret) {
      enrichedRows.push(row);
      continue;
    }

    const result = await fetchSiretData(row.siret);

    if (result.status === 'radie') {
      anomalies.push({
        line: row.line,
        field: 'siret',
        message: result.message ?? 'SIRET radié (API Entreprise)',
      });
      continue;
    }

    if (result.status === 'degraded' && result.message) {
      degradedMessages.push(result.message);
    }

    if (!result.data) {
      enrichedRows.push(row);
      continue;
    }

    enrichedRows.push({
      ...row,
      raison_sociale: result.data.raisonSociale ?? row.raison_sociale,
      forme_juridique: result.data.formeJuridique ?? row.forme_juridique,
      adresse_rue: result.data.adresseRue ?? row.adresse_rue,
      adresse_cp: result.data.adresseCp ?? row.adresse_cp,
      adresse_ville: result.data.adresseVille ?? row.adresse_ville,
      adresse_pays: result.data.adressePays ?? row.adresse_pays,
    });
  }

  return {
    rows: enrichedRows,
    anomalies,
    degradedMessages,
  };
}

assujettisRouter.post('/', requireRole('admin', 'gestionnaire'), asyncRoute(async (req, res) => {
  const parsed = assujettiSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const input = parsed.data;
  if (input.siret && !isValidSiret(input.siret)) {
    return res.status(400).json({ error: 'SIRET invalide (controle Luhn)' });
  }

  const { enriched, sireneStatus, sireneMessage } = await enrichAssujettiWithSiretIfNeeded(input);
  if (sireneStatus === 'radie') {
    return res.status(422).json({ error: sireneMessage ?? 'SIRET radié (API Entreprise)' });
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
        enriched.raison_sociale,
        enriched.siret || null,
        enriched.forme_juridique || null,
        enriched.adresse_rue || null,
        enriched.adresse_cp || null,
        enriched.adresse_ville || null,
        enriched.adresse_pays || 'France',
        enriched.contact_nom || null,
        enriched.contact_prenom || null,
        enriched.contact_fonction || null,
        enriched.email || null,
        enriched.telephone || null,
        enriched.portail_actif ? 1 : 0,
        enriched.statut || 'actif',
        enriched.notes || null,
      );

    logAudit({ userId: req.user!.id, action: 'create', entite: 'assujetti', entiteId: Number(info.lastInsertRowid) });

    return res.status(201).json({
      id: info.lastInsertRowid,
      identifiant_tlpe: identifiant,
      sirene_status: sireneStatus,
      sirene_message: sireneMessage,
    });
  } catch (e) {
    const err = e as { message: string };
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Doublon (SIRET ou identifiant deja existant)' });
    }
    throw e;
  }
}));

assujettisRouter.put('/:id', requireRole('admin', 'gestionnaire'), asyncRoute(async (req, res) => {
  const parsed = assujettiSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const input = parsed.data;
  if (input.siret && !isValidSiret(input.siret)) {
    return res.status(400).json({ error: 'SIRET invalide (controle Luhn)' });
  }

  const { enriched, sireneStatus, sireneMessage } = await enrichAssujettiWithSiretIfNeeded(input);
  if (sireneStatus === 'radie') {
    return res.status(422).json({ error: sireneMessage ?? 'SIRET radié (API Entreprise)' });
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
      enriched.raison_sociale,
      enriched.siret || null,
      enriched.forme_juridique || null,
      enriched.adresse_rue || null,
      enriched.adresse_cp || null,
      enriched.adresse_ville || null,
      enriched.adresse_pays || 'France',
      enriched.contact_nom || null,
      enriched.contact_prenom || null,
      enriched.contact_fonction || null,
      enriched.email || null,
      enriched.telephone || null,
      enriched.portail_actif ? 1 : 0,
      enriched.statut || 'actif',
      enriched.notes || null,
      req.params.id,
    );

  if (info.changes === 0) return res.status(404).json({ error: 'Introuvable' });

  logAudit({ userId: req.user!.id, action: 'update', entite: 'assujetti', entiteId: Number(req.params.id) });
  return res.json({ ok: true, sirene_status: sireneStatus, sirene_message: sireneMessage });
}));

assujettisRouter.get('/import/template', requireRole('admin', 'gestionnaire'), (_req, res) => {
  const content = assujettisImportTemplateCsv();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="assujettis-template.csv"');
  res.send(content);
});

assujettisRouter.post('/import', requireRole('admin', 'gestionnaire'), asyncRoute(async (req, res) => {
  const parsed = assujettiImportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { fileName, contentBase64, mode, onError } = parsed.data;

  let decoded;
  try {
    decoded = decodeAssujettisImportFile(fileName, contentBase64);
  } catch {
    return res.status(400).json({ error: 'Fichier invalide ou format non supporte' });
  }

  const validation = validateImportRows(decoded);
  const enrichment = await enrichImportRowsWithSiret(validation.validRows);
  const validationAnomalies = [...validation.anomalies, ...enrichment.anomalies];

  if (mode === 'preview') {
    const uniqueMessages = Array.from(new Set(enrichment.degradedMessages));
    return res.json({
      total: validation.total,
      valid: enrichment.rows.length,
      rejected: validationAnomalies.length > 0 ? validation.total - enrichment.rows.length : 0,
      anomalies: validationAnomalies,
      sirene_status: uniqueMessages.length > 0 ? 'degraded' : 'ok',
      sirene_messages: uniqueMessages,
    });
  }

  if (validationAnomalies.length > 0 && onError === 'abort') {
    return res.status(400).json({
      error: 'Import annule: anomalies detectees',
      total: validation.total,
      valid: enrichment.rows.length,
      rejected: validation.total - enrichment.rows.length,
      anomalies: validationAnomalies,
    });
  }

  if (enrichment.rows.length === 0) {
    return res.status(400).json({
      error: 'Aucune ligne valide a importer',
      total: validation.total,
      rejected: validation.total,
      anomalies: validationAnomalies,
    });
  }

  const result = executeAssujettisImport(enrichment.rows, req.user!.id, req.ip ?? null);
  const uniqueMessages = Array.from(new Set(enrichment.degradedMessages));

  return res.status(201).json({
    ...result,
    rejected: validation.total - enrichment.rows.length,
    anomalies: validationAnomalies,
    sirene_status: uniqueMessages.length > 0 ? 'degraded' : 'ok',
    sirene_messages: uniqueMessages,
  });
}));

assujettisRouter.delete('/:id', requireRole('admin'), (req, res) => {
  const info = db.prepare('DELETE FROM assujettis WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Introuvable' });
  logAudit({ userId: req.user!.id, action: 'delete', entite: 'assujetti', entiteId: Number(req.params.id) });
  res.status(204).end();
});
