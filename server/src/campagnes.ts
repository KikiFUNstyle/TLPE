import * as fs from 'node:fs';
import * as path from 'node:path';
import { db, logAudit } from './db';
import { sendInvitationsForCampagne } from './invitations';

export type CampagneStatut = 'brouillon' | 'ouverte' | 'cloturee';

export interface CampagneInput {
  annee: number;
  date_ouverture: string;
  date_limite_declaration: string;
  date_cloture: string;
  relance_j7_courrier?: boolean;
  created_by: number;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertIsoDate(value: string, field: string) {
  if (!ISO_DATE_RE.test(value)) {
    throw new Error(`${field} invalide (format YYYY-MM-DD attendu)`);
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const isValid =
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;

  if (!isValid) {
    throw new Error(`${field} invalide (date calendrier invalide)`);
  }
}

function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + days);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function normalizeEmailBody(lines: string[]): string {
  return lines.join('\n');
}

function ensureMisesEnDemeureDir(campagneId: number): string {
  const dataDir = path.resolve(__dirname, '..', 'data');
  const dir = path.join(dataDir, 'mises_en_demeure', String(campagneId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function generateMiseEnDemeurePdf(input: {
  campagneId: number;
  annee: number;
  runDateIso: string;
  assujetti: {
    id: number;
    identifiant_tlpe: string;
    raison_sociale: string;
    adresse_rue: string | null;
    adresse_cp: string | null;
    adresse_ville: string | null;
  };
  dispositifsN1: Array<{ identifiant: string; surface: number; nombre_faces: number }>;
}): string {
  const dir = ensureMisesEnDemeureDir(input.campagneId);
  const filename = `mise-en-demeure-${input.annee}-${input.assujetti.id}.pdf`;
  const absolutePath = path.join(dir, filename);

  const escapePdf = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const adresse = [input.assujetti.adresse_rue, input.assujetti.adresse_cp, input.assujetti.adresse_ville]
    .filter((part) => !!part && String(part).trim().length > 0)
    .join(' ');

  const lines = [
    'Mise en demeure - Declaration TLPE',
    `Date: ${input.runDateIso}`,
    `Campagne: ${input.annee}`,
    `Destinataire: ${input.assujetti.raison_sociale}`,
    `Identifiant TLPE: ${input.assujetti.identifiant_tlpe}`,
    `Adresse: ${adresse || 'non renseignee'}`,
    `Dispositifs N-1: ${input.dispositifsN1.length}`,
  ];

  for (const dsp of input.dispositifsN1.slice(0, 8)) {
    lines.push(`- ${dsp.identifiant} / ${dsp.surface}m2 / ${dsp.nombre_faces} face(s)`);
  }

  if (input.dispositifsN1.length > 8) {
    lines.push(`... ${input.dispositifsN1.length - 8} dispositif(s) supplementaire(s)`);
  }

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

  fs.writeFileSync(absolutePath, pdf, 'utf8');
  return path.relative(path.resolve(__dirname, '..', 'data'), absolutePath).replace(/\\/g, '/');
}

function runMiseEnDemeureJPlus1(campagneId: number, userId: number, ip?: string | null) {
  const campagne = db
    .prepare('SELECT id, annee, date_cloture FROM campagnes WHERE id = ?')
    .get(campagneId) as { id: number; annee: number; date_cloture: string } | undefined;

  if (!campagne) {
    throw new Error('Campagne introuvable');
  }

  const runDateIso = addDays(campagne.date_cloture, 1);
  const targetStatut = 'en_instruction';

  const assujettis = db
    .prepare(
      `SELECT a.id, a.identifiant_tlpe, a.raison_sociale, a.email, a.adresse_rue, a.adresse_cp, a.adresse_ville
       FROM assujettis a
       WHERE a.statut = 'actif'
         AND NOT EXISTS (
           SELECT 1
           FROM declarations d
           WHERE d.assujetti_id = a.id
             AND d.annee = ?
             AND d.statut IN ('soumise', 'validee', 'rejetee')
         )
       ORDER BY a.id`,
    )
    .all(campagne.annee) as Array<{
    id: number;
    identifiant_tlpe: string;
    raison_sociale: string;
    email: string | null;
    adresse_rue: string | null;
    adresse_cp: string | null;
    adresse_ville: string | null;
  }>;

  const upsertDeclaration = db.prepare(
    `INSERT INTO declarations (numero, assujetti_id, annee, statut, commentaires, alerte_gestionnaire)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(assujetti_id, annee) DO UPDATE SET
       statut = excluded.statut,
       commentaires = COALESCE(declarations.commentaires, excluded.commentaires),
       alerte_gestionnaire = 1,
       updated_at = datetime('now')`,
  );
  const selectDeclaration = db.prepare(
    `SELECT id, numero
     FROM declarations
     WHERE assujetti_id = ? AND annee = ?
     LIMIT 1`,
  );

  const insertMise = db.prepare(
    `INSERT INTO mises_en_demeure (campagne_id, declaration_id, statut)
     VALUES (?, ?, 'a_traiter')
     ON CONFLICT(declaration_id) DO NOTHING`,
  );

  const updateMiseEnvoyee = db.prepare(
    `UPDATE mises_en_demeure
     SET statut = 'envoyee'
     WHERE campagne_id = ? AND declaration_id = ?`,
  );


  const tx = db.transaction(() => {
    let createdDeclarations = 0;
    let generatedPdfs = 0;
    let notifications = 0;

    for (const assujetti of assujettis) {
      const numero = `DEC-OFF-${campagne.annee}-${String(assujetti.id).padStart(6, '0')}`;
      const commentaire = `Declaration d'office auto-generee suite cloture campagne ${campagne.annee} (US3.5)`;

      const existing = db
        .prepare('SELECT id FROM declarations WHERE assujetti_id = ? AND annee = ?')
        .get(assujetti.id, campagne.annee) as { id: number } | undefined;

      upsertDeclaration.run(numero, assujetti.id, campagne.annee, targetStatut, commentaire);
      if (!existing) {
        createdDeclarations += 1;
      }

      const decl = selectDeclaration.get(assujetti.id, campagne.annee) as { id: number; numero: string } | undefined;
      if (!decl) {
        continue;
      }

      insertMise.run(campagne.id, decl.id);

      const dispositifsN1 = db
        .prepare(
          `SELECT DISTINCT d.identifiant, l.surface_declaree AS surface, l.nombre_faces
           FROM declarations dec
           JOIN lignes_declaration l ON l.declaration_id = dec.id
           JOIN dispositifs d ON d.id = l.dispositif_id
           WHERE dec.assujetti_id = ?
             AND dec.annee = ?
             AND dec.statut IN ('soumise', 'validee', 'en_instruction')
           ORDER BY d.identifiant`,
        )
        .all(assujetti.id, campagne.annee - 1) as Array<{ identifiant: string; surface: number; nombre_faces: number }>;

      const fallbackDispositifs =
        dispositifsN1.length > 0
          ? dispositifsN1
          : (db
              .prepare(
                `SELECT identifiant, surface, nombre_faces
                 FROM dispositifs
                 WHERE assujetti_id = ?
                 ORDER BY id`,
              )
              .all(assujetti.id) as Array<{ identifiant: string; surface: number; nombre_faces: number }>);

      const pdfRelativePath = generateMiseEnDemeurePdf({
        campagneId: campagne.id,
        annee: campagne.annee,
        runDateIso,
        assujetti,
        dispositifsN1: fallbackDispositifs,
      });
      generatedPdfs += 1;

      const objet = `Mise en demeure TLPE ${campagne.annee} - declaration manquante`;
      const corps = normalizeEmailBody([
        `Bonjour ${assujetti.raison_sociale},`,
        '',
        `Votre declaration TLPE ${campagne.annee} n'a pas ete recue a la cloture de la campagne.`,
        'Une declaration d\'office a ete ouverte au statut en_instruction.',
        'Veuillez consulter la mise en demeure jointe et prendre contact avec le service TLPE.',
        '',
        `Reference declaration: ${decl.numero}`,
        `Date d'emission: ${runDateIso}`,
        '',
        'Cordialement,',
        'Service TLPE',
      ]);

      const emailDestinataire = assujetti.email && assujetti.email.trim().length > 0 ? assujetti.email.trim() : 'invalide@tlpe.local';
      const hasEmail = assujetti.email && assujetti.email.trim().length > 0;
      const statutNotif = hasEmail ? 'envoye' : 'echec';
      const erreurNotif = hasEmail ? null : 'Email manquant pour envoi de la mise en demeure';

      db.prepare(
        `INSERT INTO notifications_email (
          campagne_id, assujetti_id, email_destinataire, objet, corps,
          template_code, relance_niveau, piece_jointe_path, magic_link, mode, statut, erreur, sent_at, created_by
        ) VALUES (?, ?, ?, ?, ?, 'mise_en_demeure_auto', NULL, ?, NULL, 'auto', ?, ?, ?, ?)`,
      ).run(
        campagne.id,
        assujetti.id,
        emailDestinataire,
        objet,
        corps,
        pdfRelativePath,
        statutNotif,
        erreurNotif,
        hasEmail ? new Date().toISOString() : null,
        userId,
      );
      notifications += 1;

      if (hasEmail) {
        updateMiseEnvoyee.run(campagne.id, decl.id);
      }

      logAudit({
        userId,
        action: 'mise-en-demeure-j1',
        entite: 'campagne',
        entiteId: campagne.id,
        details: {
          assujetti_id: assujetti.id,
          declaration_id: decl.id,
          declaration_numero: decl.numero,
          run_date: runDateIso,
          piece_jointe_path: pdfRelativePath,
          dispositifs_n1_count: fallbackDispositifs.length,
          historique_source: dispositifsN1.length > 0 ? 'declaration_n_1' : 'fallback_dispositifs',
          auto_declaration_statut: targetStatut,
          notification_statut: statutNotif,
        },
        ip: ip ?? null,
      });
    }

    return {
      run_date: runDateIso,
      eligibles: assujettis.length,
      declarations_office_creees: createdDeclarations,
      notifications_envoyees: notifications,
      pdf_generes: generatedPdfs,
      statut_declaration: targetStatut,
    };
  });

  return tx();
}

function validateTimeline(input: Omit<CampagneInput, 'created_by'>) {
  assertIsoDate(input.date_ouverture, 'date_ouverture');
  assertIsoDate(input.date_limite_declaration, 'date_limite_declaration');
  assertIsoDate(input.date_cloture, 'date_cloture');

  if (input.date_limite_declaration < input.date_ouverture) {
    throw new Error('date_limite_declaration doit etre >= date_ouverture');
  }
  if (input.date_cloture < input.date_limite_declaration) {
    throw new Error('date_cloture doit etre >= date_limite_declaration');
  }
}

export function listCampagnes() {
  return db
    .prepare(
      `SELECT c.*, u.email AS created_by_email
       FROM campagnes c
       LEFT JOIN users u ON u.id = c.created_by
       ORDER BY c.annee DESC`,
    )
    .all();
}

export function getCampagneActive() {
  return db
    .prepare(
      `SELECT c.*, u.email AS created_by_email
       FROM campagnes c
       LEFT JOIN users u ON u.id = c.created_by
       WHERE c.statut = 'ouverte'
       ORDER BY c.annee DESC
       LIMIT 1`,
    )
    .get();
}

export function createCampagne(input: CampagneInput) {
  validateTimeline(input);

  const existing = db.prepare('SELECT id FROM campagnes WHERE annee = ?').get(input.annee) as { id: number } | undefined;
  if (existing) {
    throw new Error(`Une campagne existe deja pour l'annee ${input.annee}`);
  }

  const info = db
    .prepare(
      `INSERT INTO campagnes (annee, date_ouverture, date_limite_declaration, date_cloture, statut, relance_j7_courrier, created_by)
       VALUES (?, ?, ?, ?, 'brouillon', ?, ?)`,
    )
    .run(
      input.annee,
      input.date_ouverture,
      input.date_limite_declaration,
      input.date_cloture,
      input.relance_j7_courrier ? 1 : 0,
      input.created_by,
    );

  const campagneId = Number(info.lastInsertRowid);
  logAudit({
    userId: input.created_by,
    action: 'create',
    entite: 'campagne',
    entiteId: campagneId,
    details: {
      annee: input.annee,
      date_ouverture: input.date_ouverture,
      date_limite_declaration: input.date_limite_declaration,
      date_cloture: input.date_cloture,
      relance_j7_courrier: input.relance_j7_courrier ? 1 : 0,
    },
  });

  return campagneId;
}

export function openCampagne(campagneId: number, userId: number, ip?: string | null) {
  const tx = db.transaction(() => {
    const campagne = db.prepare('SELECT * FROM campagnes WHERE id = ?').get(campagneId) as
      | { id: number; annee: number; statut: CampagneStatut }
      | undefined;
    if (!campagne) throw new Error('Campagne introuvable');
    if (campagne.statut === 'ouverte') throw new Error('La campagne est deja ouverte');
    if (campagne.statut === 'cloturee') throw new Error('Une campagne cloturee ne peut pas etre reouverte');

    db.prepare("UPDATE campagnes SET statut = 'brouillon', updated_at = datetime('now') WHERE statut = 'ouverte' AND id != ?").run(campagneId);

    db.prepare("UPDATE campagnes SET statut = 'ouverte', updated_at = datetime('now') WHERE id = ?").run(campagneId);

    const pendingInvitations = (
      db
        .prepare(
          `SELECT COUNT(*) AS c
           FROM campagne_jobs
           WHERE campagne_id = ? AND type = 'invitation' AND statut = 'pending'`,
        )
        .get(campagneId) as { c: number }
    ).c;

    if (pendingInvitations === 0) {
      db.prepare(
        `INSERT INTO campagne_jobs (campagne_id, type, statut, payload)
         VALUES (?, 'invitation', 'pending', ?)`,
      ).run(campagneId, JSON.stringify({ annee: campagne.annee }));
    }

    const invitations = sendInvitationsForCampagne({
      campagneId,
      userId,
      mode: 'auto',
      ip: ip ?? null,
    });

    db.prepare(
      `UPDATE campagne_jobs
       SET statut = 'done', started_at = datetime('now'), completed_at = datetime('now'),
           payload = json_set(
             json_set(
               json_set(COALESCE(payload, '{}'), '$.invitations_preparees', ?),
               '$.invitations_failed', ?
             ),
             '$.invitations_skipped', ?
           )
       WHERE campagne_id = ? AND type = 'invitation' AND statut = 'pending'`,
    ).run(invitations.prepared, invitations.failed, invitations.skipped, campagneId);

    logAudit({
      userId,
      action: 'open',
      entite: 'campagne',
      entiteId: campagneId,
      details: {
        annee: campagne.annee,
        invitations_preparees: invitations.prepared,
        invitations_failed: invitations.failed,
        invitations_skipped: invitations.skipped,
      },
      ip: ip ?? null,
    });

    return { annee: campagne.annee, invitations_preparees: invitations.prepared };
  });

  return tx();
}

export function closeCampagne(campagneId: number, userId: number, ip?: string | null) {
  const tx = db.transaction(() => {
    const campagne = db.prepare('SELECT * FROM campagnes WHERE id = ?').get(campagneId) as
      | { id: number; annee: number; statut: CampagneStatut; date_limite_declaration: string }
      | undefined;
    if (!campagne) throw new Error('Campagne introuvable');
    if (campagne.statut !== 'ouverte') throw new Error('Seule une campagne ouverte peut etre cloturee');

    const misesEnDemeure = runMiseEnDemeureJPlus1(campagneId, userId, ip ?? null);

    db.prepare("UPDATE campagnes SET statut = 'cloturee', updated_at = datetime('now') WHERE id = ?").run(campagneId);

    db.prepare(
      `INSERT INTO campagne_jobs (campagne_id, type, statut, payload, started_at, completed_at)
       VALUES (?, 'cloture', 'done', ?, datetime('now'), datetime('now'))`,
    ).run(
      campagneId,
      JSON.stringify({
        run_date: misesEnDemeure.run_date,
        eligibles: misesEnDemeure.eligibles,
        declarations_office_creees: misesEnDemeure.declarations_office_creees,
        notifications_envoyees: misesEnDemeure.notifications_envoyees,
        pdf_generes: misesEnDemeure.pdf_generes,
      }),
    );

    logAudit({
      userId,
      action: 'close',
      entite: 'campagne',
      entiteId: campagneId,
      details: {
        annee: campagne.annee,
        run_date: misesEnDemeure.run_date,
        declarations_office_creees: misesEnDemeure.declarations_office_creees,
        notifications_envoyees: misesEnDemeure.notifications_envoyees,
        pdf_generes: misesEnDemeure.pdf_generes,
      },
      ip: ip ?? null,
    });

    return {
      annee: campagne.annee,
      mises_en_demeure_j1: {
        run_date: misesEnDemeure.run_date,
        eligibles: misesEnDemeure.eligibles,
        declarations_office_creees: misesEnDemeure.declarations_office_creees,
        notifications_envoyees: misesEnDemeure.notifications_envoyees,
        pdf_generes: misesEnDemeure.pdf_generes,
      },
    };
  });

  return tx();
}
