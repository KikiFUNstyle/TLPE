import * as fs from 'node:fs';
import * as path from 'node:path';
import { db, logAudit } from './db';

export type EscaladeNiveau = 'J+10' | 'J+30' | 'J+60';
export type EscaladeActionType = 'rappel_email' | 'mise_en_demeure' | 'transmission_comptable';
export type EscaladeActionStatut = 'pending' | 'envoye' | 'echec' | 'transmis';

export interface RecouvrementActionRow {
  id: number;
  titre_id: number;
  niveau: EscaladeNiveau;
  action_type: EscaladeActionType;
  statut: EscaladeActionStatut;
  email_destinataire: string | null;
  piece_jointe_path: string | null;
  details: string | null;
  created_by: number | null;
  created_at: string;
}

export interface RunEscaladeImpayesResult {
  run_date: string;
  processed: number;
  sent: number;
  failed: number;
  generated_pdfs: number;
  transmitted: number;
  blocked: number;
}

type EscalatableTitre = {
  id: number;
  numero: string;
  assujetti_id: number;
  annee: number;
  montant: number;
  montant_paye: number;
  statut: string;
  date_echeance: string;
  raison_sociale: string;
  identifiant_tlpe: string;
  email: string | null;
  adresse_rue: string | null;
  adresse_cp: string | null;
  adresse_ville: string | null;
};

