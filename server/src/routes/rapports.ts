import * as crypto from 'node:crypto';
import * as path from 'node:path';
import PDFDocument from 'pdfkit';
import XLSX from 'xlsx';
import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../auth';
import { db, logAudit } from '../db';
import {
  buildRecouvrementFilename,
  computeRate as computeRecouvrementRate,
  roundCurrency as roundRecouvrementCurrency,
  type RecouvrementFilters,
  type RecouvrementReportPayload,
  type RecouvrementSummaryRow,
  type RecouvrementVentilation,
} from '../recouvrementReport';
import { deleteStoredFile, saveFile } from './piecesJointes';

export const rapportsRouter = Router();

rapportsRouter.use(authMiddleware);

const ROLE_TLPE_COLLECTIVITE = process.env.TLPE_COLLECTIVITE || 'Collectivite territoriale';
const ROLE_TLPE_ORDONNATEUR = process.env.TLPE_ORDONNATEUR || 'Ordonnateur TLPE';

const roleReportQuerySchema = z.object({
  annee: z.coerce.number().int().min(2000).max(2100),
  format: z.enum(['pdf', 'xlsx']),
});

const recouvrementReportQuerySchema = z.object({
  annee: z.coerce.number().int().min(2000).max(2100),
  zone: z.coerce.number().int().positive().optional(),
  categorie: z.enum(['enseigne', 'publicitaire', 'preenseigne']).optional(),
  statut_paiement: z
    .enum(['emis', 'paye_partiel', 'paye', 'impaye', 'mise_en_demeure', 'transmis_comptable', 'admis_en_non_valeur'])
    .optional(),
  ventilation: z.enum(['assujetti', 'zone', 'categorie']).optional().default('assujetti'),
  format: z.enum(['json', 'pdf', 'xlsx']).optional().default('json'),
});

const RELANCES_REPORT_TYPES = [
  'relance_declaration',
  'mise_en_demeure_declaration',
  'relance_impaye',
  'mise_en_demeure_impaye',
] as const;

const RELANCES_REPORT_STATUSES = ['pending', 'envoye', 'echec', 'transmis', 'classe'] as const;

type RelancesReportType = (typeof RELANCES_REPORT_TYPES)[number];
type RelancesReportStatus = (typeof RELANCES_REPORT_STATUSES)[number];

function isValidIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    !Number.isNaN(date.getTime())
    && date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
  );
}

const isoCalendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Format YYYY-MM-DD attendu')
  .refine((value) => isValidIsoCalendarDate(value), 'Date calendrier invalide');

const relancesReportQuerySchema = z
  .object({
    date_debut: isoCalendarDateSchema,
    date_fin: isoCalendarDateSchema,
    type: z.enum(RELANCES_REPORT_TYPES).optional(),
    statut: z.enum(RELANCES_REPORT_STATUSES).optional(),
    format: z.enum(['json', 'pdf', 'xlsx']).optional().default('json'),
  })
  .refine((value) => value.date_debut <= value.date_fin, {
    message: 'La date de début doit être antérieure ou égale à la date de fin',
    path: ['date_fin'],
  });

const contentieuxReportQuerySchema = z.object({
  date_reference: isoCalendarDateSchema.optional(),
  format: z.enum(['json', 'pdf', 'xlsx']).optional().default('json'),
});

type RoleReportRow = {
  titre_id: number;
  numero_titre: string;
  assujetti_id: number;
  debiteur: string;
  siret: string | null;
  adresse: string;
  dispositifs: string;
  montant: number;
  statut_titre: string;
};

type RoleReportPayload = {
  annee: number;
  generatedAt: string;
  hash: string;
  collectivite: string;
  ordonnateur: string;
  totalMontant: number;
  titresCount: number;
  rows: RoleReportRow[];
};

type RoleReportColumn = {
  label: string;
  x: number;
  width: number;
};

type RecouvrementRowBase = {
  titre_id: number;
  assujetti_id: number;
  montant: number;
  montant_paye: number;
  montant_ligne: number;
  zone_id: number | null;
  zone_label: string | null;
  categorie: string;
  assujetti_label: string;
};

type RelancesReportRow = {
  date: string;
  date_time: string;
  destinataire: string;
  type_code: RelancesReportType;
  type_label: string;
  canal: 'email' | 'courrier';
  statut: RelancesReportStatus;
  reponse_label: string;
};

type RelancesReportPayload = {
  generatedAt: string;
  hash: string;
  filters: {
    date_debut: string;
    date_fin: string;
    type: RelancesReportType | null;
    statut: RelancesReportStatus | null;
  };
  indicators: {
    total: number;
    envoyees: number;
    echecs: number;
    regularisees: number;
    taux_regularisation: number;
    canal_email: number;
    canal_courrier: number;
  };
  rows: RelancesReportRow[];
};

type ContentieuxAlertLevel = 'J-30' | 'J-7' | 'depasse';

type ContentieuxSummaryRow = {
  type: string;
  nombre_dossiers: number;
  montant_litige: number;
  montant_degreve: number;
  anciennete_moyenne_jours: number;
  statut_resume: string;
};

type ContentieuxAlertRow = {
  contentieux_id: number;
  numero: string;
  assujetti: string;
  type: string;
  statut: string;
  date_echeance: string;
  niveau_alerte: ContentieuxAlertLevel;
  days_remaining: number;
};

type ContentieuxReportPayload = {
  date_reference: string;
  generatedAt: string;
  hash: string;
  indicators: {
    total_dossiers: number;
    montant_litige_total: number;
    montant_degreve_total: number;
  };
  rows: ContentieuxSummaryRow[];
  chart: Array<{ type: string; nombre_dossiers: number; montant_litige: number }>;
  alerts: {
    total: number;
    overdue: number;
    rows: ContentieuxAlertRow[];
  };
};

function formatDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function formatMoney(value: number): string {
  return `${value.toFixed(2)} EUR`;
}

function formatRecouvrementPct(value: number): string {
  return `${(value * 100).toFixed(1)} %`;
}

function formatRate(value: number): number {
  return Number(value.toFixed(4));
}

function sanitizeFileComponent(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
}

function relancesTypeLabel(type: RelancesReportType): string {
  switch (type) {
    case 'mise_en_demeure_declaration':
      return 'Mise en demeure déclaration';
    case 'relance_impaye':
      return 'Relance impayé';
    case 'mise_en_demeure_impaye':
      return 'Mise en demeure impayé';
    case 'relance_declaration':
    default:
      return 'Relance déclaration';
  }
}

function relancesStatusLabel(status: RelancesReportStatus): string {
  switch (status) {
    case 'pending':
      return 'En attente';
    case 'transmis':
      return 'Transmis';
    case 'classe':
      return 'Classé';
    case 'echec':
      return 'Échec';
    case 'envoye':
    default:
      return 'Envoyé';
  }
}

function relancesResponseLabelForDeclaration(status: string | null): string {
  return status === 'soumise' || status === 'validee' || status === 'rejetee'
    ? 'Déclaration reçue'
    : 'Aucune réponse';
}

function relancesResponseLabelForRecouvrement(params: { montant: number; montant_paye: number }): string {
  if (params.montant_paye >= params.montant && params.montant > 0) return 'Paiement reçu';
  if (params.montant_paye > 0) return 'Paiement partiel';
  return 'Aucune réponse';
}

