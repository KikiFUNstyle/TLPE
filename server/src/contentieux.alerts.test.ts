import test from 'node:test';
import assert from 'node:assert/strict';
import { db, initSchema } from './db';
import { createContentieuxDeadlineAlerts, listContentieuxDeadlineAlerts } from './contentieuxAlerts';
import { getDashboardMetrics } from './dashboardMetrics';

function resetTables() {
  initSchema();
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('DELETE FROM contentieux_alerts');
    db.exec('DELETE FROM notifications_email');
    db.exec('DELETE FROM invitation_magic_links');
    db.exec('DELETE FROM campagne_jobs');
    db.exec('DELETE FROM mises_en_demeure');
    db.exec('DELETE FROM evenements_contentieux');
    db.exec('DELETE FROM contentieux');
    db.exec('DELETE FROM audit_log');
    db.exec('DELETE FROM pieces_jointes');
    db.exec('DELETE FROM paiements');
    db.exec('DELETE FROM titres');
    db.exec('DELETE FROM declarations');
    db.exec('DELETE FROM dispositifs');
    db.exec('DELETE FROM campagnes');
    db.exec('DELETE FROM users');
    db.exec('DELETE FROM assujettis');
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function seedUser(email: string, role: 'admin' | 'gestionnaire' | 'financier') {
  return Number(
    db
      .prepare(
        `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
         VALUES (?, 'hash', 'Nom', 'Prenom', ?, 1)`,
      )
      .run(email, role).lastInsertRowid,
  );
}

function seedAssujetti(code: string, email = `${code.toLowerCase()}@example.test`) {
  return Number(
    db
      .prepare(
        `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, statut)
         VALUES (?, ?, ?, 'actif')`,
      )
      .run(code, `Assujetti ${code}`, email).lastInsertRowid,
  );
}

test.afterEach(() => {
  resetTables();
});

test('resetTables purge aussi contentieux_alerts pour eviter les alertes orphelines entre tests', () => {
  resetTables();
  const gestionnaireId = seedUser('gest-reset@example.test', 'gestionnaire');
  const assujettiId = seedAssujetti('TLPE-CTX-RESET');

  const contentieuxId = Number(
    db
      .prepare(
        `INSERT INTO contentieux (
          numero, assujetti_id, type, montant_litige, description,
          date_ouverture, date_limite_reponse, statut
        ) VALUES ('CTX-RESET-1', ?, 'contentieux', 1200, 'Recours reset', '2026-01-15', '2026-07-15', 'ouvert')`,
      )
      .run(assujettiId).lastInsertRowid,
  );

  db.prepare(
    `INSERT INTO contentieux_alerts (
      contentieux_id, assujetti_id, niveau_alerte, date_reference, date_echeance,
      days_remaining, overdue, email_status, created_by
    ) VALUES (?, ?, 'J-30', '2026-06-15', '2026-07-15', 30, 0, 'envoye', ?)`,
  ).run(contentieuxId, assujettiId, gestionnaireId);

  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM contentieux_alerts').get() as { c: number }).c, 1);

  resetTables();

  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM contentieux_alerts').get() as { c: number }).c, 0);
});

test('createContentieuxDeadlineAlerts génère les alertes J-30/J-7, journalise l’email et ignore les doublons', () => {
  resetTables();
  const gestionnaireId = seedUser('gest-contentieux@example.test', 'gestionnaire');
  const assujettiId = seedAssujetti('TLPE-CTX-ALERT');

  const contentieuxId = Number(
    db
      .prepare(
        `INSERT INTO contentieux (
          numero, assujetti_id, type, montant_litige, description,
          date_ouverture, date_limite_reponse, statut
        ) VALUES ('CTX-ALERT-1', ?, 'contentieux', 1200, 'Recours principal', '2026-01-15', '2026-07-15', 'ouvert')`,
      )
      .run(assujettiId).lastInsertRowid,
  );

  const firstRun = createContentieuxDeadlineAlerts({ runDateIso: '2026-06-15', userId: gestionnaireId, ip: '127.0.0.1' });
  assert.equal(firstRun.total_candidates, 1);
  assert.equal(firstRun.created, 1);
  assert.equal(firstRun.emailed, 1);

  let alerts = listContentieuxDeadlineAlerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].days_remaining, 30);
  assert.equal(alerts[0].niveau_alerte, 'J-30');
  assert.equal(alerts[0].email_status, 'envoye');
  assert.equal(alerts[0].overdue, false);

  const duplicateRun = createContentieuxDeadlineAlerts({ runDateIso: '2026-06-15', userId: gestionnaireId });
  assert.equal(duplicateRun.created, 0);
  assert.equal(duplicateRun.skipped_existing, 1);

  const j7Run = createContentieuxDeadlineAlerts({ runDateIso: '2026-07-08', userId: gestionnaireId });
  assert.equal(j7Run.created, 1);
  assert.equal(j7Run.emailed, 1);

  alerts = listContentieuxDeadlineAlerts();
  assert.equal(alerts.length, 2);
  assert.deepEqual(
    alerts.map((alert) => alert.niveau_alerte),
    ['J-7', 'J-30'],
  );

  const notifRows = db
    .prepare(
      `SELECT email_destinataire, template_code, relance_niveau, statut
       FROM notifications_email
       WHERE assujetti_id = ?
       ORDER BY id`,
    )
    .all(assujettiId) as Array<{
      email_destinataire: string;
      template_code: string;
      relance_niveau: string | null;
      statut: string;
    }>;
  assert.deepEqual(notifRows, [
    {
      email_destinataire: 'gest-contentieux@example.test',
      template_code: 'alerte_contentieux',
      relance_niveau: 'J-30',
      statut: 'envoye',
    },
    {
      email_destinataire: 'gest-contentieux@example.test',
      template_code: 'alerte_contentieux',
      relance_niveau: 'J-7',
      statut: 'envoye',
    },
  ]);

  const auditCount = (db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'contentieux-deadline-alert'").get() as { c: number }).c;
  assert.equal(auditCount, 2);
  assert.ok(contentieuxId > 0);
});

