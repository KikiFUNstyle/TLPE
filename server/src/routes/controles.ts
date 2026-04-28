import * as crypto from 'node:crypto';
import { Router } from 'express';
import PDFDocument from 'pdfkit';
import XLSX from 'xlsx';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../auth';
import { calculerTLPE } from '../calculator';
import { db, logAudit } from '../db';
import { computeContentieuxResponseDeadline, normalizeIsoDate } from '../contentieuxDeadline';
import { findZoneIdByPoint } from '../zones';

export const controlesRouter = Router();

controlesRouter.use(authMiddleware);
controlesRouter.use(requireRole('admin', 'gestionnaire', 'controleur'));

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide (format attendu YYYY-MM-DD)');

const createDispositifSchema = z.object({
  assujetti_id: z.number().int().positive(),
  type_id: z.number().int().positive(),
  zone_id: z.number().int().positive().nullable().optional(),
  adresse_rue: z.string().trim().min(1).optional().nullable(),
  adresse_cp: z.string().trim().min(1).optional().nullable(),
  adresse_ville: z.string().trim().min(1).optional().nullable(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  surface: z.number().positive(),
  nombre_faces: z.number().int().min(1).max(4).default(1),
  statut: z.enum(['declare', 'controle', 'litigieux', 'depose', 'exonere']).optional(),
  notes: z.string().trim().min(1).optional().nullable(),
});

const controleSchema = z
  .object({
    dispositif_id: z.number().int().positive().nullable().optional(),
    create_dispositif: createDispositifSchema.nullable().optional(),
    date_controle: isoDateSchema,
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    surface_mesuree: z.number().positive(),
    nombre_faces_mesurees: z.number().int().min(1).max(4),
    ecart_detecte: z.boolean(),
    ecart_description: z.string().trim().max(2000).optional().nullable(),
    statut: z.enum(['saisi', 'cloture']).optional(),
  })
  .superRefine((value, ctx) => {
    const hasExisting = typeof value.dispositif_id === 'number';
    const hasCreate = Boolean(value.create_dispositif);
    if (!hasExisting && !hasCreate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dispositif_id'],
        message: 'Un contrôle doit être rattaché à un dispositif existant ou créer une nouvelle fiche dispositif',
      });
    }
    if (hasExisting && hasCreate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['create_dispositif'],
        message: 'Choisissez soit un dispositif existant, soit la création d’une nouvelle fiche',
      });
    }
    if (value.ecart_detecte && !value.ecart_description?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ecart_description'],
        message: 'La description de l’écart est obligatoire quand une anomalie est signalée',
      });
    }
  });

