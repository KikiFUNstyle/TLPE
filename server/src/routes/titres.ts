import { Router } from 'express';
import { z } from 'zod';
import PDFDocument from 'pdfkit';
import XLSX from 'xlsx';
import * as crypto from 'node:crypto';
import { db, logAudit } from '../db';
import { authMiddleware, requireRole } from '../auth';

export const titresRouter = Router();

titresRouter.use(authMiddleware);

const BORDEREAU_COLLECTIVITE = process.env.TLPE_COLLECTIVITE || 'Collectivite territoriale';
const BORDEREAU_ORDONNATEUR = process.env.TLPE_ORDONNATEUR || 'Ordonnateur TLPE';

function genNumeroTitre(annee: number): string {
  const c = (db.prepare('SELECT COUNT(*) AS c FROM titres WHERE annee = ?').get(annee) as { c: number }).c;
  return `TIT-${annee}-${String(c + 1).padStart(6, '0')}`;
}

function formatDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
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
