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

function formatDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function formatMoney(value: number): string {
  return `${value.toFixed(2)} EUR`;
}

function formatRecouvrementPct(value: number): string {
  return `${(value * 100).toFixed(1)} %`;
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
