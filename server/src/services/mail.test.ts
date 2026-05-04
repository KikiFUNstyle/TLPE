import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSmtpConfigFromEnv,
  createMailService,
  markAssujettiEmailInvalide,
  queueEmailNotification,
  runPendingEmailNotificationsWorker,
} from './mail';
import { db, initSchema } from '../db';

function resetTables() {
  initSchema();
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('DELETE FROM contentieux_alerts');
    db.exec('DELETE FROM notifications_email');
    db.exec('DELETE FROM invitation_magic_links');
    db.exec('DELETE FROM campagne_jobs');
    db.exec('DELETE FROM declaration_receipts');
    db.exec('DELETE FROM mises_en_demeure');
    db.exec('DELETE FROM recouvrement_actions');
    db.exec('DELETE FROM paiements');
    db.exec('DELETE FROM titres');
    db.exec('DELETE FROM pieces_jointes');
    db.exec('DELETE FROM lignes_declaration');
    db.exec('DELETE FROM declarations');
    db.exec('DELETE FROM controles');
    db.exec('DELETE FROM dispositifs');
    db.exec('DELETE FROM campagnes');
    db.exec('DELETE FROM audit_log');
    db.exec('DELETE FROM users');
    db.exec('DELETE FROM assujettis');
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function seedAdmin(email = 'admin-mail@tlpe.local') {
  return Number(
    db
      .prepare(
        `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
         VALUES (?, 'hash', 'Mail', 'Admin', 'admin', 1)`,
      )
      .run(email).lastInsertRowid,
  );
}

function seedAssujetti(code: string, email: string | null) {
  return Number(
    db
      .prepare(
        `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, statut)
         VALUES (?, ?, ?, 'actif')`,
      )
      .run(code, `Assujetti ${code}`, email).lastInsertRowid,
  );
}

function resetMailEnv() {
  resetTables();
  delete process.env.TLPE_SMTP_HOST;
  delete process.env.TLPE_SMTP_PORT;
  delete process.env.TLPE_SMTP_USER;
  delete process.env.TLPE_SMTP_PASSWORD;
  delete process.env.TLPE_SMTP_FROM;
  delete process.env.TLPE_SMTP_SECURE;
  delete process.env.TLPE_EMAIL_DELIVERY_MODE;
  delete process.env.TLPE_SMTP_DEV_MODE;
  delete process.env.TLPE_SMTP_BACKOFF_MS;
  delete process.env.TLPE_SMTP_MAX_ATTEMPTS;
  delete process.env.TLPE_SMTP_MAILHOG_URL;
}

test.beforeEach(() => {
  resetMailEnv();
});

test('createSmtpConfigFromEnv returns null when SMTP env is incomplete', () => {
  process.env.TLPE_SMTP_HOST = 'smtp.example.test';
  process.env.TLPE_SMTP_PORT = '1025';

  const config = createSmtpConfigFromEnv();

  assert.equal(config, null);
});

test('queueEmailNotification stores pending notification with attachments metadata and worker sends it', async () => {
  const adminId = seedAdmin();
  const assujettiId = seedAssujetti('TLPE-MAIL-001', 'dest@example.test');

  const notificationId = queueEmailNotification({
    assujettiId,
    campagneId: null,
    emailDestinataire: 'dest@example.test',
    objet: 'Bienvenue TLPE',
    corps: '<p>Bonjour</p>',
    attachments: [
      {
        filename: 'piece.txt',
        contentType: 'text/plain',
        content: Buffer.from('bonjour'),
      },
    ],
    templateCode: 'invitation_campagne',
    relanceNiveau: null,
    mode: 'auto',
    createdBy: adminId,
    metadata: { source: 'test' },
  });

  const before = db
    .prepare(`SELECT statut, tentatives, pieces_jointes_json FROM notifications_email WHERE id = ?`)
    .get(notificationId) as { statut: string; tentatives: number; pieces_jointes_json: string | null };
  assert.equal(before.statut, 'pending');
  assert.equal(before.tentatives, 0);
  assert.match(before.pieces_jointes_json ?? '', /piece\.txt/);

  const mailService = createMailService({
    mode: 'stub',
    sendImpl: async () => ({ messageId: 'stub-1' }),
  });

  const result = await runPendingEmailNotificationsWorker({ mailService, nowIso: '2026-06-01T10:00:00.000Z' });

  assert.equal(result.processed, 1);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);

  const after = db
    .prepare(`SELECT statut, tentatives, sent_at, erreur, provider_message_id FROM notifications_email WHERE id = ?`)
    .get(notificationId) as {
      statut: string;
      tentatives: number;
      sent_at: string | null;
      erreur: string | null;
      provider_message_id: string | null;
    };
  assert.equal(after.statut, 'envoye');
  assert.equal(after.tentatives, 1);
  assert.equal(after.sent_at, '2026-06-01T10:00:00.000Z');
  assert.equal(after.erreur, null);
  assert.equal(after.provider_message_id, 'stub-1');
});