function buildRelancesFilename(dateDebut: string, dateFin: string, format: 'pdf' | 'xlsx'): string {
  return `suivi-relances-${dateDebut}_${dateFin}.${format}`;
}

function paymentStatusLabel(statut: string) {
  switch (statut) {
    case 'paye':
      return 'Paye';
    case 'paye_partiel':
      return 'Paye partiel';
    case 'impaye':
      return 'Impaye';
    case 'mise_en_demeure':
      return 'Mise en demeure';
    case 'transmis_comptable':
      return 'Transmis comptable';
    case 'admis_en_non_valeur':
      return 'Admis en non-valeur';
    default:
      return 'Emis';
  }
}

function buildAddress(parts: Array<string | null>): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join(', ');
}

function buildRoleReportRows(annee: number): RoleReportRow[] {
  const rawRows = db
    .prepare(
      `SELECT
         t.id AS titre_id,
         t.numero AS numero_titre,
         t.assujetti_id,
         a.raison_sociale AS debiteur,
         a.siret,
         a.adresse_rue,
         a.adresse_cp,
         a.adresse_ville,
         t.montant,
         t.statut,
         (
           SELECT GROUP_CONCAT(item, ' | ')
           FROM (
             SELECT DISTINCT
               CASE
                 WHEN td.libelle IS NOT NULL AND td.libelle != '' THEN d.identifiant || ' (' || td.libelle || ')'
                 ELSE d.identifiant
               END AS item
             FROM lignes_declaration ld
             JOIN dispositifs d ON d.id = ld.dispositif_id
             LEFT JOIN types_dispositifs td ON td.id = d.type_id
             WHERE ld.declaration_id = t.declaration_id
             ORDER BY d.identifiant
           )
         ) AS dispositifs
       FROM titres t
       JOIN assujettis a ON a.id = t.assujetti_id
       WHERE t.annee = ?
       ORDER BY t.numero`,
    )
    .all(annee) as Array<{
    titre_id: number;
    numero_titre: string;
    assujetti_id: number;
    debiteur: string;
    siret: string | null;
    adresse_rue: string | null;
    adresse_cp: string | null;
    adresse_ville: string | null;
    montant: number;
    statut: string;
    dispositifs: string | null;
  }>;

  return rawRows.map((row) => ({
    titre_id: row.titre_id,
    numero_titre: row.numero_titre,
    assujetti_id: row.assujetti_id,
    debiteur: row.debiteur,
    siret: row.siret,
    adresse: buildAddress([row.adresse_rue, [row.adresse_cp, row.adresse_ville].filter(Boolean).join(' ')]),
    dispositifs: row.dispositifs || 'Aucun dispositif rattache',
    montant: row.montant,
    statut_titre: paymentStatusLabel(row.statut),
  }));
}

function buildRoleReportPayload(annee: number): RoleReportPayload {
  const rows = buildRoleReportRows(annee);
  const totalMontant = Number(rows.reduce((sum, row) => sum + row.montant, 0).toFixed(2));
  const generatedAt = formatDateTime(new Date());
  const hash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        annee,
        collectivite: ROLE_TLPE_COLLECTIVITE,
        ordonnateur: ROLE_TLPE_ORDONNATEUR,
        rows: rows.map((row) => ({
          numero_titre: row.numero_titre,
          debiteur: row.debiteur,
          siret: row.siret,
          adresse: row.adresse,
          dispositifs: row.dispositifs,
          montant: row.montant,
          statut_titre: row.statut_titre,
        })),
        totalMontant,
      }),
    )
    .digest('hex');

  return {
    annee,
    generatedAt,
    hash,
    collectivite: ROLE_TLPE_COLLECTIVITE,
    ordonnateur: ROLE_TLPE_ORDONNATEUR,
    totalMontant,
    titresCount: rows.length,
    rows,
  };
}

const ROLE_REPORT_COLUMNS: readonly RoleReportColumn[] = [
  { label: 'N° titre', x: 36, width: 70 },
  { label: 'Debiteur', x: 106, width: 100 },
  { label: 'SIRET', x: 206, width: 70 },
  { label: 'Adresse', x: 276, width: 120 },
  { label: 'Dispositifs', x: 396, width: 100 },
  { label: 'Montant', x: 496, width: 55 },
  { label: 'Statut paiement', x: 551, width: 40 },
] as const;

const ROLE_REPORT_FOOTER_Y = 800;
const ROLE_REPORT_ROW_SPACING = 8;

export function measureRoleReportRowHeight(doc: InstanceType<typeof PDFDocument>, row: RoleReportRow): number {
  const values = [
    row.numero_titre,
    row.debiteur,
    row.siret || '-',
    row.adresse || '-',
    row.dispositifs,
    formatMoney(row.montant),
    row.statut_titre,
  ] as const;

  const height = ROLE_REPORT_COLUMNS.reduce((maxHeight, column, index) => {
    const textHeight = doc.heightOfString(values[index], {
      width: column.width,
      align: index >= 5 ? 'right' : 'left',
    });
    return Math.max(maxHeight, textHeight);
  }, 0);

  return Math.max(height, 20);
}

export function shouldRoleReportStartNewPage(currentY: number, rowHeight: number): boolean {
  return currentY + rowHeight + ROLE_REPORT_ROW_SPACING > ROLE_REPORT_FOOTER_Y;
}

const RECOUVREMENT_REPORT_ROW_SPACING = 8;
const RECOUVREMENT_REPORT_FOOTER_Y = 792 - 36 - 14;
const RECOUVREMENT_REPORT_COLUMNS = [
  { width: 200, align: 'left' as const },
  { width: 90, align: 'right' as const },
  { width: 90, align: 'right' as const },
  { width: 90, align: 'right' as const },
  { width: 60, align: 'right' as const },
] as const;

export function measureRecouvrementReportRowHeight(
  doc: InstanceType<typeof PDFDocument>,
  row: RecouvrementSummaryRow,
): number {
  const values = [
    row.label,
    formatMoney(row.montant_emis),
    formatMoney(row.montant_recouvre),
    formatMoney(row.reste_a_recouvrer),
    formatRecouvrementPct(row.taux_recouvrement),
  ] as const;

  const height = RECOUVREMENT_REPORT_COLUMNS.reduce((maxHeight, column, index) => {
    const textHeight = doc.heightOfString(values[index], {
      width: column.width,
      align: column.align,
    });
    return Math.max(maxHeight, textHeight);
  }, 0);

  return Math.max(height, 20);
}

export function shouldRecouvrementReportStartNewPage(currentY: number, rowHeight: number): boolean {
  return currentY + rowHeight + RECOUVREMENT_REPORT_ROW_SPACING > RECOUVREMENT_REPORT_FOOTER_Y;
}

