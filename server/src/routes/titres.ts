import { Router } from 'express';
import { z } from 'zod';
import PDFDocument from 'pdfkit';
import XLSX from 'xlsx';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { db, logAudit } from '../db';
import { authMiddleware, requireRole } from '../auth';
import { deleteStoredFile, saveFile } from './piecesJointes';
import { registerPayfipTitresRoutes } from './paiements';

export const titresRouter = Router();

titresRouter.use(authMiddleware);

registerPayfipTitresRoutes(titresRouter);

const BORDEREAU_COLLECTIVITE = process.env.TLPE_COLLECTIVITE || 'Collectivite territoriale';
const BORDEREAU_ORDONNATEUR = process.env.TLPE_ORDONNATEUR || 'Ordonnateur TLPE';

class Pesv2RouteError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'Pesv2RouteError';
  }
}

function genNumeroTitre(annee: number): string {
  const c = (db.prepare('SELECT COUNT(*) AS c FROM titres WHERE annee = ?').get(annee) as { c: number }).c;
  return `TIT-${annee}-${String(c + 1).padStart(6, '0')}`;
}

function buildNumeroMiseEnDemeure(annee: number, ordre: number): string {
  return `MED-${annee}-${String(ordre).padStart(6, '0')}`;
}

function allocateNumeroOrdreMiseEnDemeure(annee: number): number {
  db.exec('BEGIN IMMEDIATE');
  try {
    const next = (
      db
        .prepare(
          `SELECT COALESCE(MAX(numero_ordre), 0) + 1 AS next
           FROM titre_mises_en_demeure_sequences
           WHERE annee = ?`,
        )
        .get(annee) as { next: number }
    ).next;

    db.prepare(`INSERT INTO titre_mises_en_demeure_sequences (annee, numero_ordre) VALUES (?, ?)`).run(annee, next);
    db.exec('COMMIT');
    return next;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function genNumeroMiseEnDemeure(annee: number): string {
  return buildNumeroMiseEnDemeure(annee, allocateNumeroOrdreMiseEnDemeure(annee));
}

function buildTitreMiseEnDemeureStoragePath(annee: number, nom: string): string {
  return path.posix.join('mises_en_demeure_titres', String(annee), nom);
}

type TitreMiseEnDemeureRow = {
  titre_id: number;
  numero: string;
  piece_jointe_id: number;
  chemin: string;
  nom: string;
  deleted_at?: string | null;
};

type TitreWithDebiteur = {
  id: number;
  numero: string;
  declaration_id: number;
  assujetti_id: number;
  annee: number;
  montant: number;
  montant_paye: number;
  date_emission: string;
  date_echeance: string;
  statut: string;
  raison_sociale: string;
  identifiant_tlpe: string;
  siret: string | null;
  adresse_rue: string | null;
  adresse_cp: string | null;
  adresse_ville: string | null;
};

function createMiseEnDemeurePdf(
  titre: TitreWithDebiteur,
  numeroMiseEnDemeure: string,
): Promise<{ nom: string; chemin: string; taille: number; buffer: Buffer }> {
  const nom = `${numeroMiseEnDemeure}.pdf`;
  const chemin = buildTitreMiseEnDemeureStoragePath(titre.annee, nom);
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  const chunks: Buffer[] = [];

  return new Promise<{ nom: string; chemin: string; taille: number; buffer: Buffer }>((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on('error', reject);
    doc.on('end', () => {
      const buffer = Buffer.concat(chunks);
      resolve({
        nom,
        chemin,
        taille: buffer.length,
        buffer,
      });
    });

    const montantDu = Number((titre.montant - titre.montant_paye).toFixed(2));
    const adresse = [titre.adresse_rue, [titre.adresse_cp, titre.adresse_ville].filter(Boolean).join(' ')].filter(Boolean).join(' - ');

    doc.fontSize(13).text(BORDEREAU_COLLECTIVITE);
    doc.fontSize(10).fillColor('#555').text(BORDEREAU_ORDONNATEUR);
    doc.moveDown(1).fillColor('black');
    doc.fontSize(18).text('MISE EN DEMEURE DE PAYER - TLPE', { align: 'center' });
    doc.moveDown(0.6);
    doc.fontSize(11).fillColor('#555').text('Lettre recommandee avec accuse de reception', { align: 'center' });
    doc.moveDown(1).fillColor('black');

    doc.fontSize(11);
    doc.text(`Numero de mise en demeure : ${numeroMiseEnDemeure}`);
    doc.text(`Reference du titre : ${titre.numero}`);
    doc.text(`Date d'emission du titre : ${titre.date_emission}`);
    doc.text(`Date d'echeance initiale : ${titre.date_echeance}`);
    doc.text('Delai de paiement apres reception : 30 jours');
    doc.moveDown();

    doc.fontSize(12).text('Debiteur', { underline: true });
    doc.fontSize(11);
    doc.text(`Raison sociale : ${titre.raison_sociale}`);
    doc.text(`Identifiant TLPE : ${titre.identifiant_tlpe}`);
    if (titre.siret) doc.text(`SIRET : ${titre.siret}`);
    if (adresse) doc.text(`Adresse : ${adresse}`);
    doc.moveDown();

    doc.fontSize(12).text('Montants dus', { underline: true });
    doc.fontSize(11);
    doc.text(`Montant initial du titre : ${titre.montant.toFixed(2)} EUR`);
    doc.text(`Montant deja regle : ${titre.montant_paye.toFixed(2)} EUR`);
    doc.text(`Montant restant du : ${montantDu.toFixed(2)} EUR`);
    doc.moveDown();

    doc.fontSize(12).text('Objet', { underline: true });
    doc.fontSize(11).text(
      'Par la presente, vous etes mis en demeure de regler le solde du titre de recettes mentionne ci-dessus dans un delai de 30 jours a compter de la reception de ce courrier.',
      { align: 'justify' },
    );
    doc.moveDown();
    doc.text(
      'A defaut de paiement dans ce delai, la collectivite pourra engager la procedure de recouvrement force et transmettre le dossier au comptable public.',
      { align: 'justify' },
    );
    doc.moveDown();
    doc.fontSize(12).text('Voies de recours et mentions legales', { underline: true });
    doc.fontSize(11).text(
      'Toute contestation doit etre adressee au service TLPE par ecrit, avec les justificatifs utiles, dans les delais legaux applicables. Le present courrier vaut mise en demeure prealable avant poursuites de recouvrement.',
      { align: 'justify' },
    );
    doc.moveDown(2);

    doc.text('Fait pour servir et valoir ce que de droit.');
    doc.moveDown(2);
    doc.text(BORDEREAU_ORDONNATEUR, { align: 'right' });
    doc.end();
  });
}

async function ensureMiseEnDemeureForTitre(params: {
  titre: TitreWithDebiteur;
  userId: number;
  mode: 'manuel' | 'batch';
  ip?: string | null;
}): Promise<TitreMiseEnDemeureRow> {
  const existing = db
    .prepare(
      `SELECT med.titre_id, med.numero, med.piece_jointe_id, pj.chemin, pj.nom, pj.deleted_at
       FROM titre_mises_en_demeure med
       JOIN pieces_jointes pj ON pj.id = med.piece_jointe_id
       WHERE med.titre_id = ?
       LIMIT 1`,
    )
    .get(params.titre.id) as TitreMiseEnDemeureRow | undefined;
  if (existing && !existing.deleted_at) return existing;

  const solde = Number((params.titre.montant - params.titre.montant_paye).toFixed(2));
  if (solde <= 0 || params.titre.statut === 'paye') {
    throw new Pesv2RouteError('Impossible de generer une mise en demeure pour un titre deja solde', 409);
  }

  const numero = genNumeroMiseEnDemeure(params.titre.annee);
  const pdf = await createMiseEnDemeurePdf(params.titre, numero);
  await saveFile(pdf.chemin, pdf.buffer, 'application/pdf');

  const txResult = db.transaction(() => {
    const pieceInfo = db
      .prepare(
        `INSERT INTO pieces_jointes (entite, entite_id, nom, mime_type, taille, chemin, uploaded_by)
         VALUES ('titre', ?, ?, 'application/pdf', ?, ?, ?)`,
      )
      .run(params.titre.id, pdf.nom, pdf.taille, pdf.chemin, params.userId);

    const pieceJointeId = Number(pieceInfo.lastInsertRowid);

    if (existing?.deleted_at) {
      db.prepare(
        `UPDATE titre_mises_en_demeure
         SET numero = ?, piece_jointe_id = ?, mode = ?, generated_by = ?, created_at = datetime('now')
         WHERE titre_id = ?`,
      ).run(numero, pieceJointeId, params.mode, params.userId, params.titre.id);
    } else {
      db.prepare(
        `INSERT INTO titre_mises_en_demeure (numero, titre_id, piece_jointe_id, annee, mode, generated_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(numero, params.titre.id, pieceJointeId, params.titre.annee, params.mode, params.userId);
    }

    if (params.titre.statut !== 'mise_en_demeure') {
      db.prepare(`UPDATE titres SET statut = 'mise_en_demeure' WHERE id = ?`).run(params.titre.id);
    }

    logAudit({
      userId: params.userId,
      action: 'generate-mise-en-demeure',
      entite: 'titre',
      entiteId: params.titre.id,
      details: {
        numero,
        titre_numero: params.titre.numero,
        piece_jointe_id: pieceJointeId,
        mode: params.mode,
        solde,
        regenerated_after_soft_delete: Boolean(existing?.deleted_at),
      },
      ip: params.ip ?? null,
    });

    return {
      titre_id: params.titre.id,
      numero,
      piece_jointe_id: pieceJointeId,
      chemin: pdf.chemin,
      nom: pdf.nom,
      deleted_at: null,
    } satisfies TitreMiseEnDemeureRow;
  });

  try {
    return txResult();
  } catch (error) {
    await deleteStoredFile(pdf.chemin).catch(() => undefined);
    throw error;
  }
}

function formatDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function xmlEscape(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeIsoDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Pesv2RouteError(`Date invalide: ${date}`, 400);
  }
  const normalized = parsed.toISOString().slice(0, 10);
  if (normalized !== date) {
    throw new Pesv2RouteError(`Date invalide: ${date}`, 400);
  }
  return normalized;
}

function resolvePesv2XsdPath(currentDir = __dirname): string {
  const candidates = [
    path.resolve(currentDir, '..', 'xsd', 'pesv2-titres.xsd'),
    path.resolve(currentDir, '..', '..', 'src', 'xsd', 'pesv2-titres.xsd'),
  ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved) {
    throw new Pesv2RouteError('Schéma XSD PESV2 introuvable', 500);
  }
  return resolved;
}

type Pesv2Row = {
  id: number;
  numero: string;
  declaration_numero: string;
  assujetti_id: number;
  annee: number;
  montant: number;
  date_emission: string;
  date_echeance: string;
  raison_sociale: string;
  identifiant_tlpe: string;
  siret: string | null;
};

type Pesv2Selection =
  | {
      selectionType: 'campagne';
      campagneId: number;
      campagneAnnee: number;
      titres: Pesv2Row[];
      selectionLabel: string;
    }
  | {
      selectionType: 'periode';
      dateDebut: string;
      dateFin: string;
      titres: Pesv2Row[];
      selectionLabel: string;
    };

type Pesv2ValidationResult = {
  ok: boolean;
  report: string;
};

function buildPesv2RowsWhere(whereClause: string, params: unknown[]): Pesv2Row[] {
  return db
    .prepare(
      `SELECT t.id, t.numero, d.numero AS declaration_numero, t.assujetti_id, t.annee, t.montant,
              t.date_emission, t.date_echeance, a.raison_sociale, a.identifiant_tlpe, a.siret
       FROM titres t
       JOIN declarations d ON d.id = t.declaration_id
       JOIN assujettis a ON a.id = t.assujetti_id
       ${whereClause}
       ORDER BY t.numero`,
    )
    .all(...params) as Pesv2Row[];
}

function loadPesv2Selection(input: { campagne_id?: number; date_debut?: string; date_fin?: string }): Pesv2Selection {
  if (input.campagne_id !== undefined) {
    const campagne = db.prepare('SELECT id, annee, statut FROM campagnes WHERE id = ?').get(input.campagne_id) as
      | { id: number; annee: number; statut: string }
      | undefined;
    if (!campagne) {
      throw new Pesv2RouteError('Campagne introuvable', 404);
    }
    if (campagne.statut !== 'cloturee') {
      throw new Pesv2RouteError('Seules les campagnes clôturées peuvent être exportées en PESV2', 400);
    }

    return {
      selectionType: 'campagne',
      campagneId: campagne.id,
      campagneAnnee: campagne.annee,
      titres: buildPesv2RowsWhere('WHERE t.annee = ?', [campagne.annee]),
      selectionLabel: `campagne ${campagne.annee}`,
    };
  }

  const dateDebut = normalizeIsoDate(input.date_debut!);
  const dateFin = normalizeIsoDate(input.date_fin!);
  return {
    selectionType: 'periode',
    dateDebut,
    dateFin,
    titres: buildPesv2RowsWhere('WHERE t.date_emission >= ? AND t.date_emission <= ?', [dateDebut, dateFin]),
    selectionLabel: `periode ${dateDebut} -> ${dateFin}`,
  };
}

function buildPesv2Xml(selection: Pesv2Selection, numeroBordereau: number, horodatageExport: string) {
  const totalMontant = Number(selection.titres.reduce((sum, titre) => sum + titre.montant, 0).toFixed(2));
  const selectionFragment =
    selection.selectionType === 'campagne'
      ? `<CampagneId>${selection.campagneId}</CampagneId><AnneeCampagne>${selection.campagneAnnee}</AnneeCampagne>`
      : `<Periode><DateDebut>${selection.dateDebut}</DateDebut><DateFin>${selection.dateFin}</DateFin></Periode>`;

  const titresXml = selection.titres
    .map(
      (titre) => `
    <Titre>
      <NumeroTitre>${xmlEscape(titre.numero)}</NumeroTitre>
      <NumeroDeclaration>${xmlEscape(titre.declaration_numero)}</NumeroDeclaration>
      <AnneeExercice>${titre.annee}</AnneeExercice>
      <DateEmission>${xmlEscape(titre.date_emission)}</DateEmission>
      <DateEcheance>${xmlEscape(titre.date_echeance)}</DateEcheance>
      <Montant>${titre.montant.toFixed(2)}</Montant>
      <Assujetti>
        <IdentifiantTLPE>${xmlEscape(titre.identifiant_tlpe)}</IdentifiantTLPE>
        <RaisonSociale>${xmlEscape(titre.raison_sociale)}</RaisonSociale>
        <Siret>${xmlEscape(titre.siret)}</Siret>
      </Assujetti>
    </Titre>`,
    )
    .join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<PESV2Titres>
  <Entete>
    <Collectivite>${xmlEscape(BORDEREAU_COLLECTIVITE)}</Collectivite>
    <Ordonnateur>${xmlEscape(BORDEREAU_ORDONNATEUR)}</Ordonnateur>
    <NumeroBordereau>${String(numeroBordereau).padStart(6, '0')}</NumeroBordereau>
    <HorodatageExport>${horodatageExport}</HorodatageExport>
    <SelectionType>${selection.selectionType}</SelectionType>
    ${selectionFragment}
    <TitresCount>${selection.titres.length}</TitresCount>
    <TotalMontant>${totalMontant.toFixed(2)}</TotalMontant>
  </Entete>
  <Titres>${titresXml}
  </Titres>
</PESV2Titres>
`;

  return {
    xml,
    totalMontant,
    filename: `pesv2-${String(numeroBordereau).padStart(6, '0')}.xml`,
    xmlHash: crypto.createHash('sha256').update(xml).digest('hex'),
  };
}

function validatePesv2Xml(xml: string): Pesv2ValidationResult {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlpe-pesv2-'));
  const xmlPath = path.join(tempDir, 'export.xml');
  const xsdPath = resolvePesv2XsdPath();
  fs.writeFileSync(xmlPath, xml, 'utf8');
  try {
    const stdout = execFileSync('xmllint', ['--noout', '--schema', xsdPath, xmlPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      ok: true,
      report: (stdout || 'xmllint validation ok').trim(),
    };
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String((error as { stderr?: string | Buffer }).stderr ?? '').trim()
        : String(error);
    return {
      ok: false,
      report: stderr || 'Validation XSD PESV2 en echec',
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function listAlreadyExportedTitres(titres: Pesv2Row[]): string[] {
  if (titres.length === 0) {
    return [];
  }
  const placeholders = titres.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT DISTINCT t.numero
       FROM pesv2_export_titres pet
       JOIN titres t ON t.id = pet.titre_id
       WHERE pet.titre_id IN (${placeholders})
       ORDER BY t.numero`,
    )
    .all(...titres.map((titre) => titre.id)) as Array<{ numero: string }>;
  return rows.map((row) => row.numero);
}

function nextPesv2NumeroBordereau(): number {
  return (
    db.prepare('SELECT COALESCE(MAX(numero_bordereau), 0) + 1 AS next_numero FROM pesv2_exports').get() as {
      next_numero: number;
    }
  ).next_numero;
}

type BordereauRow = {
  id: number;
  numero: string;
  assujetti_id: number;
  annee: number;
  montant: number;
  date_emission: string;
  date_echeance: string;
  statut: string;
  raison_sociale: string;
  identifiant_tlpe: string;
};

type BordereauPayload = {
  collectivite: string;
  ordonnateur: string;
  annee: number;
  generatedAt: string;
  hash: string;
  totalMontant: number;
  titres: BordereauRow[];
};

function buildBordereauPayload(annee: number): BordereauPayload {
  const titres = db
    .prepare(
      `SELECT t.*, a.raison_sociale, a.identifiant_tlpe
       FROM titres t
       JOIN assujettis a ON a.id = t.assujetti_id
       WHERE t.annee = ?
       ORDER BY t.numero`,
    )
    .all(annee) as BordereauRow[];

  const totalMontant = Number(titres.reduce((sum, titre) => sum + titre.montant, 0).toFixed(2));
  const generatedAt = formatDateTime(new Date());
  const hash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        collectivite: BORDEREAU_COLLECTIVITE,
        ordonnateur: BORDEREAU_ORDONNATEUR,
        annee,
        titres: titres.map((titre) => ({
          numero: titre.numero,
          debiteur: titre.raison_sociale,
          identifiant_tlpe: titre.identifiant_tlpe,
          montant: titre.montant,
          date_echeance: titre.date_echeance,
        })),
        totalMontant,
      }),
    )
    .digest('hex');

  return {
    collectivite: BORDEREAU_COLLECTIVITE,
    ordonnateur: BORDEREAU_ORDONNATEUR,
    annee,
    generatedAt,
    hash,
    totalMontant,
    titres,
  };
}

function exportBordereauPdf(res: import('express').Response, payload: BordereauPayload) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="bordereau-titres-${payload.annee}.pdf"`);

  const doc = new PDFDocument({ size: 'A4', margin: 42 });
  doc.pipe(res);

  doc.fontSize(17).text('BORDEREAU RECAPITULATIF DES TITRES DE RECETTES', { align: 'center' });
  doc.moveDown(0.4);
  doc.fontSize(10).fillColor('#555').text(`Collectivite : ${payload.collectivite}`, { align: 'center' });
  doc.text(`Exercice / campagne : ${payload.annee}`, { align: 'center' });
  doc.moveDown(0.8).fillColor('black');

  doc.fontSize(10);
  doc.text(`Horodatage : ${payload.generatedAt}`);
  doc.text(`Hash SHA-256 : ${payload.hash}`);
  doc.moveDown();

  const columns = [
    { label: 'Numero', x: 42, width: 105 },
    { label: 'Debiteur', x: 147, width: 185 },
    { label: 'Montant', x: 332, width: 90 },
    { label: 'Echeance', x: 422, width: 85 },
  ];

  const printHeader = () => {
    const tableTop = doc.y;
    doc.fontSize(9).fillColor('#333');
    columns.forEach((column) => {
      doc.text(column.label, column.x, tableTop, { width: column.width });
    });
    doc.moveTo(42, tableTop + 14).lineTo(540, tableTop + 14).stroke();
    doc.y = tableTop + 20;
  };

  const ensurePage = () => {
    if (doc.y > 740) {
      doc.addPage();
      printHeader();
    }
  };

  printHeader();
  for (const titre of payload.titres) {
    ensurePage();
    const y = doc.y;
    doc.text(titre.numero, columns[0].x, y, { width: columns[0].width });
    doc.text(`${titre.raison_sociale}\n${titre.identifiant_tlpe}`, columns[1].x, y, { width: columns[1].width });
    doc.text(`${titre.montant.toFixed(2)} EUR`, columns[2].x, y, { width: columns[2].width, align: 'right' });
    doc.text(titre.date_echeance, columns[3].x, y, { width: columns[3].width });
    const rowBottom = Math.max(doc.y, y + 30);
    doc.moveTo(42, rowBottom + 4).lineTo(540, rowBottom + 4).strokeColor('#d8d8d8').stroke().strokeColor('black');
    doc.y = rowBottom + 10;
  }

  if (payload.titres.length === 0) {
    doc.fontSize(10).fillColor('#666').text('Aucun titre emis pour cet exercice.', 42, doc.y + 4);
    doc.moveDown(2).fillColor('black');
  }

  doc.moveDown(1);
  doc.fontSize(12).text(`Total general : ${payload.totalMontant.toFixed(2)} EUR`, { align: 'right' });
  doc.moveDown(2);
  doc.fontSize(11).text(`Signature ordonnateur : ${payload.ordonnateur}`, { align: 'left' });
  doc.moveDown(0.3);
  doc.fontSize(9).fillColor('#555').text('Document genere automatiquement pour transmission au comptable public.', {
    align: 'left',
  });

  doc.end();
}

function exportBordereauXlsx(res: import('express').Response, payload: BordereauPayload) {
  const rows: Array<Array<string | number>> = [
    ['Bordereau récapitulatif des titres de recettes'],
    ['Annee', payload.annee],
    ['Horodatage', payload.generatedAt],
    ['Hash SHA-256', payload.hash],
    [],
    ['Numero', 'Debiteur', 'Montant', 'Echeance'],
    ...payload.titres.map((titre) => [titre.numero, titre.raison_sociale, titre.montant, titre.date_echeance]),
    ['TOTAL', '', payload.totalMontant, ''],
    [],
    ['Collectivite', payload.collectivite],
    ['Signature ordonnateur', payload.ordonnateur],
  ];

  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet['!cols'] = [{ wch: 18 }, { wch: 32 }, { wch: 14 }, { wch: 14 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Bordereau');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="bordereau-titres-${payload.annee}.xlsx"`);
  res.send(Buffer.from(buffer));
}

titresRouter.get('/', (req, res) => {
  const { annee, statut, assujetti_id } = req.query as {
    annee?: string;
    statut?: string;
    assujetti_id?: string;
  };
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (req.user!.role === 'contribuable') {
    if (!req.user!.assujetti_id) return res.json([]);
    conditions.push('t.assujetti_id = ?');
    params.push(req.user!.assujetti_id);
  } else if (assujetti_id) {
    conditions.push('t.assujetti_id = ?');
    params.push(Number(assujetti_id));
  }
  if (annee) {
    conditions.push('t.annee = ?');
    params.push(Number(annee));
  }
  if (statut) {
    conditions.push('t.statut = ?');
    params.push(statut);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT t.*, a.raison_sociale, a.identifiant_tlpe
       FROM titres t
       LEFT JOIN assujettis a ON a.id = t.assujetti_id
       ${where}
       ORDER BY t.annee DESC, t.numero`,
    )
    .all(...params);
  res.json(rows);
});

const bordereauQuerySchema = z.object({
  annee: z.coerce.number().int().min(2000).max(2100),
  format: z.enum(['pdf', 'xlsx']),
});

const pesv2ExportSchema = z
  .object({
    campagne_id: z.number().int().positive().optional(),
    date_debut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    date_fin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    confirm_reexport: z.boolean().optional().default(false),
  })
  .superRefine((data, ctx) => {
    const hasCampagne = data.campagne_id !== undefined;
    const hasPeriod = data.date_debut !== undefined || data.date_fin !== undefined;

    if (hasCampagne === hasPeriod) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Fournir soit campagne_id, soit date_debut + date_fin',
      });
    }

    if (hasPeriod && (!data.date_debut || !data.date_fin)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'date_debut et date_fin sont requis pour une sélection par période',
      });
    }

    if (data.date_debut && data.date_fin && data.date_debut > data.date_fin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'date_debut doit être antérieure ou égale à date_fin',
      });
    }
  });

titresRouter.get('/bordereau', requireRole('admin', 'financier'), (req, res) => {
  const parsed = bordereauQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parametres de bordereau invalides' });
  }

  const payload = buildBordereauPayload(parsed.data.annee);
  logAudit({
    userId: req.user!.id,
    action: 'export-bordereau',
    entite: 'titre',
    details: {
      annee: payload.annee,
      format: parsed.data.format,
      generated_at: payload.generatedAt,
      hash: payload.hash,
      total_montant: payload.totalMontant,
      titres_count: payload.titres.length,
    },
    ip: req.ip ?? null,
  });

  if (parsed.data.format === 'pdf') {
    exportBordereauPdf(res, payload);
    return;
  }

  exportBordereauXlsx(res, payload);
});

titresRouter.post('/export-pesv2', requireRole('admin', 'financier'), (req, res) => {
  const parsed = pesv2ExportSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const selection = loadPesv2Selection(parsed.data);
    if (selection.titres.length === 0) {
      return res.status(404).json({ error: 'Aucun titre à exporter pour cette sélection' });
    }

    const alreadyExported = listAlreadyExportedTitres(selection.titres);
    if (alreadyExported.length > 0 && !parsed.data.confirm_reexport) {
      return res.status(409).json({
        error: `Au moins un titre est déjà exporté (${alreadyExported.join(', ')}). Confirmation requise pour réexporter.`,
      });
    }

    const numeroBordereau = nextPesv2NumeroBordereau();
    const horodatageExport = new Date().toISOString();
    const built = buildPesv2Xml(selection, numeroBordereau, horodatageExport);
    const validation = validatePesv2Xml(built.xml);
    if (!validation.ok) {
      console.error('[TLPE] Validation XSD PESV2 en échec', validation.report);
      return res.status(500).json({ error: 'Erreur interne export PESV2' });
    }

    const exportInfo = db
      .prepare(
        `INSERT INTO pesv2_exports (
          numero_bordereau, selection_type, campagne_id, date_debut, date_fin, exported_by, filename,
          xml_hash, xsd_validation_ok, xsd_validation_report, titres_count, total_montant, confirmation_reexport
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        numeroBordereau,
        selection.selectionType,
        selection.selectionType === 'campagne' ? selection.campagneId : null,
        selection.selectionType === 'periode' ? selection.dateDebut : null,
        selection.selectionType === 'periode' ? selection.dateFin : null,
        req.user!.id,
        built.filename,
        built.xmlHash,
        1,
        validation.report,
        selection.titres.length,
        built.totalMontant,
        parsed.data.confirm_reexport ? 1 : 0,
      );

    const exportId = Number(exportInfo.lastInsertRowid);
    const insertTitreExport = db.prepare(
      'INSERT INTO pesv2_export_titres (export_id, titre_id) VALUES (?, ?)',
    );
    const persistTitreLinks = db.transaction((titreIds: number[]) => {
      for (const titreId of titreIds) {
        insertTitreExport.run(exportId, titreId);
      }
    });
    persistTitreLinks(selection.titres.map((titre) => titre.id));

    logAudit({
      userId: req.user!.id,
      action: 'export-pesv2',
      entite: 'titre',
      details: {
        export_id: exportId,
        numero_bordereau: numeroBordereau,
        selection_type: selection.selectionType,
        selection: selection.selectionLabel,
        titres_count: selection.titres.length,
        total_montant: built.totalMontant,
        xml_hash: built.xmlHash,
        xsd_validation_ok: validation.ok,
        confirmation_reexport: parsed.data.confirm_reexport,
      },
      ip: req.ip ?? null,
    });

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${built.filename}"`);
    res.send(built.xml);
  } catch (error) {
    if (error instanceof Pesv2RouteError) {
      return res.status(error.status).json({ error: error.status >= 500 ? 'Erreur interne export PESV2' : error.message });
    }

    console.error('[TLPE] Erreur export PESV2 inattendue', error);
    return res.status(500).json({ error: 'Erreur interne export PESV2' });
  }
});

function loadTitreForMiseEnDemeure(titreId: string): TitreWithDebiteur | undefined {
  return db
    .prepare(
      `SELECT t.id, t.numero, t.declaration_id, t.assujetti_id, t.annee, t.montant, t.montant_paye,
              t.date_emission, t.date_echeance, t.statut, a.raison_sociale, a.identifiant_tlpe,
              a.siret, a.adresse_rue, a.adresse_cp, a.adresse_ville
       FROM titres t
       JOIN assujettis a ON a.id = t.assujetti_id
       WHERE t.id = ?`,
    )
    .get(titreId) as TitreWithDebiteur | undefined;
}

const miseEnDemeureBatchSchema = z.object({
  titre_ids: z.array(z.number().int().positive()).min(1).max(100),
});

titresRouter.post('/:id/mise-en-demeure', requireRole('admin', 'financier'), async (req, res) => {
  const titre = loadTitreForMiseEnDemeure(req.params.id);
  if (!titre) {
    return res.status(404).json({ error: 'Titre introuvable' });
  }

  try {
    const result = await ensureMiseEnDemeureForTitre({
      titre,
      userId: req.user!.id,
      mode: 'manuel',
      ip: req.ip ?? null,
    });
    return res.status(201).json({
      titre_id: result.titre_id,
      numero: result.numero,
      piece_jointe_id: result.piece_jointe_id,
      download_url: `/api/pieces-jointes/${result.piece_jointe_id}`,
    });
  } catch (error) {
    if (error instanceof Pesv2RouteError) {
      return res.status(error.status).json({ error: error.message });
    }

    console.error('[TLPE] Erreur génération mise en demeure', error);
    return res.status(500).json({ error: 'Erreur interne génération mise en demeure' });
  }
});

titresRouter.post('/mises-en-demeure/batch', requireRole('admin', 'financier'), async (req, res) => {
  const parsed = miseEnDemeureBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const titres = parsed.data.titre_ids.map((titreId) => {
      const titre = loadTitreForMiseEnDemeure(String(titreId));
      if (!titre) {
        throw new Pesv2RouteError(`Titre introuvable: ${titreId}`, 404);
      }
      return titre;
    });

    const titresWithReuseState = titres.map((titre) => {
      const hasActiveMiseEnDemeure = Boolean(
        db
          .prepare(
            `SELECT 1
             FROM titre_mises_en_demeure med
             JOIN pieces_jointes pj ON pj.id = med.piece_jointe_id
             WHERE med.titre_id = ? AND pj.deleted_at IS NULL
             LIMIT 1`,
          )
          .get(titre.id),
      );
      return { titre, hasActiveMiseEnDemeure };
    });

    const titreSolde = titresWithReuseState.find(({ titre, hasActiveMiseEnDemeure }) => {
      if (hasActiveMiseEnDemeure) return false;
      const solde = Number((titre.montant - titre.montant_paye).toFixed(2));
      return solde <= 0 || titre.statut === 'paye';
    });
    if (titreSolde) {
      throw new Pesv2RouteError('Impossible de generer une mise en demeure pour un titre deja solde', 409);
    }

    const items: Array<{ titre_id: number; numero: string; piece_jointe_id: number; download_url: string }> = [];
    for (const { titre } of titresWithReuseState) {
      const result = await ensureMiseEnDemeureForTitre({
        titre,
        userId: req.user!.id,
        mode: 'batch',
        ip: req.ip ?? null,
      });
      items.push({
        titre_id: result.titre_id,
        numero: result.numero,
        piece_jointe_id: result.piece_jointe_id,
        download_url: `/api/pieces-jointes/${result.piece_jointe_id}`,
      });
    }

    return res.status(201).json({ count: items.length, items });
  } catch (error) {
    if (error instanceof Pesv2RouteError) {
      return res.status(error.status).json({ error: error.message });
    }

    console.error('[TLPE] Erreur génération batch mises en demeure', error);
    return res.status(500).json({ error: 'Erreur interne génération batch mises en demeure' });
  }
});

// Emission d'un titre pour une declaration validee
const emettreSchema = z.object({
  declaration_id: z.number().int().positive(),
  date_echeance: z.string().optional(),
});

titresRouter.post('/', requireRole('admin', 'financier'), (req, res) => {
  const parsed = emettreSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { declaration_id, date_echeance } = parsed.data;

  const decl = db.prepare('SELECT * FROM declarations WHERE id = ?').get(declaration_id) as
    | { id: number; assujetti_id: number; statut: string; annee: number; montant_total: number | null }
    | undefined;
  if (!decl) return res.status(404).json({ error: 'Declaration introuvable' });
  if (decl.statut !== 'validee') return res.status(409).json({ error: 'Declaration non validee' });
  if (decl.montant_total === null || decl.montant_total === undefined) {
    return res.status(409).json({ error: 'Montant non calcule' });
  }
  const existing = db.prepare('SELECT id FROM titres WHERE declaration_id = ?').get(declaration_id);
  if (existing) return res.status(409).json({ error: 'Titre deja emis' });

  const numero = genNumeroTitre(decl.annee);
  const echeance = date_echeance || `${decl.annee}-08-31`;
  const info = db
    .prepare(
      `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut)
       VALUES (?, ?, ?, ?, ?, date('now'), ?, 'emis')`,
    )
    .run(numero, decl.id, decl.assujetti_id, decl.annee, decl.montant_total, echeance);

  logAudit({ userId: req.user!.id, action: 'emit', entite: 'titre', entiteId: Number(info.lastInsertRowid) });
  res.status(201).json({ id: info.lastInsertRowid, numero });
});

// PDF du titre (section 7.1)
titresRouter.get('/:id/pdf', (req, res) => {
  const titre = db
    .prepare(
      `SELECT t.*, a.raison_sociale, a.identifiant_tlpe, a.siret,
              a.adresse_rue, a.adresse_cp, a.adresse_ville
       FROM titres t LEFT JOIN assujettis a ON a.id = t.assujetti_id
       WHERE t.id = ?`,
    )
    .get(req.params.id) as
    | {
        id: number;
        numero: string;
        assujetti_id: number;
        annee: number;
        montant: number;
        date_emission: string;
        date_echeance: string;
        statut: string;
        raison_sociale: string;
        identifiant_tlpe: string;
        siret: string | null;
        adresse_rue: string | null;
        adresse_cp: string | null;
        adresse_ville: string | null;
        declaration_id: number;
      }
    | undefined;
  if (!titre) return res.status(404).json({ error: 'Introuvable' });
  if (req.user!.role === 'contribuable' && req.user!.assujetti_id !== titre.assujetti_id) {
    return res.status(403).json({ error: 'Droits insuffisants' });
  }

  const lignes = db
    .prepare(
      `SELECT l.*, d.identifiant AS dispositif_id_lib, d.adresse_rue, d.adresse_ville,
              t.libelle AS type_libelle
       FROM lignes_declaration l
       JOIN dispositifs d ON d.id = l.dispositif_id
       JOIN types_dispositifs t ON t.id = d.type_id
       WHERE l.declaration_id = ?`,
    )
    .all(titre.declaration_id) as Array<{
    dispositif_id_lib: string;
    type_libelle: string;
    adresse_rue: string | null;
    adresse_ville: string | null;
    surface_declaree: number;
    nombre_faces: number;
    quote_part: number;
    tarif_applique: number | null;
    coefficient_zone: number | null;
    prorata: number | null;
    montant_ligne: number | null;
  }>;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="titre-${titre.numero}.pdf"`);

  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  doc.pipe(res);

  doc.fontSize(18).text('TITRE DE RECETTES - TLPE', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor('#555').text(
    'Taxe Locale sur la Publicite Exterieure - Articles L2333-6 a L2333-16 du CGCT',
    { align: 'center' },
  );
  doc.moveDown(1).fillColor('black');

  doc.fontSize(11);
  doc.text(`Numero du titre : ${titre.numero}`);
  doc.text(`Exercice : ${titre.annee}`);
  doc.text(`Date d'emission : ${titre.date_emission}`);
  doc.text(`Date d'echeance : ${titre.date_echeance}`);
  doc.moveDown();

  doc.fontSize(12).text('Debiteur', { underline: true });
  doc.fontSize(11);
  doc.text(`Raison sociale : ${titre.raison_sociale}`);
  doc.text(`Identifiant TLPE : ${titre.identifiant_tlpe}`);
  if (titre.siret) doc.text(`SIRET : ${titre.siret}`);
  const adresse = [titre.adresse_rue, [titre.adresse_cp, titre.adresse_ville].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(' - ');
  if (adresse) doc.text(`Adresse : ${adresse}`);
  doc.moveDown();

  doc.fontSize(12).text('Detail du calcul', { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(9);
  const tableTop = doc.y;
  const cols = [
    { label: 'Dispositif', x: 48, w: 80 },
    { label: 'Type', x: 128, w: 100 },
    { label: 'Surf.', x: 228, w: 36 },
    { label: 'Faces', x: 264, w: 34 },
    { label: 'Quote-part', x: 298, w: 58 },
    { label: 'Tarif', x: 356, w: 44 },
    { label: 'Coef.', x: 400, w: 34 },
    { label: 'Prorata', x: 434, w: 44 },
    { label: 'Montant', x: 478, w: 69 },
  ];
  cols.forEach((c) => doc.text(c.label, c.x, tableTop, { width: c.w }));
  doc.moveTo(48, tableTop + 14).lineTo(547, tableTop + 14).stroke();
  let y = tableTop + 18;
  for (const l of lignes) {
    doc.text(l.dispositif_id_lib, cols[0].x, y, { width: cols[0].w });
    doc.text(l.type_libelle, cols[1].x, y, { width: cols[1].w });
    doc.text(String(l.surface_declaree), cols[2].x, y, { width: cols[2].w });
    doc.text(String(l.nombre_faces), cols[3].x, y, { width: cols[3].w });
    doc.text(`${Math.round((l.quote_part ?? 1) * 100)} %`, cols[4].x, y, { width: cols[4].w });
    doc.text(l.tarif_applique !== null ? `${l.tarif_applique}` : '-', cols[5].x, y, { width: cols[5].w });
    doc.text(l.coefficient_zone !== null ? `${l.coefficient_zone}` : '-', cols[6].x, y, { width: cols[6].w });
    doc.text(l.prorata !== null ? l.prorata.toFixed(2) : '-', cols[7].x, y, { width: cols[7].w });
    doc.text(`${(l.montant_ligne ?? 0).toFixed(2)} EUR`, cols[8].x, y, { width: cols[8].w });
    y += 16;
  }
  doc.moveTo(48, y + 2).lineTo(547, y + 2).stroke();

  doc.moveDown(2);
  doc
    .fontSize(13)
    .fillColor('#003')
    .text(`Montant total du a l'echeance : ${titre.montant.toFixed(2)} EUR`, { align: 'right' });
  doc.fillColor('black').moveDown(1);
  doc
    .fontSize(9)
    .fillColor('#555')
    .text(
      'Le present titre de recettes est rendu executoire par l\'ordonnateur. ' +
        'Le paiement doit intervenir au plus tard a la date d\'echeance indiquee. ' +
        'Reclamation possible aupres du service gestionnaire (delai legal : jusqu\'au 31 decembre de la 2e annee suivant la mise en recouvrement).',
      { align: 'justify' },
    );
  doc.end();
});

// Enregistrement d'un paiement
const paiementSchema = z.object({
  montant: z.number().positive(),
  date_paiement: z.string(),
  modalite: z.enum(['virement', 'cheque', 'tipi', 'sepa', 'numeraire']),
  reference: z.string().optional().nullable(),
  commentaire: z.string().optional().nullable(),
});

titresRouter.post('/:id/paiements', requireRole('admin', 'financier'), (req, res) => {
  const titre = db.prepare('SELECT * FROM titres WHERE id = ?').get(req.params.id) as
    | { id: number; montant: number; montant_paye: number; statut: string }
    | undefined;
  if (!titre) return res.status(404).json({ error: 'Introuvable' });
  const parsed = paiementSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;
  db.prepare(
    `INSERT INTO paiements (titre_id, montant, date_paiement, modalite, reference, commentaire)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(titre.id, d.montant, d.date_paiement, d.modalite, d.reference ?? null, d.commentaire ?? null);

  const newPaye = Number((titre.montant_paye + d.montant).toFixed(2));
  let statut: string = titre.statut;
  if (newPaye >= titre.montant) statut = 'paye';
  else if (newPaye > 0) statut = 'paye_partiel';

  db.prepare('UPDATE titres SET montant_paye = ?, statut = ? WHERE id = ?').run(newPaye, statut, titre.id);
  logAudit({ userId: req.user!.id, action: 'payment', entite: 'titre', entiteId: titre.id, details: d });
  res.status(201).json({ ok: true, montant_paye: newPaye, statut });
});

titresRouter.get('/:id/paiements', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM paiements WHERE titre_id = ? ORDER BY date_paiement DESC')
    .all(req.params.id);
  res.json(rows);
});