const RECOUVREMENT_DIR = path.resolve(__dirname, '..', 'data', 'recouvrement');
const MISES_EN_DEMEURE_IMPAYES_DIR = path.resolve(__dirname, '..', 'data', 'mises_en_demeure', 'impayes');
const PORTAL_BASE_URL = (process.env.TLPE_PORTAL_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');
const API_BASE_URL = (process.env.TLPE_API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');

function normalizeIsoDate(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (!m) throw new Error(`Date invalide: ${value}`);
  return m[1];
}

function diffDays(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86400000);
}

function determineEscaladeNiveau(dateEcheanceIso: string, runDateIso: string): EscaladeNiveau | null {
  const daysAfter = diffDays(dateEcheanceIso, runDateIso);
  if (daysAfter === 10) return 'J+10';
  if (daysAfter === 30) return 'J+30';
  if (daysAfter === 60) return 'J+60';
  return null;
}

function hasRecouvrementAction(titreId: number, niveau: EscaladeNiveau): boolean {
  const row = db
    .prepare('SELECT id FROM recouvrement_actions WHERE titre_id = ? AND niveau = ? LIMIT 1')
    .get(titreId, niveau) as { id: number } | undefined;
  return !!row;
}

function hasBlockingProcedure(titreId: number): boolean {
  const row = db
    .prepare(
      `SELECT id
       FROM contentieux
       WHERE titre_id = ?
         AND (
           type = 'contentieux'
           OR (
             type = 'moratoire'
            AND (
              lower(COALESCE(decision, '')) LIKE '%accorde%'
              OR lower(COALESCE(decision, '')) LIKE '%accordé%'
              OR statut IN ('ouvert', 'instruction')
            )
           )
         )
       LIMIT 1`,
    )
    .get(titreId) as { id: number } | undefined;
  return !!row;
}

function listTitresRecouvrables(runDateIso: string): EscalatableTitre[] {
  return db
    .prepare(
      `SELECT t.id, t.numero, t.assujetti_id, t.annee, t.montant, t.montant_paye, t.statut, t.date_echeance,
              a.raison_sociale, a.identifiant_tlpe, a.email, a.adresse_rue, a.adresse_cp, a.adresse_ville
       FROM titres t
       JOIN assujettis a ON a.id = t.assujetti_id
       WHERE ROUND(t.montant - COALESCE(t.montant_paye, 0), 2) > 0
         AND date(?) >= date(t.date_echeance)
         AND t.statut IN ('emis', 'paye_partiel', 'impaye', 'mise_en_demeure')
       ORDER BY date(t.date_echeance) ASC, t.id ASC`,
    )
    .all(runDateIso) as EscalatableTitre[];
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function buildPdf(lines: string[]): string {
  const escapePdf = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const escapedLines = lines.map(escapePdf);
  const textOps = escapedLines
    .map((line, i) => {
      if (i === 0) return `72 780 Td (${line}) Tj`;
      return `0 -18 Td (${line}) Tj`;
    })
    .join(' ');
  const contentStream = `BT /F1 11 Tf ${textOps} ET`;
  const contentLength = Buffer.byteLength(contentStream, 'utf8');

  const objects = [
    `1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n`,
    `2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n`,
    `3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>endobj\n`,
    `4 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n`,
    `5 0 obj<< /Length ${contentLength} >>stream\n${contentStream}\nendstream\nendobj\n`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += obj;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return pdf;
}

function generateMiseEnDemeurePdf(titre: EscalatableTitre, runDateIso: string): string {
  ensureDir(MISES_EN_DEMEURE_IMPAYES_DIR);
  const filename = `mise-en-demeure-${titre.numero}.pdf`;
  const absolutePath = path.join(MISES_EN_DEMEURE_IMPAYES_DIR, filename);
  const adresse = [titre.adresse_rue, [titre.adresse_cp, titre.adresse_ville].filter(Boolean).join(' ')].filter(Boolean).join(' - ');
  const pdf = buildPdf([
    'Mise en demeure - Recouvrement TLPE',
    `Date: ${runDateIso}`,
    `Titre: ${titre.numero}`,
    `Assujetti: ${titre.raison_sociale}`,
    `Identifiant TLPE: ${titre.identifiant_tlpe}`,
    `Montant restant du: ${(titre.montant - titre.montant_paye).toFixed(2)} EUR`,
    `Adresse: ${adresse || 'non renseignee'}`,
    `Portail: ${PORTAL_BASE_URL}/titres`,
    'Document genere automatiquement pour relance de recouvrement.',
  ]);
  fs.writeFileSync(absolutePath, pdf, 'utf8');
  return path.relative(path.resolve(__dirname, '..', 'data'), absolutePath).replace(/\\/g, '/');
}

function buildTransmissionDetails(titre: EscalatableTitre) {
  return {
    numero_titre: titre.numero,
    montant_restant: Number((titre.montant - titre.montant_paye).toFixed(2)),
    transmitted_at: new Date().toISOString(),
    channel: 'helios-ready',
    download_url: `${API_BASE_URL}/api/titres/${titre.id}/pdf`,
    commentaire: 'Titre executoire pret pour transmission au comptable public',
  };
}

function upsertTitreStatut(titreId: number, statut: 'impaye' | 'mise_en_demeure') {
  db.prepare('UPDATE titres SET statut = ? WHERE id = ?').run(statut, titreId);
}

export function listRecouvrementActionsByTitre(titreId: number): RecouvrementActionRow[] {
  return db
    .prepare(
      `SELECT id, titre_id, niveau, action_type, statut, email_destinataire, piece_jointe_path, details, created_by, created_at
       FROM recouvrement_actions
       WHERE titre_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(titreId) as RecouvrementActionRow[];
}

export function runEscaladeImpayes(input?: {
  runDateIso?: string;
  userId?: number | null;
  ip?: string | null;
}): RunEscaladeImpayesResult {
  const runDateIso = normalizeIsoDate(input?.runDateIso ?? new Date().toISOString());
  ensureDir(RECOUVREMENT_DIR);

  const titres = listTitresRecouvrables(runDateIso);
  let processed = 0;
  let sent = 0;
  let failed = 0;
  let generatedPdfs = 0;
  let transmitted = 0;
  let blocked = 0;

  const insertAction = db.prepare(
    `INSERT INTO recouvrement_actions (
      titre_id, niveau, action_type, statut, email_destinataire, piece_jointe_path, details, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    for (const titre of titres) {
      const niveau = determineEscaladeNiveau(titre.date_echeance, runDateIso);
      if (!niveau) continue;
      if (hasRecouvrementAction(titre.id, niveau)) continue;
      if (hasBlockingProcedure(titre.id)) {
        blocked += 1;
        continue;
      }

      processed += 1;

      if (niveau === 'J+10') {
        const hasEmail = Boolean(titre.email && titre.email.trim().length > 0);
        const statut: EscaladeActionStatut = hasEmail ? 'envoye' : 'echec';
        const details = {
          objet: `Rappel impaye TLPE ${titre.numero}`,
          portail_url: `${PORTAL_BASE_URL}/titres`,
          run_date: runDateIso,
        };
        insertAction.run(
          titre.id,
          niveau,
          'rappel_email',
          statut,
          hasEmail ? titre.email!.trim() : null,
          null,
          JSON.stringify(details),
          input?.userId ?? null,
        );
        upsertTitreStatut(titre.id, 'impaye');
        logAudit({
          userId: input?.userId ?? null,
          action: 'recouvrement-j10',
          entite: 'titre',
          entiteId: titre.id,
          details,
          ip: input?.ip ?? null,
        });
        if (statut === 'envoye') sent += 1;
        else failed += 1;
        continue;
      }

      if (niveau === 'J+30') {
        const pieceJointePath = generateMiseEnDemeurePdf(titre, runDateIso);
        generatedPdfs += 1;
        const hasEmail = Boolean(titre.email && titre.email.trim().length > 0);
        const statut: EscaladeActionStatut = hasEmail ? 'envoye' : 'echec';
        const details = {
          run_date: runDateIso,
          commentaire: 'Mise en demeure automatique J+30',
        };
        insertAction.run(
          titre.id,
          niveau,
          'mise_en_demeure',
          statut,
          hasEmail ? titre.email!.trim() : null,
          pieceJointePath,
          JSON.stringify(details),
          input?.userId ?? null,
        );
        upsertTitreStatut(titre.id, 'mise_en_demeure');
        logAudit({
          userId: input?.userId ?? null,
          action: 'recouvrement-j30',
          entite: 'titre',
          entiteId: titre.id,
          details: { ...details, piece_jointe_path: pieceJointePath },
          ip: input?.ip ?? null,
        });
        if (statut === 'envoye') sent += 1;
        else failed += 1;
        continue;
      }

      const details = buildTransmissionDetails(titre);
      insertAction.run(
        titre.id,
        niveau,
        'transmission_comptable',
        'transmis',
        null,
        null,
        JSON.stringify(details),
        input?.userId ?? null,
      );
      transmitted += 1;
      logAudit({
        userId: input?.userId ?? null,
        action: 'recouvrement-j60',
        entite: 'titre',
        entiteId: titre.id,
        details,
        ip: input?.ip ?? null,
      });
    }
  });

  tx();

  return {
    run_date: runDateIso,
    processed,
    sent,
    failed,
    generated_pdfs: generatedPdfs,
    transmitted,
    blocked,
  };
}