async function buildRoleReportPdfBuffer(payload: RoleReportPayload): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('Rôle de la TLPE', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#555').text(`Collectivite : ${payload.collectivite}`, { align: 'center' });
    doc.text(`Exercice : ${payload.annee}`, { align: 'center' });
    doc.moveDown(0.8).fillColor('black');
    doc.fontSize(10).text(`Horodatage : ${payload.generatedAt}`);
    doc.text(`Hash SHA-256 : ${payload.hash}`);
    doc.moveDown(0.8);

    doc.moveDown(0.8);
    const printHeader = () => {
      const top = doc.y;
      doc.fontSize(8).fillColor('#333');
      ROLE_REPORT_COLUMNS.forEach((column) => {
        doc.text(column.label, column.x, top, { width: column.width });
      });
      doc.moveTo(36, top + 14).lineTo(595, top + 14).stroke();
      doc.y = top + 18;
      doc.fillColor('black');
    };

    const ensurePage = (rowHeight: number) => {
      if (shouldRoleReportStartNewPage(doc.y, rowHeight)) {
        doc.addPage();
        printHeader();
      }
    };

    printHeader();
    doc.fontSize(8);

    for (const row of payload.rows) {
      const rowHeight = measureRoleReportRowHeight(doc, row);
      ensurePage(rowHeight);
      const y = doc.y;
      doc.text(row.numero_titre, ROLE_REPORT_COLUMNS[0].x, y, { width: ROLE_REPORT_COLUMNS[0].width });
      doc.text(row.debiteur, ROLE_REPORT_COLUMNS[1].x, y, { width: ROLE_REPORT_COLUMNS[1].width });
      doc.text(row.siret || '-', ROLE_REPORT_COLUMNS[2].x, y, { width: ROLE_REPORT_COLUMNS[2].width });
      doc.text(row.adresse || '-', ROLE_REPORT_COLUMNS[3].x, y, { width: ROLE_REPORT_COLUMNS[3].width });
      doc.text(row.dispositifs, ROLE_REPORT_COLUMNS[4].x, y, { width: ROLE_REPORT_COLUMNS[4].width });
      doc.text(formatMoney(row.montant), ROLE_REPORT_COLUMNS[5].x, y, {
        width: ROLE_REPORT_COLUMNS[5].width,
        align: 'right',
      });
      doc.text(row.statut_titre, ROLE_REPORT_COLUMNS[6].x, y, {
        width: ROLE_REPORT_COLUMNS[6].width,
        align: 'right',
      });
      const rowBottom = y + rowHeight;
      doc.moveTo(36, rowBottom + 4).lineTo(595, rowBottom + 4).strokeColor('#d8d8d8').stroke().strokeColor('black');
      doc.y = rowBottom + ROLE_REPORT_ROW_SPACING;
    }

    if (payload.rows.length === 0) {
      doc.fontSize(10).fillColor('#666').text('Aucun titre emis pour cet exercice.');
      doc.moveDown(1).fillColor('black');
    }

    doc.moveDown(1);
    doc.fontSize(12).text(`Total general : ${formatMoney(payload.totalMontant)}`, { align: 'right' });
    doc.moveDown(0.4);
    doc.fontSize(11).text(`Signature ordonnateur : ${payload.ordonnateur}`);

    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      doc.switchToPage(index);
      doc.fontSize(8).fillColor('#555').text(`Page ${index - range.start + 1}/${range.count}`, 36, 800, { align: 'center', width: 523 });
      doc.fillColor('black');
    }

    doc.end();
  });
}