function generateDispositifIdentifiant(): string {
  const year = new Date().getFullYear();
  const maxId = (db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM dispositifs').get() as { max_id: number }).max_id;
  return `DSP-${year}-${String(Number(maxId) + 1).padStart(6, '0')}`;
}

function createDispositifFromControle(input: z.infer<typeof createDispositifSchema>, userId: number) {
  const computedZoneId =
    input.zone_id ??
    (input.latitude !== null && input.latitude !== undefined && input.longitude !== null && input.longitude !== undefined
      ? findZoneIdByPoint({ latitude: input.latitude, longitude: input.longitude })
      : null);
  const identifiant = generateDispositifIdentifiant();
  const info = db
    .prepare(
      `INSERT INTO dispositifs (
        identifiant, assujetti_id, type_id, zone_id,
        adresse_rue, adresse_cp, adresse_ville,
        latitude, longitude, surface, nombre_faces,
        statut, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      identifiant,
      input.assujetti_id,
      input.type_id,
      computedZoneId,
      input.adresse_rue ?? null,
      input.adresse_cp ?? null,
      input.adresse_ville ?? null,
      input.latitude ?? null,
      input.longitude ?? null,
      input.surface,
      input.nombre_faces,
      input.statut ?? 'controle',
      input.notes ?? 'Créé depuis un constat terrain',
    );

  const dispositifId = Number(info.lastInsertRowid);
  logAudit({
    userId,
    action: 'create',
    entite: 'dispositif',
    entiteId: dispositifId,
    details: { origine: 'controle-terrain', identifiant },
  });

  return { dispositifId, identifiant };
}

function isForeignKeyConstraintError(error: unknown): boolean {
  return error instanceof Error && /foreign key constraint failed/i.test(error.message);
}

function ensureDispositifExists(dispositifId: number) {
  return db.prepare('SELECT id, identifiant, surface, nombre_faces FROM dispositifs WHERE id = ?').get(dispositifId) as
    | { id: number; identifiant: string; surface: number; nombre_faces: number }
    | undefined;
}

const DISPOSITIF_NOT_FOUND_ERROR = 'controle-dispositif-not-found';

const reportRequestSchema = z.object({
  controle_ids: z.array(z.number().int().positive()).min(1, 'Sélectionnez au moins un contrôle'),
  format: z.enum(['pdf', 'xlsx']),
});

const rectificationRequestSchema = z.object({
  controle_ids: z.array(z.number().int().positive()).min(1, 'Sélectionnez au moins un contrôle'),
  mode: z.enum(['declaration_office', 'demande_contribuable']),
});

const redressementRequestSchema = z.object({
  controle_ids: z.array(z.number().int().positive()).min(1, 'Sélectionnez au moins un contrôle'),
});

type ControleReportSourceRow = {
  id: number;
  dispositif_id: number | null;
  agent_id: number;
  date_controle: string;
  statut: 'saisi' | 'cloture';
  surface_mesuree: number;
  nombre_faces_mesurees: number;
  ecart_detecte: number;
  ecart_description: string | null;
  dispositif_identifiant: string | null;
  surface_declaree: number | null;
  nombre_faces_declares: number | null;
  date_pose: string | null;
  date_depose: string | null;
  dispositif_exonere: number | null;
  assujetti_id: number | null;
  assujetti_raison_sociale: string | null;
  categorie: 'publicitaire' | 'preenseigne' | 'enseigne' | null;
  type_libelle: string | null;
  zone_coefficient: number | null;
};

type ControleReportRow = {
  controle_id: number;
  dispositif_id: number | null;
  dispositif_identifiant: string | null;
  assujetti_id: number | null;
  assujetti_raison_sociale: string | null;
  date_controle: string;
  statut: 'saisi' | 'cloture';
  categorie: 'publicitaire' | 'preenseigne' | 'enseigne' | null;
  type_libelle: string | null;
  surface_declaree: number | null;
  surface_mesuree: number;
  nombre_faces_declares: number | null;
  nombre_faces_mesurees: number;
  ecart_detecte: boolean;
  ecart_description: string | null;
  taxe_declaree: number;
  taxe_mesuree: number;
  delta_montant_taxe: number;
  date_pose: string | null;
  date_depose: string | null;
};

function uniquePositiveIntegers(values: number[]): number[] {
  return Array.from(new Set(values.filter((value) => Number.isInteger(value) && value > 0)));
}

function allocateDeclarationNumeroForYear(annee: number): string {
  const info = db
    .prepare(
      `INSERT INTO declaration_sequences (annee, numero_ordre)
       SELECT ?, COALESCE(MAX(numero_ordre), 0) + 1
       FROM declaration_sequences
       WHERE annee = ?`,
    )
    .run(annee, annee);
  const row = db.prepare('SELECT numero_ordre FROM declaration_sequences WHERE id = ?').get(Number(info.lastInsertRowid)) as
    | { numero_ordre: number }
    | undefined;
  if (!row) throw new Error(`Impossible de réserver un numéro de déclaration pour ${annee}`);
  return `DEC-${annee}-${String(row.numero_ordre).padStart(6, '0')}`;
}

function allocateContentieuxNumeroForYear(annee: number): string {
  const info = db
    .prepare(
      `INSERT INTO contentieux_sequences (annee, numero_ordre)
       SELECT ?, COALESCE(MAX(numero_ordre), 0) + 1
       FROM contentieux_sequences
       WHERE annee = ?`,
    )
    .run(annee, annee);
  const row = db.prepare('SELECT numero_ordre FROM contentieux_sequences WHERE id = ?').get(Number(info.lastInsertRowid)) as
    | { numero_ordre: number }
    | undefined;
  if (!row) throw new Error(`Impossible de réserver un numéro de contentieux pour ${annee}`);
  return `CTX-${annee}-${String(row.numero_ordre).padStart(5, '0')}`;
}

function displayActorLabel(user: { prenom?: string | null; nom?: string | null; email?: string | null } | undefined): string {
  if (!user) return 'Système TLPE';
  const fullName = `${user.prenom ?? ''} ${user.nom ?? ''}`.trim();
  return fullName || user.email || 'Système TLPE';
}

function buildControleReportRows(controleIds: number[]): ControleReportRow[] {
  const ids = uniquePositiveIntegers(controleIds);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT c.id,
              c.dispositif_id,
              c.agent_id,
              c.date_controle,
              c.statut,
              c.surface_mesuree,
              c.nombre_faces_mesurees,
              c.ecart_detecte,
              c.ecart_description,
              d.identifiant AS dispositif_identifiant,
              d.surface AS surface_declaree,
              d.nombre_faces AS nombre_faces_declares,
              d.date_pose,
              d.date_depose,
              d.exonere AS dispositif_exonere,
              d.assujetti_id,
              a.raison_sociale AS assujetti_raison_sociale,
              t.categorie,
              t.libelle AS type_libelle,
              z.coefficient AS zone_coefficient
       FROM controles c
       LEFT JOIN dispositifs d ON d.id = c.dispositif_id
       LEFT JOIN assujettis a ON a.id = d.assujetti_id
       LEFT JOIN types_dispositifs t ON t.id = d.type_id
       LEFT JOIN zones z ON z.id = d.zone_id
       WHERE c.id IN (${placeholders})
       ORDER BY c.date_controle DESC, c.id DESC`,
    )
    .all(...ids) as ControleReportSourceRow[];

  return rows.map((row) => {
    const annee = Number(row.date_controle.slice(0, 4));
    const declaredSurface = row.surface_declaree ?? row.surface_mesuree;
    const declaredFaces = row.nombre_faces_declares ?? row.nombre_faces_mesurees;
    const coefficientZone = row.zone_coefficient ?? 1;
    const categorie = row.categorie ?? 'enseigne';
    const taxeDeclaree = calculerTLPE({
      annee,
      categorie,
      surface: declaredSurface,
      nombre_faces: declaredFaces,
      coefficient_zone: coefficientZone,
      date_pose: row.date_pose,
      date_depose: row.date_depose,
      exonere: !!row.dispositif_exonere,
      assujetti_id: row.assujetti_id ?? undefined,
    }).montant;
    const taxeMesuree = calculerTLPE({
      annee,
      categorie,
      surface: row.surface_mesuree,
      nombre_faces: row.nombre_faces_mesurees,
      coefficient_zone: coefficientZone,
      date_pose: row.date_pose,
      date_depose: row.date_depose,
      exonere: !!row.dispositif_exonere,
      assujetti_id: row.assujetti_id ?? undefined,
    }).montant;

    return {
      controle_id: row.id,
      dispositif_id: row.dispositif_id,
      dispositif_identifiant: row.dispositif_identifiant,
      assujetti_id: row.assujetti_id,
      assujetti_raison_sociale: row.assujetti_raison_sociale,
      date_controle: row.date_controle,
      statut: row.statut,
      categorie: row.categorie,
      type_libelle: row.type_libelle,
      surface_declaree: row.surface_declaree,
      surface_mesuree: row.surface_mesuree,
      nombre_faces_declares: row.nombre_faces_declares,
      nombre_faces_mesurees: row.nombre_faces_mesurees,
      ecart_detecte: Number(row.ecart_detecte) === 1,
      ecart_description: row.ecart_description,
      taxe_declaree: taxeDeclaree,
      taxe_mesuree: taxeMesuree,
      delta_montant_taxe: taxeMesuree - taxeDeclaree,
      date_pose: row.date_pose,
      date_depose: row.date_depose,
    };
  });
}

function buildControleReportPdfBuffer(rows: ControleReportRow[]) {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks: Buffer[] = [];
    const totalDelta = rows.reduce((sum, row) => sum + row.delta_montant_taxe, 0);
    const ecarts = rows.filter((row) => row.ecart_detecte);

    doc.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('Rapport de contrôle automatique', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#555').text(`Constats sélectionnés : ${rows.length} • Écarts : ${ecarts.length} • Delta total : ${totalDelta.toFixed(2)} EUR`, {
      align: 'center',
    });
    doc.moveDown(1).fillColor('black');

    for (const row of rows) {
      doc.fontSize(12).fillColor('#000091').text(`${row.dispositif_identifiant ?? 'Constat terrain'} — contrôle #${row.controle_id}`);
      doc.fontSize(10).fillColor('black');
      doc.text(`Assujetti : ${row.assujetti_raison_sociale ?? 'À confirmer'}`);
      doc.text(`Date contrôle : ${row.date_controle} • Type : ${row.type_libelle ?? row.categorie ?? 'Non renseigné'}`);
      doc.text(
        `Surface déclarée : ${row.surface_declaree ?? '-'} m² / ${row.nombre_faces_declares ?? '-'} face(s) • Mesurée : ${row.surface_mesuree} m² / ${row.nombre_faces_mesurees} face(s)`,
      );
      doc.text(
        `Taxe déclarée : ${row.taxe_declaree.toFixed(2)} EUR • Taxe recalculée : ${row.taxe_mesuree.toFixed(2)} EUR • Delta : ${row.delta_montant_taxe.toFixed(2)} EUR`,
      );
      doc.text(`Anomalie : ${row.ecart_detecte ? 'Oui' : 'Non'}${row.ecart_description ? ` — ${row.ecart_description}` : ''}`, {
        paragraphGap: 8,
      });
      doc.moveDown(0.5);
    }

    doc.end();
  });
}

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function appendReportHeaders(
  res: import('express').Response,
  payload: { filename: string; hash: string; generatedAt: string },
) {
  res.setHeader('Content-Disposition', `attachment; filename="${payload.filename}"`);
  res.setHeader('X-TLPE-Generated-At', payload.generatedAt);
  res.setHeader('X-TLPE-Content-Hash', payload.hash);
}

