import { Router } from 'express';
import { z } from 'zod';
import PDFDocument from 'pdfkit';
import { db, logAudit } from '../db';
import { authMiddleware, requireRole } from '../auth';

export const titresRouter = Router();

titresRouter.use(authMiddleware);

function genNumeroTitre(annee: number): string {
  const c = (db.prepare('SELECT COUNT(*) AS c FROM titres WHERE annee = ?').get(annee) as { c: number }).c;
  return `TIT-${annee}-${String(c + 1).padStart(6, '0')}`;
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
    // 102.30 -> 102 €
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