function buildRoleReportWorkbook(payload: RoleReportPayload): Buffer {
  const rows: Array<Array<string | number>> = [
    ['Rôle de la TLPE'],
    ['Annee', payload.annee],
    ['Horodatage', payload.generatedAt],
    ['Hash SHA-256', payload.hash],
    [],
    ['N° titre', 'Débiteur', 'SIRET', 'Adresse', 'Dispositifs', 'Montant', 'Statut paiement'],
    ...payload.rows.map((row) => [
      row.numero_titre,
      row.debiteur,
      row.siret || '',
      row.adresse,
      row.dispositifs,
      row.montant,
      row.statut_titre,
    ]),
    ['TOTAL', '', '', '', '', payload.totalMontant, ''],
    [],
    ['Collectivite', payload.collectivite],
    ['Signature ordonnateur', payload.ordonnateur],
  ];

  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet['!cols'] = [
    { wch: 18 },
    { wch: 24 },
    { wch: 18 },
    { wch: 28 },
    { wch: 44 },
    { wch: 14 },
    { wch: 18 },
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Role TLPE');
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
}

async function archiveRoleReport(params: {
  annee: number;
  format: 'pdf' | 'xlsx';
  buffer: Buffer;
  hash: string;
  titresCount: number;
  totalMontant: number;
  generatedBy: number;
}): Promise<{ filename: string; storagePath: string }> {
  const filename = `role-tlpe-${params.annee}.${params.format}`;
  const storagePath = path.posix.join(
    'rapports',
    'role_tlpe',
    String(params.annee),
    `${Date.now()}-${sanitizeFileComponent(params.hash.slice(0, 12))}.${params.format}`,
  );
  await saveFile(
    storagePath,
    params.buffer,
    params.format === 'pdf'
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );

  try {
    db.prepare(
      `INSERT INTO rapports_exports (
        type_rapport, annee, format, filename, storage_path, content_hash, titres_count, total_montant, generated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('role_tlpe', params.annee, params.format, filename, storagePath, params.hash, params.titresCount, params.totalMontant, params.generatedBy);
  } catch (error) {
    try {
      await deleteStoredFile(storagePath);
    } catch (cleanupError) {
      console.error('[TLPE] Echec nettoyage archive role TLPE', cleanupError);
    }
    throw error;
  }

  return { filename, storagePath };
}

function buildRecouvrementWhereClause(filters: RecouvrementFilters): { whereSql: string; params: unknown[] } {
  const conditions = ['t.annee = ?'];
  const params: unknown[] = [filters.annee];

  if (filters.zoneId) {
    conditions.push('d.zone_id = ?');
    params.push(filters.zoneId);
  }
  if (filters.categorie) {
    conditions.push('td.categorie = ?');
    params.push(filters.categorie);
  }
  if (filters.statutPaiement) {
    conditions.push('t.statut = ?');
    params.push(filters.statutPaiement);
  }

  return {
    whereSql: conditions.join(' AND '),
    params,
  };
}

function listRecouvrementRows(filters: RecouvrementFilters): RecouvrementRowBase[] {
  const { whereSql, params } = buildRecouvrementWhereClause(filters);
  return db
    .prepare(
      `SELECT
         t.id AS titre_id,
         t.assujetti_id,
         t.montant,
         t.montant_paye,
         ld.montant_ligne,
         d.zone_id,
         z.libelle AS zone_label,
         td.categorie,
         a.raison_sociale AS assujetti_label
       FROM titres t
       JOIN assujettis a ON a.id = t.assujetti_id
       JOIN declarations dec ON dec.id = t.declaration_id
       JOIN lignes_declaration ld ON ld.declaration_id = dec.id
       JOIN dispositifs d ON d.id = ld.dispositif_id
       JOIN types_dispositifs td ON td.id = d.type_id
       LEFT JOIN zones z ON z.id = d.zone_id
       WHERE ${whereSql}
       ORDER BY t.numero, ld.id`,
    )
    .all(...params) as RecouvrementRowBase[];
}

function aggregateRecouvrementRows(rows: RecouvrementRowBase[], ventilation: RecouvrementVentilation): RecouvrementSummaryRow[] {
  const groups = new Map<string, RecouvrementSummaryRow>();

  for (const row of rows) {
    const key =
      ventilation === 'assujetti'
        ? String(row.assujetti_id)
        : ventilation === 'zone'
          ? row.zone_id
            ? String(row.zone_id)
            : 'sans-zone'
          : row.categorie;
    const label =
      ventilation === 'assujetti'
        ? row.assujetti_label
        : ventilation === 'zone'
          ? row.zone_label || 'Sans zone'
          : row.categorie === 'enseigne'
            ? 'Enseigne'
            : row.categorie === 'preenseigne'
              ? 'Préenseigne'
              : 'Publicitaire';
    const current = groups.get(key) || {
      key,
      label,
      montant_emis: 0,
      montant_recouvre: 0,
      reste_a_recouvrer: 0,
      taux_recouvrement: 0,
    };
    const emittedShare = row.montant > 0 ? roundRecouvrementCurrency((row.montant * row.montant_ligne) / row.montant) : 0;
    const recoveredShare = row.montant > 0 ? roundRecouvrementCurrency((row.montant_paye * row.montant_ligne) / row.montant) : 0;

    current.montant_emis = roundRecouvrementCurrency(current.montant_emis + emittedShare);
    current.montant_recouvre = roundRecouvrementCurrency(current.montant_recouvre + recoveredShare);
    current.reste_a_recouvrer = roundRecouvrementCurrency(current.montant_emis - current.montant_recouvre);
    current.taux_recouvrement = computeRecouvrementRate(current.montant_recouvre, current.montant_emis);
    groups.set(key, current);
  }

  return Array.from(groups.values()).sort((a, b) => b.montant_emis - a.montant_emis || a.label.localeCompare(b.label, 'fr'));
}

function resolveZoneLabel(zoneId: number | null): { id: number; label: string } | null {
  if (!zoneId) return null;
  const row = db.prepare(`SELECT id, libelle FROM zones WHERE id = ?`).get(zoneId) as { id: number; libelle: string } | undefined;
  return row ? { id: row.id, label: row.libelle } : null;
}

function buildRecouvrementReportPayload(filters: RecouvrementFilters): RecouvrementReportPayload {
  const rows = listRecouvrementRows(filters);
  const titresCount = new Set(rows.map((row) => row.titre_id)).size;
  const byAssujetti = aggregateRecouvrementRows(rows, 'assujetti');
  const byZone = aggregateRecouvrementRows(rows, 'zone');
  const byCategorie = aggregateRecouvrementRows(rows, 'categorie');
  const montantEmis = roundRecouvrementCurrency(byAssujetti.reduce((sum, row) => sum + row.montant_emis, 0));
  const montantRecouvre = roundRecouvrementCurrency(byAssujetti.reduce((sum, row) => sum + row.montant_recouvre, 0));
  const reste = roundRecouvrementCurrency(montantEmis - montantRecouvre);
  const generatedAt = formatDateTime(new Date());
  const hash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        filters,
        generatedAt,
        rows: {
          assujetti: byAssujetti,
          zone: byZone,
          categorie: byCategorie,
        },
        totals: {
          montantEmis,
          montantRecouvre,
          reste,
        },
      }),
    )
    .digest('hex');

  return {
    generatedAt,
    hash,
    titresCount,
    filters: {
      annee: filters.annee,
      zone: resolveZoneLabel(filters.zoneId),
      categorie: filters.categorie,
      statut_paiement: filters.statutPaiement,
      ventilation: filters.ventilation,
    },
    totals: {
      montant_emis: montantEmis,
      montant_recouvre: montantRecouvre,
      reste_a_recouvrer: reste,
      taux_recouvrement: computeRecouvrementRate(montantRecouvre, montantEmis),
    },
    breakdowns: {
      assujetti: byAssujetti,
      zone: byZone,
      categorie: byCategorie,
    },
    chart: filters.ventilation === 'zone' ? byZone : filters.ventilation === 'categorie' ? byCategorie : byAssujetti,
  };
}

function buildRecouvrementWorkbook(payload: RecouvrementReportPayload): Buffer {
  const rows: Array<Array<string | number>> = [
    ['État de recouvrement TLPE'],
    ['Année', payload.filters.annee],
    ['Ventilation', payload.filters.ventilation],
    ['Horodatage', payload.generatedAt],
    ['Hash SHA-256', payload.hash],
    [],
    ['Libellé', 'Montant émis', 'Montant recouvré', 'Reste à recouvrer', 'Taux'],
    ...payload.chart.map((row) => [row.label, row.montant_emis, row.montant_recouvre, row.reste_a_recouvrer, row.taux_recouvrement]),
    ['TOTAL', payload.totals.montant_emis, payload.totals.montant_recouvre, payload.totals.reste_a_recouvrer, payload.totals.taux_recouvrement],
  ];

  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet['!cols'] = [{ wch: 28 }, { wch: 16 }, { wch: 18 }, { wch: 18 }, { wch: 12 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Recouvrement');
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
}

async function buildRecouvrementPdfBuffer(payload: RecouvrementReportPayload): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('État de recouvrement TLPE', { align: 'center' });
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor('#555').text(`Exercice : ${payload.filters.annee}`, { align: 'center' });
    doc.text(`Ventilation : ${payload.filters.ventilation}`, { align: 'center' });
    doc.moveDown(0.8).fillColor('black');
    doc.fontSize(10).text(`Horodatage : ${payload.generatedAt}`);
    doc.text(`Hash SHA-256 : ${payload.hash}`);
    doc.moveDown();
    doc.text(`Montant émis : ${formatMoney(payload.totals.montant_emis)}`);
    doc.text(`Montant recouvré : ${formatMoney(payload.totals.montant_recouvre)}`);
    doc.text(`Reste à recouvrer : ${formatMoney(payload.totals.reste_a_recouvrer)}`);
    doc.text(`Taux de recouvrement : ${formatRecouvrementPct(payload.totals.taux_recouvrement)}`);
    doc.moveDown();

    const headers = [
      { label: 'Libellé', x: 36, width: 200, align: 'left' as const },
      { label: 'Émis', x: 236, width: 90, align: 'right' as const },
      { label: 'Recouvré', x: 326, width: 90, align: 'right' as const },
      { label: 'Reste', x: 416, width: 90, align: 'right' as const },
      { label: 'Taux', x: 506, width: 60, align: 'right' as const },
    ];

    const drawHeader = () => {
      const y = doc.y;
      doc.fontSize(8).fillColor('#333');
      for (const header of headers) {
        doc.text(header.label, header.x, y, { width: header.width, align: header.align });
      }
      doc.moveTo(36, y + 14).lineTo(560, y + 14).stroke();
      doc.y = y + 18;
      doc.fillColor('black');
    };

    drawHeader();
    doc.fontSize(8);

    for (const row of payload.chart) {
      const rowHeight = measureRecouvrementReportRowHeight(doc, row);
      if (shouldRecouvrementReportStartNewPage(doc.y, rowHeight)) {
        doc.addPage();
        drawHeader();
      }
      const y = doc.y;
      doc.text(row.label, headers[0].x, y, { width: headers[0].width });
      doc.text(formatMoney(row.montant_emis), headers[1].x, y, { width: headers[1].width, align: 'right' });
      doc.text(formatMoney(row.montant_recouvre), headers[2].x, y, { width: headers[2].width, align: 'right' });
      doc.text(formatMoney(row.reste_a_recouvrer), headers[3].x, y, { width: headers[3].width, align: 'right' });
      doc.text(formatRecouvrementPct(row.taux_recouvrement), headers[4].x, y, { width: headers[4].width, align: 'right' });
      const rowBottom = y + rowHeight;
      doc.moveTo(36, rowBottom + 4).lineTo(560, rowBottom + 4).strokeColor('#d8d8d8').stroke().strokeColor('black');
      doc.y = rowBottom + 8;
    }

    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      doc.switchToPage(index);
      doc.fontSize(8).fillColor('#555').text(`Page ${index - range.start + 1}/${range.count}`, 36, 800, { align: 'center', width: 523 });
      doc.fillColor('black');
    }

    doc.end();
  });
}

async function archiveRecouvrementReport(params: {
  annee: number;
  ventilation: RecouvrementVentilation;
  format: 'pdf' | 'xlsx';
  buffer: Buffer;
  hash: string;
  titresCount: number;
  totalMontant: number;
  generatedBy: number;
}): Promise<{ filename: string; storagePath: string }> {
  const filename = buildRecouvrementFilename(String(params.annee), params.ventilation, params.format);
  const storagePath = path.posix.join(
    'rapports',
    'etat_recouvrement',
    String(params.annee),
    `${Date.now()}-${sanitizeFileComponent(params.hash.slice(0, 12))}.${params.format}`,
  );
  await saveFile(
    storagePath,
    params.buffer,
    params.format === 'pdf'
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );

  try {
    db.prepare(
      `INSERT INTO rapports_exports (
        type_rapport, annee, format, filename, storage_path, content_hash, titres_count, total_montant, generated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'etat_recouvrement',
      params.annee,
      params.format,
      filename,
      storagePath,
      params.hash,
      params.titresCount,
      params.totalMontant,
      params.generatedBy,
    );
  } catch (error) {
    try {
      await deleteStoredFile(storagePath);
    } catch (cleanupError) {
      console.error('[TLPE] Echec nettoyage archive etat recouvrement', cleanupError);
    }
    throw error;
  }

  return { filename, storagePath };
}

function listRelancesRows(filters: {
  dateDebut: string;
  dateFin: string;
  type: RelancesReportType | null;
  statut: RelancesReportStatus | null;
}): RelancesReportRow[] {
  const declarationRows = db
    .prepare(
      `SELECT
         date(COALESCE(n.sent_at, n.created_at)) AS action_date,
         COALESCE(n.sent_at, n.created_at) AS action_datetime,
         a.raison_sociale AS destinataire,
         n.template_code,
         n.piece_jointe_path,
         n.statut,
         (
           SELECT d.statut
           FROM declarations d
           WHERE d.assujetti_id = n.assujetti_id
             AND d.annee = COALESCE(c.annee, CAST(substr(COALESCE(n.sent_at, n.created_at), 1, 4) AS INTEGER))
           ORDER BY d.id DESC
           LIMIT 1
         ) AS declaration_statut
       FROM notifications_email n
       JOIN assujettis a ON a.id = n.assujetti_id
       LEFT JOIN campagnes c ON c.id = n.campagne_id
       WHERE date(COALESCE(n.sent_at, n.created_at)) BETWEEN date(?) AND date(?)
         AND n.template_code IN ('relance_declaration', 'mise_en_demeure_auto')`,
    )
    .all(filters.dateDebut, filters.dateFin) as Array<{
    action_date: string;
    action_datetime: string;
    destinataire: string;
    template_code: string;
    piece_jointe_path: string | null;
    statut: RelancesReportStatus;
    declaration_statut: string | null;
  }>;

  const recouvrementRows = db
    .prepare(
      `SELECT
         date(ra.created_at) AS action_date,
         ra.created_at AS action_datetime,
         a.raison_sociale AS destinataire,
         ra.action_type,
         ra.statut,
         t.montant,
         t.montant_paye
       FROM recouvrement_actions ra
       JOIN titres t ON t.id = ra.titre_id
       JOIN assujettis a ON a.id = t.assujetti_id
       WHERE date(ra.created_at) BETWEEN date(?) AND date(?)
         AND ra.action_type IN ('rappel_email', 'mise_en_demeure')`,
    )
    .all(filters.dateDebut, filters.dateFin) as Array<{
    action_date: string;
    action_datetime: string;
    destinataire: string;
    action_type: 'rappel_email' | 'mise_en_demeure';
    statut: RelancesReportStatus;
    montant: number;
    montant_paye: number;
  }>;

  return [
    ...declarationRows.map((row) => {
      const typeCode: RelancesReportType = row.template_code === 'mise_en_demeure_auto'
        ? 'mise_en_demeure_declaration'
        : 'relance_declaration';
      const canal: 'email' | 'courrier' = row.template_code === 'mise_en_demeure_auto' || Boolean(row.piece_jointe_path)
        ? 'courrier'
        : 'email';
      return {
        date: row.action_date,
        date_time: row.action_datetime,
        destinataire: row.destinataire,
        type_code: typeCode,
        type_label: relancesTypeLabel(typeCode),
        canal,
        statut: row.statut,
        reponse_label: relancesResponseLabelForDeclaration(row.declaration_statut),
      };
    }),
    ...recouvrementRows.map((row) => {
      const typeCode: RelancesReportType = row.action_type === 'mise_en_demeure'
        ? 'mise_en_demeure_impaye'
        : 'relance_impaye';
      const canal: 'email' | 'courrier' = row.action_type === 'mise_en_demeure' ? 'courrier' : 'email';
      return {
        date: row.action_date,
        date_time: row.action_datetime,
        destinataire: row.destinataire,
        type_code: typeCode,
        type_label: relancesTypeLabel(typeCode),
        canal,
        statut: row.statut,
        reponse_label: relancesResponseLabelForRecouvrement({ montant: row.montant, montant_paye: row.montant_paye }),
      };
    }),
  ]
    .filter((row) => (filters.type ? row.type_code === filters.type : true))
    .filter((row) => (filters.statut ? row.statut === filters.statut : true))
    .sort((a, b) => b.date_time.localeCompare(a.date_time) || a.destinataire.localeCompare(b.destinataire, 'fr'));
}

function buildRelancesReportPayload(filters: {
  dateDebut: string;
  dateFin: string;
  type: RelancesReportType | null;
  statut: RelancesReportStatus | null;
}): RelancesReportPayload {
  const rows = listRelancesRows(filters);
  const envoyees = rows.filter((row) => row.statut === 'envoye').length;
  const echecs = rows.filter((row) => row.statut === 'echec').length;
  const regularisees = rows.filter((row) => row.statut === 'envoye' && row.reponse_label !== 'Aucune réponse').length;
  const canalEmail = rows.filter((row) => row.canal === 'email').length;
  const canalCourrier = rows.filter((row) => row.canal === 'courrier').length;
  const generatedAt = formatDateTime(new Date());
  const indicators = {
    total: rows.length,
    envoyees,
    echecs,
    regularisees,
    taux_regularisation: formatRate(envoyees > 0 ? regularisees / envoyees : 0),
    canal_email: canalEmail,
    canal_courrier: canalCourrier,
  };
  const hash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        filters,
        generatedAt,
        indicators,
        rows,
      }),
    )
    .digest('hex');

  return {
    generatedAt,
    hash,
    filters: {
      date_debut: filters.dateDebut,
      date_fin: filters.dateFin,
      type: filters.type,
      statut: filters.statut,
    },
    indicators,
    rows,
  };
}

