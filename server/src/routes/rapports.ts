import * as crypto from 'node:crypto';
import * as path from 'node:path';
import PDFDocument from 'pdfkit';
import XLSX from 'xlsx';
import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../auth';
import { db, logAudit } from '../db';
import { deleteStoredFile, saveFile } from './piecesJointes';

export const rapportsRouter = Router();

rapportsRouter.use(authMiddleware);

const ROLE_TLPE_COLLECTIVITE = process.env.TLPE_COLLECTIVITE || 'Collectivite territoriale';
const ROLE_TLPE_ORDONNATEUR = process.env.TLPE_ORDONNATEUR || 'Ordonnateur TLPE';

const roleReportQuerySchema = z.object({
  annee: z.coerce.number().int().min(2000).max(2100),
  format: z.enum(['pdf', 'xlsx']),
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

function formatDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function formatMoney(value: number): string {
  return `${value.toFixed(2)} EUR`;
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

function paymentStatusLabel(statut: string): string {
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

    const columns = [
      { label: 'N° titre', x: 36, width: 70 },
      { label: 'Debiteur', x: 106, width: 100 },
      { label: 'SIRET', x: 206, width: 70 },
      { label: 'Adresse', x: 276, width: 120 },
      { label: 'Dispositifs', x: 396, width: 100 },
      { label: 'Montant', x: 496, width: 55 },
      { label: 'Statut paiement', x: 551, width: 40 },
    ] as const;

    const printHeader = () => {
      const top = doc.y;
      doc.fontSize(8).fillColor('#333');
      columns.forEach((column) => {
        doc.text(column.label, column.x, top, { width: column.width });
      });
      doc.moveTo(36, top + 14).lineTo(595, top + 14).stroke();
      doc.y = top + 18;
      doc.fillColor('black');
    };

    const ensurePage = () => {
      if (doc.y > 720) {
        doc.addPage();
        printHeader();
      }
    };

    printHeader();
    doc.fontSize(8);

    for (const row of payload.rows) {
      ensurePage();
      const y = doc.y;
      doc.text(row.numero_titre, columns[0].x, y, { width: columns[0].width });
      doc.text(row.debiteur, columns[1].x, y, { width: columns[1].width });
      doc.text(row.siret || '-', columns[2].x, y, { width: columns[2].width });
      doc.text(row.adresse || '-', columns[3].x, y, { width: columns[3].width });
      doc.text(row.dispositifs, columns[4].x, y, { width: columns[4].width });
      doc.text(formatMoney(row.montant), columns[5].x, y, { width: columns[5].width, align: 'right' });
      doc.text(row.statut_titre, columns[6].x, y, { width: columns[6].width, align: 'right' });
      const rowBottom = Math.max(doc.y, y + 28);
      doc.moveTo(36, rowBottom + 4).lineTo(595, rowBottom + 4).strokeColor('#d8d8d8').stroke().strokeColor('black');
      doc.y = rowBottom + 8;
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

rapportsRouter.get('/role', requireRole('admin', 'financier'), async (req, res) => {
  const parsed = roleReportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parametres du role TLPE invalides' });
  }

  try {
    const payload = buildRoleReportPayload(parsed.data.annee);
    const buffer =
      parsed.data.format === 'pdf'
        ? await buildRoleReportPdfBuffer(payload)
        : buildRoleReportWorkbook(payload);

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
      parsed.data.format === 'pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${archive.filename}"`);
    return res.send(buffer);
  } catch (error) {
    console.error('[TLPE] Erreur generation role TLPE', error);
    return res.status(500).json({ error: 'Erreur interne generation role TLPE' });
  }
});
