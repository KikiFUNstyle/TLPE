import { db, logAudit } from './db';
import {
  classifyContentieuxAlertLevel,
  isContentieuxDeadlineActive,
  normalizeIsoDate,
  summarizeContentieuxDeadline,
  todayIsoDate,
} from './contentieuxDeadline';

export interface ContentieuxDeadlineAlertRow {
  id: number;
  contentieux_id: number;
  assujetti_id: number;
  numero: string;
  raison_sociale: string | null;
  statut: string;
  date_limite_reponse: string;
  date_limite_reponse_initiale: string | null;
  days_remaining: number;
  overdue: boolean;
  niveau_alerte: 'J-30' | 'J-7' | 'depasse';
  extended: boolean;
  delai_prolonge_justification: string | null;
  email_status: 'pending' | 'envoye' | 'echec';
  email_error: string | null;
  email_sent_at: string | null;
  created_at: string;
}

export interface CreateContentieuxDeadlineAlertsResult {
  run_date: string;
  total_candidates: number;
  created: number;
  emailed: number;
  skipped_existing: number;
  overdue: number;
}

type ContentieuxCandidate = {
  id: number;
  numero: string;
  assujetti_id: number;
  raison_sociale: string | null;
  email: string | null;
  statut: string;
  date_limite_reponse: string | null;
  date_limite_reponse_initiale: string | null;
  delai_prolonge_justification: string | null;
};

type ManagerAlertRecipient = {
  id: number;
  email: string;
  display_name: string;
};

function getManagerAlertRecipient(): ManagerAlertRecipient | null {
  const user = db
    .prepare(
      `SELECT id, email, trim(prenom || ' ' || nom) AS display_name
       FROM users
       WHERE actif = 1 AND role = 'gestionnaire'
       ORDER BY id ASC
       LIMIT 1`,
    )
    .get() as { id: number; email: string; display_name: string | null } | undefined;

  if (!user?.email?.trim()) return null;
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name?.trim() || user.email,
  };
}

function deliverAlertEmail(email: string | null): { status: 'pending' | 'envoye' | 'echec'; error: string | null; sentAt: string | null } {
  if (!email || email.trim() === '') {
    return { status: 'echec', error: 'Aucun email destinataire renseigné', sentAt: null };
  }

  const mode = process.env.TLPE_EMAIL_DELIVERY_MODE ?? 'mock-success';
  if (mode === 'mock-failure') {
    return { status: 'echec', error: "Echec d'envoi (mode mock-failure)", sentAt: null };
  }
  if (mode === 'disabled') {
    return { status: 'pending', error: 'Envoi différé: service SMTP non configuré', sentAt: null };
  }
  return { status: 'envoye', error: null, sentAt: new Date().toISOString() };
}

function buildAlertEmailSubject(numero: string, niveau: 'J-30' | 'J-7' | 'depasse') {
  if (niveau === 'depasse') return `Alerte contentieux ${numero} en dépassement de délai`;
  return `Alerte contentieux ${numero} - échéance ${niveau}`;
}

function buildAlertEmailBody(candidate: ContentieuxCandidate, niveau: 'J-30' | 'J-7' | 'depasse', daysRemaining: number) {
  const lines = [
    `Dossier: ${candidate.numero}`,
    `Assujetti: ${candidate.raison_sociale ?? 'Non renseigné'}`,
    `Statut: ${candidate.statut}`,
    `Date limite de réponse: ${candidate.date_limite_reponse}`,
  ];

  if (niveau === 'depasse') {
    lines.push(`Le dossier est en dépassement depuis ${Math.abs(daysRemaining)} jour(s).`);
  } else {
    lines.push(`Le dossier atteindra son échéance dans ${daysRemaining} jour(s) (${niveau}).`);
  }

  if (candidate.delai_prolonge_justification) {
    lines.push(`Justification de prolongation: ${candidate.delai_prolonge_justification}`);
  }

  return lines.join('\n');
}