function buildRelancesWorkbook(payload: RelancesReportPayload): Buffer {
  const rows: Array<Array<string | number>> = [
    ['Suivi des relances et mises en demeure'],
    ['Date début', payload.filters.date_debut],
    ['Date fin', payload.filters.date_fin],
    ['Type', payload.filters.type ? relancesTypeLabel(payload.filters.type) : 'Tous'],
    ['Statut', payload.filters.statut ? relancesStatusLabel(payload.filters.statut) : 'Tous'],
    ['Total', payload.indicators.total],
    ['Envoyées', payload.indicators.envoyees],
    ['Taux de régularisation', payload.indicators.taux_regularisation],
    ['Date', 'Destinataire', 'Type', 'Canal', 'Statut', 'Réponse'],
    ...payload.rows.map((row) => [row.date, row.destinataire, row.type_label, row.canal, relancesStatusLabel(row.statut), row.reponse_label]),
  ];

  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet['!cols'] = [
    { wch: 14 },
    { wch: 24 },
    { wch: 28 },
    { wch: 14 },
    { wch: 14 },
    { wch: 22 },
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Suivi relances');
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
}

async function buildRelancesPdfBuffer(payload: RelancesReportPayload): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('Suivi des relances et mises en demeure', { align: 'center' });
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor('#555').text(`Période : ${payload.filters.date_debut} → ${payload.filters.date_fin}`, { align: 'center' });
    doc.moveDown(0.6).fillColor('black');
    doc.text(`Horodatage : ${payload.generatedAt}`);
    doc.text(`Hash SHA-256 : ${payload.hash}`);
    doc.text(`Envoyées : ${payload.indicators.envoyees} · Échecs : ${payload.indicators.echecs} · Taux régularisation : ${(payload.indicators.taux_regularisation * 100).toFixed(2)} %`);
    doc.moveDown();

    if (payload.rows.length === 0) {
      doc.fontSize(10).fillColor('#666').text('Aucune relance ou mise en demeure pour ces filtres.');
      doc.fillColor('black');
    } else {
      doc.fontSize(9);
      for (const row of payload.rows) {
        doc.text(`${row.date} · ${row.destinataire} · ${row.type_label} · ${row.canal} · ${relancesStatusLabel(row.statut)} · ${row.reponse_label}`);
        doc.moveDown(0.2);
      }
    }

    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      doc.switchToPage(index);
      doc.fontSize(8).fillColor('#555').text(`Page ${index - range.start + 1}/${range.count}`, 36, 800, { align: 'center', width: 523 });
      doc.fillColor('black');
    }

    doc.end();
  });
}

