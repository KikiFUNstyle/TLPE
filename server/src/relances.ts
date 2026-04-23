import * as fs from 'node:fs';
import * as path from 'node:path';
import { db, logAudit } from './db';

export type RelanceNiveau = 'J-30' | 'J-15' | 'J-7';

interface ActiveCampagne {
  id: number;
  annee: number;
  date_limite_declaration: string;
  relance_j7_courrier: number;
}

interface AssujettiRelancable {
  id: number;
  identifiant_tlpe: string;
  raison_sociale: string;
  email: string;
}

export interface RunRelancesResult {
  campagne_id: number;
  annee: number;
  niveau: RelanceNiveau | null;
  total_eligibles: number;
  sent: number;
  failed: number;
  skipped: number;
  generated_pdfs: number;
}

const PORTAL_BASE_URL = (process.env.TLPE_PORTAL_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');
const RELANCES_DIR = path.resolve(__dirname, '..', 'data', 'courriers_relance');

function normalizeIsoDate(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (!m) throw new Error(`Date invalide: ${value}`);
  return m[1];
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function diffDays(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86400000);
}

export function relanceNiveauFromDate(dateLimiteIso: string, runDateIso: string): RelanceNiveau | null {
  const days = diffDays(runDateIso, dateLimiteIso);
  if (days === 30) return 'J-30';
  if (days === 15) return 'J-15';
  if (days === 7) return 'J-7';
  return null;
}

function getActiveCampagne(runDateIso: string): ActiveCampagne | null {
  const row = db
    .prepare(
      `SELECT id, annee, date_limite_declaration, relance_j7_courrier
       FROM campagnes
       WHERE statut = 'ouverte'
         AND date(?) BETWEEN date(date_ouverture) AND date(date_cloture)
       ORDER BY annee DESC
       LIMIT 1`,
    )
    .get(runDateIso) as ActiveCampagne | undefined;
  return row ?? null;
}

function listAssujettisSansDeclaration(campagne: ActiveCampagne): AssujettiRelancable[] {
  return db
    .prepare(
      `SELECT a.id, a.identifiant_tlpe, a.raison_sociale, a.email
       FROM assujettis a
       WHERE a.statut = 'actif'
         AND a.email IS NOT NULL
         AND trim(a.email) != ''
         AND NOT EXISTS (
           SELECT 1
           FROM declarations d
           WHERE d.assujetti_id = a.id
             AND d.annee = ?
             AND d.statut IN ('soumise', 'validee')
         )
       ORDER BY a.id`,
    )
    .all(campagne.annee) as AssujettiRelancable[];
}

function hasNotificationAlreadySent(campagneId: number, assujettiId: number, niveau: RelanceNiveau): boolean {
  const row = db
    .prepare(
      `SELECT id
       FROM notifications_email
       WHERE campagne_id = ?
         AND assujetti_id = ?
         AND relance_niveau = ?
       LIMIT 1`,
    )
    .get(campagneId, assujettiId, niveau) as { id: number } | undefined;
  return !!row;
}

function buildObjet(annee: number, niveau: RelanceNiveau): string {
  return `Relance declaration TLPE ${annee} (${niveau})`;
}

function buildCorps(campagne: ActiveCampagne, assujetti: AssujettiRelancable, niveau: RelanceNiveau): string {
  const lines: string[] = [
    `Bonjour ${assujetti.raison_sociale},`,
    '',
    `Nous vous rappelons que votre declaration TLPE ${campagne.annee} doit etre soumise avant le ${campagne.date_limite_declaration}.`,
  ];

  if (niveau === 'J-15') {
    lines.push(`Acces direct au formulaire: ${PORTAL_BASE_URL}/declarations`);
  } else {
    lines.push(`Acces au portail: ${PORTAL_BASE_URL}/login`);
  }

  if (niveau === 'J-7') {
    lines.push('A 7 jours de la date limite, cette relance est prioritaire.');
  }

  lines.push('', 'Cordialement,', 'Service TLPE');
  return lines.join('\n');
}

function ensureRelancesDir(campagneId: number): string {
  const dir = path.join(RELANCES_DIR, String(campagneId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function generateJ7CourrierPdf(campagne: ActiveCampagne, assujetti: AssujettiRelancable, runDateIso: string): string {
  const dir = ensureRelancesDir(campagne.id);
  const filename = `relance-j7-${campagne.annee}-${assujetti.id}.pdf`;
  const absolutePath = path.join(dir, filename);

  const escapePdf = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const lines = [
    'Relance declaration TLPE',
    `Date: ${runDateIso}`,
    `Campagne: ${campagne.annee}`,
    `Date limite: ${campagne.date_limite_declaration}`,
    `Destinataire: ${assujetti.raison_sociale}`,
    `Identifiant TLPE: ${assujetti.identifiant_tlpe}`,
    `Portail: ${PORTAL_BASE_URL}/login`,
  ].map(escapePdf);

  const textOps = lines.map((line, i) => `${72} ${780 - i * 20} Td (${line}) Tj`).join(' ');
  const contentStream = `BT /F1 12 Tf ${textOps} ET`;
  const contentLength = Buffer.byteLength(contentStream, 'utf8');

  const pdf = `%PDF-1.4\n`
    + `1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n`
    + `2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n`
    + `3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>endobj\n`
    + `4 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n`
    + `5 0 obj<< /Length ${contentLength} >>stream\n${contentStream}\nendstream endobj\n`
    + `xref\n0 6\n0000000000 65535 f \n`
    + `0000000010 00000 n \n0000000060 00000 n \n0000000117 00000 n \n0000000244 00000 n \n0000000314 00000 n \n`
    + `trailer<< /Size 6 /Root 1 0 R >>\nstartxref\n${314 + contentLength + 33}\n%%EOF\n`;

  fs.writeFileSync(absolutePath, pdf, 'utf8');
  return path.relative(path.resolve(__dirname, '..', 'data'), absolutePath).replace(/\\/g, '/');
}

function deliverRelanceEmail(): { statut: 'envoye' | 'pending' | 'echec'; erreur: string | null } {
  const mode = process.env.TLPE_EMAIL_DELIVERY_MODE ?? 'disabled';
  if (mode === 'mock-success') return { statut: 'envoye', erreur: null };
  if (mode === 'mock-failure') return { statut: 'echec', erreur: "Echec d'envoi (mode mock-failure)" };
  return { statut: 'pending', erreur: 'Envoi differe: service SMTP non configure' };
}

export function runRelancesDeclarations(input?: { runDateIso?: string; userId?: number | null; ip?: string | null }): RunRelancesResult {
  const runDateIso = normalizeIsoDate(input?.runDateIso ?? new Date().toISOString());
  const campagne = getActiveCampagne(runDateIso);

  if (!campagne) {
    return {
      campagne_id: 0,
      annee: 0,
      niveau: null,
      total_eligibles: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      generated_pdfs: 0,
    };
  }

  const niveau = relanceNiveauFromDate(campagne.date_limite_declaration, runDateIso);
  if (!niveau) {
    return {
      campagne_id: campagne.id,
      annee: campagne.annee,
      niveau: null,
      total_eligibles: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      generated_pdfs: 0,
    };
  }

  const assujettis = listAssujettisSansDeclaration(campagne);

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let generatedPdfs = 0;

  const insertNotif = db.prepare(
    `INSERT INTO notifications_email (
      campagne_id, assujetti_id, email_destinataire, objet, corps,
      template_code, relance_niveau, piece_jointe_path, magic_link, mode, statut, erreur, sent_at, created_by
    ) VALUES (?, ?, ?, ?, ?, 'relance_declaration', ?, ?, NULL, 'auto', ?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    for (const assujetti of assujettis) {
      if (hasNotificationAlreadySent(campagne.id, assujetti.id, niveau)) {
        skipped += 1;
        continue;
      }

      const delivery = deliverRelanceEmail();
      let pieceJointePath: string | null = null;
      if (niveau === 'J-7' && campagne.relance_j7_courrier === 1) {
        pieceJointePath = generateJ7CourrierPdf(campagne, assujetti, runDateIso);
        generatedPdfs += 1;
      }

      const corps = buildCorps(campagne, assujetti, niveau);
      insertNotif.run(
        campagne.id,
        assujetti.id,
        assujetti.email,
        buildObjet(campagne.annee, niveau),
        corps,
        niveau,
        pieceJointePath,
        delivery.statut,
        delivery.erreur,
        delivery.statut === 'envoye' ? new Date().toISOString() : null,
        input?.userId ?? null,
      );

      logAudit({
        userId: input?.userId ?? null,
        action: 'send-relance',
        entite: 'campagne',
        entiteId: campagne.id,
        details: {
          niveau,
          assujetti_id: assujetti.id,
          statut: delivery.statut,
          piece_jointe_path: pieceJointePath,
          run_date: runDateIso,
        },
        ip: input?.ip ?? null,
      });

      if (delivery.statut === 'envoye') sent += 1;
      else if (delivery.statut === 'echec') failed += 1;
    }

    db.prepare(
      `INSERT INTO campagne_jobs (campagne_id, type, statut, payload, started_at, completed_at)
       VALUES (?, 'relance', 'done', ?, datetime('now'), datetime('now'))`,
    ).run(
      campagne.id,
      JSON.stringify({
        niveau,
        run_date: runDateIso,
        total_eligibles: assujettis.length,
        sent,
        failed,
        skipped,
        generated_pdfs: generatedPdfs,
      }),
    );
  });

  tx();

  return {
    campagne_id: campagne.id,
    annee: campagne.annee,
    niveau,
    total_eligibles: assujettis.length,
    sent,
    failed,
    skipped,
    generated_pdfs: generatedPdfs,
  };
}

export function computeRunDateForNiveau(dateLimiteIso: string, niveau: RelanceNiveau): string {
  if (niveau === 'J-30') return addDays(dateLimiteIso, -30);
  if (niveau === 'J-15') return addDays(dateLimiteIso, -15);
  return addDays(dateLimiteIso, -7);
}