export function createContentieuxDeadlineAlerts(input?: {
  runDateIso?: string;
  userId?: number | null;
  ip?: string | null;
}): CreateContentieuxDeadlineAlertsResult {
  const runDateIso = normalizeIsoDate(input?.runDateIso ?? todayIsoDate());
  const managerRecipient = getManagerAlertRecipient();
  const rows = db
    .prepare(
      `SELECT c.id, c.numero, c.assujetti_id, c.statut, c.date_limite_reponse,
              c.date_limite_reponse_initiale, c.delai_prolonge_justification,
              a.raison_sociale, a.email
       FROM contentieux c
       LEFT JOIN assujettis a ON a.id = c.assujetti_id
       WHERE c.date_limite_reponse IS NOT NULL
       ORDER BY c.date_limite_reponse ASC, c.id ASC`,
    )
    .all() as ContentieuxCandidate[];

  let totalCandidates = 0;
  let created = 0;
  let emailed = 0;
  let skippedExisting = 0;
  let overdue = 0;

  const insertNotification = db.prepare(
    `INSERT INTO notifications_email (
      campagne_id, assujetti_id, email_destinataire, objet, corps,
      template_code, relance_niveau, piece_jointe_path, magic_link, mode, statut, erreur, sent_at, created_by
    ) VALUES (?, ?, ?, ?, ?, 'alerte_contentieux', ?, NULL, NULL, 'auto', ?, ?, ?, ?)`,
  );

  const insertAlert = db.prepare(
    `INSERT INTO contentieux_alerts (
      contentieux_id, assujetti_id, niveau_alerte, date_reference, date_echeance,
      days_remaining, overdue, email_status, email_error, email_sent_at, email_notification_id, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    for (const row of rows) {
      if (!isContentieuxDeadlineActive(row.statut)) continue;
      const summary = summarizeContentieuxDeadline(
        {
          date_limite_reponse: row.date_limite_reponse,
          date_limite_reponse_initiale: row.date_limite_reponse_initiale,
          delai_prolonge_justification: row.delai_prolonge_justification,
        },
        runDateIso,
      );
      if (!summary.date_limite_reponse || summary.days_remaining === null || !summary.niveau_alerte) continue;

      totalCandidates += 1;
      const exists = db
        .prepare(
          `SELECT id
           FROM contentieux_alerts
           WHERE contentieux_id = ? AND niveau_alerte = ? AND date_echeance = ?
           LIMIT 1`,
        )
        .get(row.id, summary.niveau_alerte, summary.date_limite_reponse) as { id: number } | undefined;
      if (exists) {
        skippedExisting += 1;
        continue;
      }

      const emailTarget = managerRecipient?.email ?? row.email;
      const email = deliverAlertEmail(emailTarget);
      const emailSubject = buildAlertEmailSubject(row.numero, summary.niveau_alerte);
      const emailBody = buildAlertEmailBody(row, summary.niveau_alerte, summary.days_remaining);
      const notificationResult = insertNotification.run(
        null,
        row.assujetti_id,
        emailTarget ?? '',
        emailSubject,
        emailBody,
        summary.niveau_alerte,
        email.status,
        email.error,
        email.sentAt,
        input?.userId ?? null,
      );
      const notificationId = Number(notificationResult.lastInsertRowid);
      insertAlert.run(
        row.id,
        row.assujetti_id,
        summary.niveau_alerte,
        runDateIso,
        summary.date_limite_reponse,
        summary.days_remaining,
        summary.overdue ? 1 : 0,
        email.status,
        email.error,
        email.sentAt,
        notificationId,
        input?.userId ?? null,
      );

      logAudit({
        userId: input?.userId ?? null,
        action: 'contentieux-deadline-alert',
        entite: 'contentieux',
        entiteId: row.id,
        details: {
          niveau: summary.niveau_alerte,
          subject: buildAlertEmailSubject(row.numero, summary.niveau_alerte),
          body: buildAlertEmailBody(row, summary.niveau_alerte, summary.days_remaining),
          date_echeance: summary.date_limite_reponse,
          days_remaining: summary.days_remaining,
          email_status: email.status,
        },
        ip: input?.ip ?? null,
      });

      created += 1;
      if (email.status === 'envoye') emailed += 1;
      if (summary.overdue) overdue += 1;
    }
  });

  tx();

  return {
    run_date: runDateIso,
    total_candidates: totalCandidates,
    created,
    emailed,
    skipped_existing: skippedExisting,
    overdue,
  };
}

export function listContentieuxDeadlineAlerts(): ContentieuxDeadlineAlertRow[] {
  return db
    .prepare(
      `SELECT ca.id, ca.contentieux_id, ca.assujetti_id, c.numero, a.raison_sociale, c.statut,
              c.date_limite_reponse, c.date_limite_reponse_initiale, c.delai_prolonge_justification,
              ca.days_remaining, ca.overdue, ca.niveau_alerte,
              ca.email_status, ca.email_error, ca.email_sent_at, ca.created_at
       FROM contentieux_alerts ca
       JOIN contentieux c ON c.id = ca.contentieux_id
       LEFT JOIN assujettis a ON a.id = c.assujetti_id
       ORDER BY ca.created_at DESC, ca.id DESC`,
    )
    .all()
    .map((row) => ({
      ...(row as Omit<ContentieuxDeadlineAlertRow, 'overdue' | 'extended'> & { overdue: number }),
      overdue: Number((row as { overdue: number }).overdue) === 1,
      extended:
        (row as { date_limite_reponse_initiale: string | null; date_limite_reponse: string | null }).date_limite_reponse_initiale !== null &&
        (row as { date_limite_reponse_initiale: string | null; date_limite_reponse: string | null }).date_limite_reponse_initiale !==
          (row as { date_limite_reponse: string | null }).date_limite_reponse,
    }));
}

export function getCurrentContentieuxAlertSummary(runDateIso = todayIsoDate()) {
  const rows = db
    .prepare(
      `SELECT c.id, c.numero, c.assujetti_id, c.statut, c.date_limite_reponse,
              c.date_limite_reponse_initiale, c.delai_prolonge_justification,
              a.raison_sociale
       FROM contentieux c
       LEFT JOIN assujettis a ON a.id = c.assujetti_id
       WHERE c.date_limite_reponse IS NOT NULL
       ORDER BY c.date_limite_reponse ASC, c.id ASC`,
    )
    .all() as Array<ContentieuxCandidate>;

  return rows
    .filter((row) => isContentieuxDeadlineActive(row.statut))
    .map((row) => {
      const summary = summarizeContentieuxDeadline(
        {
          date_limite_reponse: row.date_limite_reponse,
          date_limite_reponse_initiale: row.date_limite_reponse_initiale,
          delai_prolonge_justification: row.delai_prolonge_justification,
        },
        runDateIso,
      );
      return {
        contentieux_id: row.id,
        numero: row.numero,
        raison_sociale: row.raison_sociale,
        statut: row.statut,
        ...summary,
      };
    })
    .filter((row) => row.date_limite_reponse !== null && row.days_remaining !== null && row.days_remaining <= 30)
    .sort((left, right) => (left.days_remaining ?? 0) - (right.days_remaining ?? 0));
}

export function hasContentieuxAlertFor(contentieuxId: number, niveau: 'J-30' | 'J-7' | 'depasse', dateEcheance: string) {
  const level = classifyContentieuxAlertLevel(niveau === 'depasse' ? -1 : niveau === 'J-7' ? 7 : 30);
  if (!level) return false;
  return Boolean(
    db
      .prepare(
        `SELECT id
         FROM contentieux_alerts
         WHERE contentieux_id = ? AND niveau_alerte = ? AND date_echeance = ?
         LIMIT 1`,
      )
      .get(contentieuxId, level, dateEcheance),
  );
}