async function archiveRelancesReport(params: {
  dateDebut: string;
  dateFin: string;
  format: 'pdf' | 'xlsx';
  buffer: Buffer;
  hash: string;
  rowCount: number;
  sentCount: number;
  generatedBy: number;
}): Promise<{ filename: string; storagePath: string }> {
  const archiveYear = Number(params.dateDebut.slice(0, 4));
  const filename = buildRelancesFilename(params.dateDebut, params.dateFin, params.format);
  const storagePath = path.posix.join(
    'rapports',
    'suivi_relances',
    String(archiveYear),
    `${Date.now()}-${sanitizeFileComponent(params.hash.slice(0, 12))}.${params.format}`,
  );
  await saveFile(
    storagePath,
    params.buffer,
    params.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );

  try {
    db.prepare(
      `INSERT INTO rapports_exports (
        type_rapport, annee, format, filename, storage_path, content_hash, titres_count, total_montant, generated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'suivi_relances',
      archiveYear,
      params.format,
      filename,
      storagePath,
      params.hash,
      params.rowCount,
      params.sentCount,
      params.generatedBy,
    );
  } catch (error) {
    try {
      await deleteStoredFile(storagePath);
    } catch (cleanupError) {
      console.error('[TLPE] Echec nettoyage archive suivi relances', cleanupError);
    }
    throw error;
  }

  return { filename, storagePath };
}

function parseIsoDateUtc(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function diffCalendarDays(fromIso: string, toIso: string): number {
  const from = parseIsoDateUtc(fromIso).getTime();
  const to = parseIsoDateUtc(toIso).getTime();
  return Math.round((to - from) / 86_400_000);
}

function contentieuxTypeLabel(type: string): string {
  switch (type) {
    case 'gracieux':
      return 'Gracieux';
    case 'moratoire':
      return 'Moratoire';
    case 'controle':
      return 'Contrôle';
    case 'contentieux':
    default:
      return 'Contentieux';
  }
}

function contentieuxStatusLabel(status: string): string {
  switch (status) {
    case 'ouvert':
      return 'ouvert';
    case 'instruction':
      return 'instruction';
    case 'clos_maintenu':
      return 'clos maintenu';
    case 'degrevement_partiel':
      return 'dégrèvement partiel';
    case 'degrevement_total':
      return 'dégrèvement total';
    case 'non_lieu':
      return 'non-lieu';
    default:
      return status.replace(/_/g, ' ');
  }
}

function resolveContentieuxAlertLevel(daysRemaining: number): ContentieuxAlertLevel | null {
  if (daysRemaining < 0) return 'depasse';
  if (daysRemaining <= 7) return 'J-7';
  if (daysRemaining <= 30) return 'J-30';
  return null;
}

function buildContentieuxStatusSummary(statusCounts: Map<string, number>): string {
  const statusOrder = ['ouvert', 'instruction', 'clos_maintenu', 'degrevement_partiel', 'degrevement_total', 'non_lieu'];
  return statusOrder
    .filter((status) => statusCounts.has(status))
    .map((status) => `${statusCounts.get(status)} ${contentieuxStatusLabel(status)}`)
    .join(' • ');
}

function buildContentieuxReportPayload(dateReference: string): ContentieuxReportPayload {
  const dossiers = db
    .prepare(
      `SELECT
         c.id,
         c.numero,
         c.type,
         c.statut,
         c.montant_litige,
         c.montant_degreve,
         c.date_ouverture,
         c.date_limite_reponse,
         c.date_cloture,
         a.raison_sociale AS assujetti
       FROM contentieux c
       JOIN assujettis a ON a.id = c.assujetti_id
       WHERE c.date_cloture IS NULL
       ORDER BY c.date_ouverture ASC, c.id ASC`,
    )
    .all() as Array<{
      id: number;
      numero: string;
      type: string;
      statut: string;
      montant_litige: number | null;
      montant_degreve: number | null;
      date_ouverture: string;
      date_limite_reponse: string | null;
      date_cloture: string | null;
      assujetti: string;
    }>;

  const groups = new Map<string, {
    type: string;
    nombre_dossiers: number;
    montant_litige: number;
    montant_degreve: number;
    total_anciennete: number;
    status_counts: Map<string, number>;
  }>();

  for (const dossier of dossiers) {
    const current = groups.get(dossier.type) || {
      type: dossier.type,
      nombre_dossiers: 0,
      montant_litige: 0,
      montant_degreve: 0,
      total_anciennete: 0,
      status_counts: new Map<string, number>(),
    };
    current.nombre_dossiers += 1;
    current.montant_litige = Number((current.montant_litige + (dossier.montant_litige ?? 0)).toFixed(2));
    current.montant_degreve = Number((current.montant_degreve + (dossier.montant_degreve ?? 0)).toFixed(2));
    current.total_anciennete += diffCalendarDays(dossier.date_ouverture, dateReference);
    current.status_counts.set(dossier.statut, (current.status_counts.get(dossier.statut) ?? 0) + 1);
    groups.set(dossier.type, current);
  }

  const rows = Array.from(groups.values())
    .map((group) => ({
      type: group.type,
      nombre_dossiers: group.nombre_dossiers,
      montant_litige: group.montant_litige,
      montant_degreve: group.montant_degreve,
      anciennete_moyenne_jours: Number((group.total_anciennete / group.nombre_dossiers).toFixed(1)),
      statut_resume: buildContentieuxStatusSummary(group.status_counts),
    }))
    .sort((left, right) => right.nombre_dossiers - left.nombre_dossiers || right.montant_litige - left.montant_litige || left.type.localeCompare(right.type, 'fr'));

  const alertsRows = dossiers
    .filter((dossier) => !dossier.date_cloture && Boolean(dossier.date_limite_reponse))
    .map((dossier) => {
      const dateEcheance = dossier.date_limite_reponse as string;
      const daysRemaining = diffCalendarDays(dateReference, dateEcheance);
      const niveau = resolveContentieuxAlertLevel(daysRemaining);
      if (!niveau) return null;
      return {
        contentieux_id: dossier.id,
        numero: dossier.numero,
        assujetti: dossier.assujetti,
        type: dossier.type,
        statut: dossier.statut,
        date_echeance: dateEcheance,
        niveau_alerte: niveau,
        days_remaining: daysRemaining,
      } satisfies ContentieuxAlertRow;
    })
    .filter((row): row is ContentieuxAlertRow => Boolean(row))
    .sort((left, right) => left.days_remaining - right.days_remaining || left.numero.localeCompare(right.numero, 'fr'));

  const indicators = {
    total_dossiers: dossiers.length,
    montant_litige_total: Number(dossiers.reduce((sum, row) => sum + (row.montant_litige ?? 0), 0).toFixed(2)),
    montant_degreve_total: Number(dossiers.reduce((sum, row) => sum + (row.montant_degreve ?? 0), 0).toFixed(2)),
  };
  const generatedAt = formatDateTime(new Date());
  const chart = rows.map((row) => ({
    type: row.type,
    nombre_dossiers: row.nombre_dossiers,
    montant_litige: row.montant_litige,
  }));
  const hash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        date_reference: dateReference,
        indicators,
        rows,
        alerts: alertsRows,
      }),
    )
    .digest('hex');

  return {
    date_reference: dateReference,
    generatedAt,
    hash,
    indicators,
    rows,
    chart,
    alerts: {
      total: alertsRows.length,
      overdue: alertsRows.filter((row) => row.niveau_alerte === 'depasse').length,
      rows: alertsRows,
    },
  };
}

function buildContentieuxWorkbook(payload: ContentieuxReportPayload): Buffer {
  const rows: Array<Array<string | number>> = [
    ['Synthèse des contentieux'],
    ['Date de référence', payload.date_reference],
    ['Horodatage', payload.generatedAt],
    ['Hash SHA-256', payload.hash],
    ['Total dossiers', payload.indicators.total_dossiers],
    ['Montant en litige', payload.indicators.montant_litige_total],
    ['Montant dégrevé', payload.indicators.montant_degreve_total],
    [],
    ['Type', 'Nombre dossiers', 'Montant en litige', 'Montant dégrevé', 'Ancienneté moyenne (jours)', 'Statuts'],
    ...payload.rows.map((row) => [
      contentieuxTypeLabel(row.type),
      row.nombre_dossiers,
      row.montant_litige,
      row.montant_degreve,
      row.anciennete_moyenne_jours,
      row.statut_resume,
    ]),
    [],
    ['Alertes délais'],
    ['Numéro', 'Assujetti', 'Type', 'Statut', 'Échéance', 'Niveau', 'Jours restants'],
    ...payload.alerts.rows.map((row) => [
      row.numero,
      row.assujetti,
      contentieuxTypeLabel(row.type),
      contentieuxStatusLabel(row.statut),
      row.date_echeance,
      row.niveau_alerte,
      row.days_remaining,
    ]),
  ];

  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet['!cols'] = [
    { wch: 18 },
    { wch: 18 },
    { wch: 18 },
    { wch: 18 },
    { wch: 22 },
    { wch: 34 },
    { wch: 14 },
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Synthèse contentieux');
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
}

async function buildContentieuxPdfBuffer(payload: ContentieuxReportPayload): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('Synthèse des contentieux', { align: 'center' });
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor('#555').text(`Date de référence : ${payload.date_reference}`, { align: 'center' });
    doc.moveDown(0.6).fillColor('black');
    doc.text(`Horodatage : ${payload.generatedAt}`);
    doc.text(`Hash SHA-256 : ${payload.hash}`);
    doc.text(`Dossiers : ${payload.indicators.total_dossiers} • Litige : ${formatMoney(payload.indicators.montant_litige_total)} • Dégrèvement : ${formatMoney(payload.indicators.montant_degreve_total)}`);
    doc.moveDown();

    doc.fontSize(12).text('Répartition par type', { underline: true });
    doc.moveDown(0.4);
    doc.fontSize(10);
    for (const row of payload.rows) {
      doc.text(`${contentieuxTypeLabel(row.type)} • ${row.nombre_dossiers} dossier(s) • Litige ${formatMoney(row.montant_litige)} • Dégrèvement ${formatMoney(row.montant_degreve)} • Ancienneté ${row.anciennete_moyenne_jours} j • ${row.statut_resume}`);
      doc.moveDown(0.2);
    }

    doc.moveDown();
    doc.fontSize(12).text('Alertes délais', { underline: true });
    doc.moveDown(0.4);
    doc.fontSize(10);
    if (payload.alerts.rows.length === 0) {
      doc.fillColor('#666').text('Aucune alerte <= J-30 pour cette date de référence.');
      doc.fillColor('black');
    } else {
      for (const alert of payload.alerts.rows) {
        doc.text(`${alert.numero} • ${alert.assujetti} • ${contentieuxTypeLabel(alert.type)} • ${alert.date_echeance} • ${alert.niveau_alerte} • ${alert.days_remaining} j`);
        doc.moveDown(0.2);
      }
    }

    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      doc.switchToPage(index);
      doc.fontSize(8).fillColor('#555').text(`Page ${index - range.start + 1}/${range.count}`, 36, 800, { align: 'center', width: 523 });
      doc.fillColor('black');
    }

    doc.end();
  });
}

async function archiveContentieuxReport(params: {
  dateReference: string;
  format: 'pdf' | 'xlsx';
  buffer: Buffer;
  hash: string;
  rowCount: number;
  totalMontant: number;
  generatedBy: number;
}): Promise<{ filename: string; storagePath: string }> {
  const archiveYear = Number(params.dateReference.slice(0, 4));
  const filename = `synthese-contentieux-${params.dateReference}.${params.format}`;
  const storagePath = path.posix.join(
    'rapports',
    'synthese_contentieux',
    String(archiveYear),
    `${Date.now()}-${sanitizeFileComponent(params.hash.slice(0, 12))}.${params.format}`,
  );
  await saveFile(
    storagePath,
    params.buffer,
    params.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );

  try {
    db.prepare(
      `INSERT INTO rapports_exports (
        type_rapport, annee, format, filename, storage_path, content_hash, titres_count, total_montant, generated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'synthese_contentieux',
      archiveYear,
      params.format,
      filename,
      storagePath,
      params.hash,
      params.rowCount,
      params.totalMontant,
      params.generatedBy,
    );
  } catch (error) {
    try {
      await deleteStoredFile(storagePath);
    } catch (cleanupError) {
      console.error('[TLPE] Echec nettoyage archive synthese contentieux', cleanupError);
    }
    throw error;
  }

  return { filename, storagePath };
}

rapportsRouter.get('/contentieux', requireRole('admin', 'financier'), async (req, res) => {
  const parsed = contentieuxReportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parametres de synthese contentieux invalides' });
  }

  const dateReference = parsed.data.date_reference ?? new Date().toISOString().slice(0, 10);

  try {
    const payload = buildContentieuxReportPayload(dateReference);

    if (parsed.data.format === 'json') {
      return res.json(payload);
    }

    const buffer = parsed.data.format === 'pdf'
      ? await buildContentieuxPdfBuffer(payload)
      : buildContentieuxWorkbook(payload);
    const archive = await archiveContentieuxReport({
      dateReference,
      format: parsed.data.format,
      buffer,
      hash: payload.hash,
      rowCount: payload.indicators.total_dossiers,
      totalMontant: payload.indicators.montant_litige_total,
      generatedBy: req.user!.id,
    });

    logAudit({
      userId: req.user!.id,
      action: 'export-synthese-contentieux',
      entite: 'rapport',
      details: {
        date_reference: payload.date_reference,
        format: parsed.data.format,
        generated_at: payload.generatedAt,
        hash: payload.hash,
        dossiers_count: payload.indicators.total_dossiers,
        montant_litige_total: payload.indicators.montant_litige_total,
        montant_degreve_total: payload.indicators.montant_degreve_total,
        alerts_total: payload.alerts.total,
        alerts_overdue: payload.alerts.overdue,
        archive_path: archive.storagePath,
      },
      ip: req.ip ?? null,
    });

    res.setHeader(
      'Content-Type',
      parsed.data.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${archive.filename}"`);
    return res.send(buffer);
  } catch (error) {
    console.error('[TLPE] Erreur generation synthese contentieux', error);
    return res.status(500).json({ error: 'Erreur interne generation synthese contentieux' });
  }
});

rapportsRouter.get('/role', requireRole('admin', 'financier'), async (req, res) => {
  const parsed = roleReportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parametres du role TLPE invalides' });
  }

  try {
    const payload = buildRoleReportPayload(parsed.data.annee);
    const buffer = parsed.data.format === 'pdf' ? await buildRoleReportPdfBuffer(payload) : buildRoleReportWorkbook(payload);

    const archive = await archiveRoleReport({
      annee: payload.annee,
      format: parsed.data.format,
      buffer,
      hash: payload.hash,
      titresCount: payload.titresCount,
      totalMontant: payload.totalMontant,
      generatedBy: req.user!.id,
    });

    logAudit({
      userId: req.user!.id,
      action: 'export-role-tlpe',
      entite: 'rapport',
      details: {
        annee: payload.annee,
        format: parsed.data.format,
        generated_at: payload.generatedAt,
        hash: payload.hash,
        titres_count: payload.titresCount,
        total_montant: payload.totalMontant,
        archive_path: archive.storagePath,
      },
      ip: req.ip ?? null,
    });

    res.setHeader(
      'Content-Type',
      parsed.data.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${archive.filename}"`);
    return res.send(buffer);
  } catch (error) {
    console.error('[TLPE] Erreur generation role TLPE', error);
    return res.status(500).json({ error: 'Erreur interne generation role TLPE' });
  }
});

rapportsRouter.get('/recouvrement', requireRole('admin', 'financier'), async (req, res) => {
  const parsed = recouvrementReportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parametres de recouvrement invalides' });
  }

  const filters: RecouvrementFilters = {
    annee: parsed.data.annee,
    zoneId: parsed.data.zone ?? null,
    categorie: parsed.data.categorie ?? null,
    statutPaiement: parsed.data.statut_paiement ?? null,
    ventilation: parsed.data.ventilation,
  };

  try {
    const payload = buildRecouvrementReportPayload(filters);

    if (parsed.data.format === 'json') {
      return res.json(payload);
    }

    const buffer = parsed.data.format === 'pdf' ? await buildRecouvrementPdfBuffer(payload) : buildRecouvrementWorkbook(payload);
    const archive = await archiveRecouvrementReport({
      annee: filters.annee,
      ventilation: filters.ventilation,
      format: parsed.data.format,
      buffer,
      hash: payload.hash,
      titresCount: payload.titresCount,
      totalMontant: payload.totals.montant_emis,
      generatedBy: req.user!.id,
    });

    logAudit({
      userId: req.user!.id,
      action: 'export-etat-recouvrement',
      entite: 'rapport',
      details: {
        annee: filters.annee,
        format: parsed.data.format,
        ventilation: filters.ventilation,
        zone_id: filters.zoneId,
        categorie: filters.categorie,
        statut_paiement: filters.statutPaiement,
        generated_at: payload.generatedAt,
        hash: payload.hash,
        titres_count: payload.titresCount,
        montant_emis: payload.totals.montant_emis,
        montant_recouvre: payload.totals.montant_recouvre,
        reste_a_recouvrer: payload.totals.reste_a_recouvrer,
        archive_path: archive.storagePath,
      },
      ip: req.ip ?? null,
    });

    res.setHeader(
      'Content-Type',
      parsed.data.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${archive.filename}"`);
    return res.send(buffer);
  } catch (error) {
    console.error('[TLPE] Erreur generation etat de recouvrement', error);
    return res.status(500).json({ error: 'Erreur interne generation etat de recouvrement' });
  }
});

rapportsRouter.get('/relances', requireRole('admin', 'gestionnaire'), async (req, res) => {
  const parsed = relancesReportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parametres du suivi des relances invalides' });
  }

  const filters = {
    dateDebut: parsed.data.date_debut,
    dateFin: parsed.data.date_fin,
    type: parsed.data.type ?? null,
    statut: parsed.data.statut ?? null,
  };

  try {
    const payload = buildRelancesReportPayload(filters);

    if (parsed.data.format === 'json') {
      return res.json(payload);
    }

    const buffer = parsed.data.format === 'pdf' ? await buildRelancesPdfBuffer(payload) : buildRelancesWorkbook(payload);
    const archive = await archiveRelancesReport({
      dateDebut: filters.dateDebut,
      dateFin: filters.dateFin,
      format: parsed.data.format,
      buffer,
      hash: payload.hash,
      rowCount: payload.rows.length,
      sentCount: payload.indicators.envoyees,
      generatedBy: req.user!.id,
    });

    logAudit({
      userId: req.user!.id,
      action: 'export-suivi-relances',
      entite: 'rapport',
      details: {
        date_debut: filters.dateDebut,
        date_fin: filters.dateFin,
        type: filters.type,
        statut: filters.statut,
        format: parsed.data.format,
        generated_at: payload.generatedAt,
        hash: payload.hash,
        rows_count: payload.rows.length,
        envoyees: payload.indicators.envoyees,
        archive_path: archive.storagePath,
      },
      ip: req.ip ?? null,
    });

    res.setHeader(
      'Content-Type',
      parsed.data.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${archive.filename}"`);
    return res.send(buffer);
  } catch (error) {
    console.error('[TLPE] Erreur generation suivi des relances', error);
    return res.status(500).json({ error: 'Erreur interne generation suivi des relances' });
  }
});