function reportDateFromRows(rows: ControleReportRow[]): string {
  const dates = rows.map((row) => row.date_controle).filter(Boolean).sort();
  return dates.at(-1) ?? new Date().toISOString().slice(0, 10);
}

function buildControleReportWorkbook(rows: ControleReportRow[]) {
  const worksheet = XLSX.utils.aoa_to_sheet([
    [
      'Controle ID',
      'Date',
      'Assujetti',
      'Dispositif',
      'Type',
      'Surface declaree',
      'Surface mesuree',
      'Faces declarees',
      'Faces mesurees',
      'Taxe declaree',
      'Taxe mesuree',
      'Delta taxe',
      'Ecart detecte',
      'Description',
    ],
    ...rows.map((row) => [
      row.controle_id,
      row.date_controle,
      row.assujetti_raison_sociale ?? '',
      row.dispositif_identifiant ?? '',
      row.type_libelle ?? row.categorie ?? '',
      row.surface_declaree ?? '',
      row.surface_mesuree,
      row.nombre_faces_declares ?? '',
      row.nombre_faces_mesurees,
      row.taxe_declaree,
      row.taxe_mesuree,
      row.delta_montant_taxe,
      row.ecart_detecte ? 'oui' : 'non',
      row.ecart_description ?? '',
    ]),
  ]);
  worksheet['!cols'] = [
    { wch: 12 },
    { wch: 12 },
    { wch: 28 },
    { wch: 20 },
    { wch: 24 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 12 },
    { wch: 50 },
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Rapport contrôles');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function groupControleRowsByAssujettiYear(rows: ControleReportRow[]) {
  const groups = new Map<string, ControleReportRow[]>();
  for (const row of rows) {
    if (!row.assujetti_id) continue;
    const annee = Number(row.date_controle.slice(0, 4));
    const key = `${row.assujetti_id}:${annee}`;
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }
  return groups;
}

function latestUniqueRowsByDispositif(rows: ControleReportRow[]): ControleReportRow[] {
  const byDispositif = new Map<number, ControleReportRow>();
  for (const row of rows) {
    if (!row.dispositif_id) continue;
    if (!byDispositif.has(row.dispositif_id)) {
      byDispositif.set(row.dispositif_id, row);
    }
  }
  return Array.from(byDispositif.values());
}

function findNonClosedControle(rows: ControleReportRow[]): ControleReportRow | undefined {
  return rows.find((row) => row.statut !== 'cloture');
}

const createControleTransaction = db.transaction(
  (input: z.infer<typeof controleSchema>, userId: number, ip: string | null | undefined) => {
    let dispositifId = input.dispositif_id ?? null;
    let createdDispositifIdentifiant: string | null = null;

    if (input.create_dispositif) {
      const created = createDispositifFromControle(input.create_dispositif, userId);
      dispositifId = created.dispositifId;
      createdDispositifIdentifiant = created.identifiant;
    } else if (dispositifId !== null) {
      const existingDispositif = ensureDispositifExists(dispositifId);
      if (!existingDispositif) {
        throw new Error(DISPOSITIF_NOT_FOUND_ERROR);
      }
    }

    const info = db
      .prepare(
        `INSERT INTO controles (
          dispositif_id, agent_id, date_controle, latitude, longitude,
          surface_mesuree, nombre_faces_mesurees, ecart_detecte, ecart_description, statut
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        dispositifId,
        userId,
        input.date_controle,
        input.latitude,
        input.longitude,
        input.surface_mesuree,
        input.nombre_faces_mesurees,
        input.ecart_detecte ? 1 : 0,
        input.ecart_description?.trim() || null,
        input.statut ?? 'saisi',
      );

    const controleId = Number(info.lastInsertRowid);

    if (dispositifId !== null) {
      db.prepare(`UPDATE dispositifs SET statut = 'controle', updated_at = datetime('now') WHERE id = ?`).run(dispositifId);
    }

    logAudit({
      userId,
      action: 'create',
      entite: 'controle',
      entiteId: controleId,
      details: {
        dispositif_id: dispositifId,
        created_dispositif_identifiant: createdDispositifIdentifiant,
        ecart_detecte: input.ecart_detecte,
        date_controle: input.date_controle,
      },
      ip: ip ?? null,
    });

    return {
      id: controleId,
      dispositif_id: dispositifId,
      created_dispositif_identifiant: createdDispositifIdentifiant,
      photos_count: 0,
    };
  },
);

controlesRouter.get('/', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT c.id,
              c.dispositif_id,
              c.agent_id,
              c.date_controle,
              c.latitude,
              c.longitude,
              c.surface_mesuree,
              c.nombre_faces_mesurees,
              c.ecart_detecte,
              c.ecart_description,
              c.statut,
              c.created_at,
              c.updated_at,
              d.identifiant AS dispositif_identifiant,
              d.surface AS dispositif_surface,
              d.nombre_faces AS dispositif_nombre_faces,
              a.raison_sociale AS assujetti_raison_sociale,
              trim(coalesce(u.prenom, '') || ' ' || coalesce(u.nom, '')) AS agent_nom,
              COALESCE((
                SELECT COUNT(*)
                FROM pieces_jointes pj
                WHERE pj.entite = 'controle'
                  AND pj.entite_id = c.id
                  AND pj.deleted_at IS NULL
              ), 0) AS photos_count
       FROM controles c
       LEFT JOIN dispositifs d ON d.id = c.dispositif_id
       LEFT JOIN assujettis a ON a.id = d.assujetti_id
       LEFT JOIN users u ON u.id = c.agent_id
       ORDER BY c.date_controle DESC, c.id DESC`,
    )
    .all() as Array<Record<string, unknown>>;

  res.json(
    rows.map((row) => ({
      ...row,
      ecart_detecte: Number(row.ecart_detecte) === 1,
      photos_count: Number(row.photos_count ?? 0),
    })),
  );
});

controlesRouter.post('/report', requireRole('admin', 'gestionnaire'), async (req, res) => {
  const parsed = reportRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const rows = buildControleReportRows(parsed.data.controle_ids);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Aucun contrôle trouvé pour la sélection demandée' });
    }
    const nonClosedControle = findNonClosedControle(rows);
    if (nonClosedControle) {
      return res.status(409).json({
        error: `Le contrôle #${nonClosedControle.controle_id} doit être clôturé avant génération du rapport.`,
      });
    }

    const exportedAt = reportDateFromRows(rows);
    const filename = `rapport-controles-${exportedAt}.${parsed.data.format}`;

    if (parsed.data.format === 'pdf') {
      const pdf = await buildControleReportPdfBuffer(rows);
      const hash = sha256Hex(pdf);
      logAudit({
        userId: req.user!.id,
        action: 'export-rapport-controle',
        entite: 'controle',
        details: {
          controles: uniquePositiveIntegers(parsed.data.controle_ids),
          format: parsed.data.format,
          count: rows.length,
          generated_at: exportedAt,
          content_hash: hash,
        },
        ip: req.ip ?? null,
      });
      res.setHeader('Content-Type', 'application/pdf');
      appendReportHeaders(res, { filename, hash, generatedAt: exportedAt });
      return res.send(pdf);
    }

    const workbook = Buffer.from(buildControleReportWorkbook(rows));
    const hash = sha256Hex(workbook);
    logAudit({
      userId: req.user!.id,
      action: 'export-rapport-controle',
      entite: 'controle',
      details: {
        controles: uniquePositiveIntegers(parsed.data.controle_ids),
        format: parsed.data.format,
        count: rows.length,
        generated_at: exportedAt,
        content_hash: hash,
      },
      ip: req.ip ?? null,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    appendReportHeaders(res, { filename, hash, generatedAt: exportedAt });
    return res.send(workbook);
  } catch (error) {
    console.error('[TLPE] Erreur génération rapport contrôle', error);
    return res.status(500).json({ error: 'Erreur interne génération rapport contrôle' });
  }
});

controlesRouter.post('/proposer-rectification', requireRole('admin', 'gestionnaire'), (req, res) => {
  const parsed = rectificationRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const selectedRows = buildControleReportRows(parsed.data.controle_ids);
  const nonClosedControle = findNonClosedControle(selectedRows);
  if (nonClosedControle) {
    return res.status(409).json({
      error: `Le contrôle #${nonClosedControle.controle_id} doit être clôturé avant proposition de rectification.`,
    });
  }
  const rows = selectedRows.filter((row) => row.ecart_detecte);
  if (rows.length === 0) {
    return res.status(400).json({ error: 'Sélectionnez au moins un contrôle avec anomalie pour proposer une rectification' });
  }

  const groups = groupControleRowsByAssujettiYear(rows);
  const created: Array<{ declaration_id: number; numero: string; assujetti_id: number; annee: number; statut: string }> = [];
  const conflicts: Array<{ assujetti_id: number; annee: number; declaration_id: number; numero: string; statut: string }> = [];

  db.transaction(() => {
    for (const [key, groupRows] of Array.from(groups.entries())) {
      const [assujettiIdRaw, anneeRaw] = key.split(':');
      const assujettiId = Number(assujettiIdRaw);
      const annee = Number(anneeRaw);
      const existing = db
        .prepare('SELECT id, numero, statut FROM declarations WHERE assujetti_id = ? AND annee = ?')
        .get(assujettiId, annee) as { id: number; numero: string; statut: string } | undefined;

      if (existing) {
        conflicts.push({ assujetti_id: assujettiId, annee, declaration_id: existing.id, numero: existing.numero, statut: existing.statut });
        continue;
      }

      const statut = parsed.data.mode === 'declaration_office' ? 'en_instruction' : 'brouillon';
      const numero = allocateDeclarationNumeroForYear(annee);
      const uniqueRows = latestUniqueRowsByDispositif(groupRows);
      const commentaires = [
        parsed.data.mode === 'declaration_office'
          ? 'Proposition automatique de déclaration d’office à partir des contrôles terrain.'
          : 'Demande automatique de rectification adressée au contribuable à partir des contrôles terrain.',
        `Contrôles source : ${groupRows.map((row) => `#${row.controle_id}`).join(', ')}`,
        ...uniqueRows.map(
          (row) =>
            `${row.dispositif_identifiant ?? `contrôle-${row.controle_id}`} : ${row.surface_declaree ?? '-'} m² déclarés vs ${row.surface_mesuree} m² mesurés (Δ ${row.delta_montant_taxe.toFixed(2)} EUR)`,
        ),
      ].join('\n');

      const info = db
        .prepare(
          `INSERT INTO declarations (numero, assujetti_id, annee, statut, commentaires)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(numero, assujettiId, annee, statut, commentaires);
      const declarationId = Number(info.lastInsertRowid);

      const insertLigne = db.prepare(
        `INSERT INTO lignes_declaration (
           declaration_id, dispositif_id, surface_declaree, nombre_faces, quote_part, date_pose, date_depose
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of uniqueRows) {
        if (!row.dispositif_id) continue;
        insertLigne.run(
          declarationId,
          row.dispositif_id,
          row.surface_mesuree,
          row.nombre_faces_mesurees,
          1,
          row.date_pose,
          row.date_depose,
        );
      }

      logAudit({
        userId: req.user!.id,
        action: 'propose-rectification',
        entite: 'declaration',
        entiteId: declarationId,
        details: {
          mode: parsed.data.mode,
          controles: groupRows.map((row) => row.controle_id),
        },
        ip: req.ip ?? null,
      });

      created.push({ declaration_id: declarationId, numero, assujetti_id: assujettiId, annee, statut });
    }
  })();

  res.status(created.length > 0 ? 201 : 409).json({
    ok: created.length > 0,
    error: created.length > 0 ? undefined : 'Aucune rectification créée : une déclaration existe déjà pour chaque assujetti/année sélectionné.',
    mode: parsed.data.mode,
    created,
    conflicts,
  });
});

controlesRouter.post('/lancer-redressement', requireRole('admin', 'gestionnaire'), (req, res) => {
  const parsed = redressementRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const selectedRows = buildControleReportRows(parsed.data.controle_ids);
  const nonClosedControle = findNonClosedControle(selectedRows);
  if (nonClosedControle) {
    return res.status(409).json({
      error: `Le contrôle #${nonClosedControle.controle_id} doit être clôturé avant ouverture d’un redressement.`,
    });
  }
  const rows = selectedRows.filter((row) => row.ecart_detecte);
  if (rows.length === 0) {
    return res.status(400).json({ error: 'Sélectionnez au moins un contrôle avec anomalie pour lancer un redressement' });
  }

  const groups = groupControleRowsByAssujettiYear(rows);
  const actor = displayActorLabel(req.user);
  const created: Array<{ contentieux_id: number; numero: string; assujetti_id: number; annee: number; montant_litige: number }> = [];

  db.transaction(() => {
    for (const [key, groupRows] of Array.from(groups.entries())) {
      const [assujettiIdRaw, anneeRaw] = key.split(':');
      const assujettiId = Number(assujettiIdRaw);
      const annee = Number(anneeRaw);
      const numero = allocateContentieuxNumeroForYear(annee);
      const openedAt = groupRows[0]?.date_controle ?? new Date().toISOString().slice(0, 10);
      const responseDeadline = computeContentieuxResponseDeadline(openedAt);
      const montantLitige = Number(
        groupRows.reduce((sum, row) => sum + Math.max(0, row.delta_montant_taxe), 0).toFixed(2),
      );
      const description = [
        'Ouverture automatique d’un contentieux de contrôle / redressement.',
        `Contrôles source : ${groupRows.map((row) => `#${row.controle_id}`).join(', ')}`,
        ...groupRows.map(
          (row) =>
            `${row.dispositif_identifiant ?? `contrôle-${row.controle_id}`} : ${row.surface_declaree ?? '-'} m² déclarés vs ${row.surface_mesuree} m² mesurés (Δ ${row.delta_montant_taxe.toFixed(2)} EUR)`,
        ),
      ].join('\n');

      const info = db
        .prepare(
          `INSERT INTO contentieux (
            numero, assujetti_id, titre_id, type, montant_litige, description,
            date_ouverture, date_limite_reponse, date_limite_reponse_initiale
          ) VALUES (?, ?, NULL, 'controle', ?, ?, ?, ?, ?)`,
        )
        .run(numero, assujettiId, montantLitige, description, openedAt, responseDeadline, responseDeadline);

      const contentieuxId = Number(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO evenements_contentieux (contentieux_id, type, date, auteur, description, piece_jointe_id)
         VALUES (?, 'ouverture', ?, ?, ?, NULL)`,
      ).run(contentieuxId, openedAt, actor, description);

      logAudit({
        userId: req.user!.id,
        action: 'open-redressement',
        entite: 'contentieux',
        entiteId: contentieuxId,
        details: {
          controles: groupRows.map((row) => row.controle_id),
          montant_litige: montantLitige,
          date_limite_reponse: responseDeadline,
        },
        ip: req.ip ?? null,
      });

      created.push({ contentieux_id: contentieuxId, numero, assujetti_id: assujettiId, annee, montant_litige: montantLitige });
    }
  })();

  res.status(created.length > 0 ? 201 : 409).json({
    ok: created.length > 0,
    error:
      created.length > 0
        ? undefined
        : 'Aucun redressement créé : aucun assujetti exploitable trouvé pour les contrôles sélectionnés.',
    created,
  });
});

controlesRouter.post('/', (req, res) => {
  const parsed = controleSchema.safeParse(req.body);
  if (!parsed.success) {
    const flattened = parsed.error.flatten();
    const firstFieldError = Object.values(flattened.fieldErrors).flat().find((message): message is string => Boolean(message));
    const firstFormError = flattened.formErrors.find((message): message is string => Boolean(message));
    return res.status(400).json({
      error: firstFieldError ?? firstFormError ?? 'Payload de contrôle invalide',
      details: flattened,
    });
  }

  const input = parsed.data;
  const userId = req.user!.id;

  try {
    normalizeIsoDate(input.date_controle);
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Date invalide (format attendu YYYY-MM-DD)',
    });
  }

  try {
    const created = createControleTransaction(input, userId, req.ip ?? null);
    res.status(201).json(created);
  } catch (error) {
    if (error instanceof Error && error.message === DISPOSITIF_NOT_FOUND_ERROR) {
      return res.status(404).json({ error: 'Dispositif introuvable' });
    }
    if (isForeignKeyConstraintError(error)) {
      return res.status(400).json({
        error: 'Référentiel invalide pour le dispositif créé (assujetti, type ou zone introuvable)',
      });
    }
    throw error;
  }
});