test('createContentieuxDeadlineAlerts signale les dossiers en dépassement et getDashboardMetrics les expose', () => {
  resetTables();
  const gestionnaireId = seedUser('gest-overdue@example.test', 'gestionnaire');
  const assujettiId = seedAssujetti('TLPE-CTX-LATE');

  db.prepare(
    `INSERT INTO contentieux (
      numero, assujetti_id, type, montant_litige, description,
      date_ouverture, date_limite_reponse, statut
    ) VALUES ('CTX-LATE-1', ?, 'contentieux', 550, 'Recours tardif', '2026-01-01', '2026-06-01', 'instruction')`,
  ).run(assujettiId);

  const run = createContentieuxDeadlineAlerts({ runDateIso: '2026-06-03', userId: gestionnaireId });
  assert.equal(run.created, 1);
  assert.equal(run.overdue, 1);

  const alerts = listContentieuxDeadlineAlerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].niveau_alerte, 'depasse');
  assert.equal(alerts[0].days_remaining, -2);
  assert.equal(alerts[0].overdue, true);

  const metrics = getDashboardMetrics('2026-06-03');
  assert.equal(metrics.operationnel.contentieux_alertes_total, 1);
  assert.equal(metrics.operationnel.contentieux_alertes_overdue, 1);
});

test('listContentieuxDeadlineAlerts retourne aussi les prolongations manuelles avec justification et nouvelle échéance', () => {
  resetTables();
  const gestionnaireId = seedUser('gest-extension@example.test', 'gestionnaire');
  const assujettiId = seedAssujetti('TLPE-CTX-EXT');

  const contentieuxId = Number(
    db
      .prepare(
        `INSERT INTO contentieux (
          numero, assujetti_id, type, montant_litige, description,
          date_ouverture, date_limite_reponse, statut,
          date_limite_reponse_initiale, delai_prolonge_justification, delai_prolonge_par, delai_prolonge_at
        ) VALUES (
          'CTX-EXT-1', ?, 'contentieux', 900, 'Moratoire contentieux',
          '2026-01-10', '2026-08-15', 'instruction',
          '2026-07-10', 'Décision du tribunal administratif', ?, '2026-06-20T09:00:00.000Z'
        )`,
      )
      .run(assujettiId, gestionnaireId).lastInsertRowid,
  );

  db.prepare(
    `INSERT INTO contentieux_alerts (
      contentieux_id, assujetti_id, niveau_alerte, date_reference, date_echeance,
      days_remaining, overdue, email_status, email_sent_at, email_notification_id, created_by
    ) VALUES (?, ?, 'J-30', '2026-07-16', '2026-08-15', 30, 0, 'envoye', '2026-07-16T07:00:00.000Z', NULL, ?)`,
  ).run(contentieuxId, assujettiId, gestionnaireId);

  const alerts = listContentieuxDeadlineAlerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].extended, true);
  assert.equal(alerts[0].date_limite_reponse_initiale, '2026-07-10');
  assert.equal(alerts[0].date_limite_reponse, '2026-08-15');
  assert.match(alerts[0].delai_prolonge_justification ?? '', /tribunal administratif/);
});