test('runPendingEmailNotificationsWorker retries failures with backoff and leaves notification pending before max attempts', async () => {
  const assujettiId = seedAssujetti('TLPE-MAIL-002', 'retry@example.test');
  const notificationId = queueEmailNotification({
    assujettiId,
    campagneId: null,
    emailDestinataire: 'retry@example.test',
    objet: 'Retry',
    corps: 'Corps',
    attachments: [],
    templateCode: 'relance_declaration',
    relanceNiveau: 'J-30',
    mode: 'auto',
    createdBy: null,
  });

  const failingService = createMailService({
    mode: 'stub',
    sendImpl: async () => {
      throw new Error('SMTP offline');
    },
  });

  const firstRun = await runPendingEmailNotificationsWorker({
    mailService: failingService,
    nowIso: '2026-06-01T10:00:00.000Z',
    maxAttempts: 3,
    backoffMs: 60000,
  });
  assert.equal(firstRun.processed, 1);
  assert.equal(firstRun.failed, 1);

  const afterFirst = db
    .prepare(`SELECT statut, tentatives, erreur, prochain_essai_at FROM notifications_email WHERE id = ?`)
    .get(notificationId) as {
      statut: string;
      tentatives: number;
      erreur: string | null;
      prochain_essai_at: string | null;
    };
  assert.equal(afterFirst.statut, 'pending');
  assert.equal(afterFirst.tentatives, 1);
  assert.match(afterFirst.erreur ?? '', /SMTP offline/);
  assert.equal(afterFirst.prochain_essai_at, '2026-06-01T10:01:00.000Z');

  const skippedTooEarly = await runPendingEmailNotificationsWorker({
    mailService: failingService,
    nowIso: '2026-06-01T10:00:30.000Z',
    maxAttempts: 3,
    backoffMs: 60000,
  });
  assert.equal(skippedTooEarly.processed, 0);

  const secondRun = await runPendingEmailNotificationsWorker({
    mailService: failingService,
    nowIso: '2026-06-01T10:01:00.000Z',
    maxAttempts: 3,
    backoffMs: 60000,
  });
  assert.equal(secondRun.processed, 1);

  const afterSecond = db
    .prepare(`SELECT statut, tentatives, prochain_essai_at FROM notifications_email WHERE id = ?`)
    .get(notificationId) as { statut: string; tentatives: number; prochain_essai_at: string | null };
  assert.equal(afterSecond.statut, 'pending');
  assert.equal(afterSecond.tentatives, 2);
  assert.equal(afterSecond.prochain_essai_at, '2026-06-01T10:03:00.000Z');
});

test('runPendingEmailNotificationsWorker marks invalid recipient as echec and assujetti email_invalide', async () => {
  const assujettiId = seedAssujetti('TLPE-MAIL-003', 'bounce@example.test');
  const notificationId = queueEmailNotification({
    assujettiId,
    campagneId: null,
    emailDestinataire: 'bounce@example.test',
    objet: 'Bounce',
    corps: 'Corps',
    attachments: [],
    templateCode: 'alerte_contentieux',
    relanceNiveau: 'depasse',
    mode: 'auto',
    createdBy: null,
  });

  const bounceService = createMailService({
    mode: 'stub',
    sendImpl: async () => {
      const error = new Error('Adresse destinataire invalide');
      (error as Error & { code?: string }).code = 'EMAIL_INVALID';
      throw error;
    },
  });

  const result = await runPendingEmailNotificationsWorker({
    mailService: bounceService,
    nowIso: '2026-06-01T11:00:00.000Z',
    maxAttempts: 3,
    backoffMs: 60000,
  });

  assert.equal(result.processed, 1);
  assert.equal(result.failed, 1);

  const notif = db
    .prepare(`SELECT statut, erreur, tentatives FROM notifications_email WHERE id = ?`)
    .get(notificationId) as { statut: string; erreur: string | null; tentatives: number };
  assert.equal(notif.statut, 'echec');
  assert.equal(notif.tentatives, 1);
  assert.match(notif.erreur ?? '', /invalide/i);

  const assujetti = db
    .prepare(`SELECT statut, email_invalide FROM assujettis WHERE id = ?`)
    .get(assujettiId) as { statut: string; email_invalide: number };
  assert.equal(assujetti.statut, 'email_invalide');
  assert.equal(assujetti.email_invalide, 1);
});

test('markAssujettiEmailInvalide is idempotent', () => {
  const assujettiId = seedAssujetti('TLPE-MAIL-004', 'idempotent@example.test');

  markAssujettiEmailInvalide(assujettiId);
  markAssujettiEmailInvalide(assujettiId);

  const row = db
    .prepare(`SELECT statut, email_invalide FROM assujettis WHERE id = ?`)
    .get(assujettiId) as { statut: string; email_invalide: number };
  assert.equal(row.statut, 'email_invalide');
  assert.equal(row.email_invalide, 1);
});
