import test from 'node:test';
import assert from 'node:assert/strict';
import { db, initSchema } from './db';
import { createCampagne, openCampagne } from './campagnes';
import { sendInvitationsForCampagne } from './invitations';

process.env.TLPE_EMAIL_DELIVERY_MODE = 'mock-success';

function resetTables() {
  initSchema();
  db.exec('DELETE FROM notifications_email');
  db.exec('DELETE FROM invitation_magic_links');
  db.exec('DELETE FROM campagne_jobs');
  db.exec('DELETE FROM mises_en_demeure');
  db.exec('DELETE FROM recouvrement_actions');
  db.exec('DELETE FROM paiements');
  db.exec('DELETE FROM contentieux');
  db.exec('DELETE FROM titres');
  db.exec('DELETE FROM pieces_jointes');
  db.exec('DELETE FROM lignes_declaration');
  db.exec('DELETE FROM declarations');
  db.exec('DELETE FROM dispositifs');
  db.exec('DELETE FROM campagnes');
  db.exec('DELETE FROM audit_log');
  db.exec('DELETE FROM users');
  db.exec('DELETE FROM assujettis');
}

function seedAdmin(email = 'admin-invitations@tlpe.local') {
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES (?, 'hash', 'Admin', 'Invitations', 'admin', 1)`,
    )
    .run(email);
  return Number(info.lastInsertRowid);
}

function seedAssujetti(options: { code: string; email?: string | null; statut?: 'actif' | 'inactif' }) {
  const info = db
    .prepare(
      `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, statut)
       VALUES (?, ?, ?, ?)`,
    )
    .run(options.code, `Assujetti ${options.code}`, options.email ?? null, options.statut ?? 'actif');
  return Number(info.lastInsertRowid);
}

function seedContribuableAccount(assujettiId: number, email: string) {
  db.prepare(
    `INSERT INTO users (email, password_hash, nom, prenom, role, assujetti_id, actif)
     VALUES (?, 'hash', 'Compte', 'Portail', 'contribuable', ?, 1)`,
  ).run(email, assujettiId);
}

test('openCampagne envoie les invitations email et trace notifications_email', () => {
  resetTables();
  const adminId = seedAdmin();

  const aAvecCompte = seedAssujetti({ code: 'TLPE-INV-001', email: 'avec-compte@example.fr' });
  const aSansCompte = seedAssujetti({ code: 'TLPE-INV-002', email: 'sans-compte@example.fr' });
  seedAssujetti({ code: 'TLPE-INV-003', email: null });
  seedAssujetti({ code: 'TLPE-INV-004', email: 'inactif@example.fr', statut: 'inactif' });

  seedContribuableAccount(aAvecCompte, 'compte-portail@example.fr');

  const campagneId = createCampagne({
    annee: 2032,
    date_ouverture: '2032-01-01',
    date_limite_declaration: '2032-03-31',
    date_cloture: '2032-04-15',
    created_by: adminId,
  });

  const result = openCampagne(campagneId, adminId, '127.0.0.1');
  assert.equal(result.annee, 2032);
  assert.equal(result.invitations_preparees, 2);

  const notifications = db
    .prepare(
      `SELECT assujetti_id, email_destinataire, objet, corps, magic_link, statut
       FROM notifications_email
       WHERE campagne_id = ?
       ORDER BY assujetti_id`,
    )
    .all(campagneId) as Array<{
    assujetti_id: number;
    email_destinataire: string;
    objet: string;
    corps: string;
    magic_link: string | null;
    statut: string;
  }>;

  assert.equal(notifications.length, 2);
  assert.ok(notifications.every((n) => n.statut === 'envoye'));
  assert.ok(notifications.every((n) => n.objet.includes('Campagne TLPE 2032')));
  assert.ok(notifications.every((n) => /date limite/i.test(n.corps)));

  const avecCompte = notifications.find((n) => n.assujetti_id === aAvecCompte);
  const sansCompte = notifications.find((n) => n.assujetti_id === aSansCompte);

  assert.ok(avecCompte);
  assert.equal(avecCompte?.magic_link, null);

  assert.ok(sansCompte);
  assert.ok(sansCompte?.magic_link && sansCompte.magic_link.includes('/login?invitation_token=[redacted]'));
  assert.ok(sansCompte?.corps.includes('/login?invitation_token=[redacted]'));

  const rawTokenLeak = /invitation_token=[a-f0-9]{32,}/.test(sansCompte?.corps ?? '');
  assert.equal(rawTokenLeak, false);

  const tokenCount = (
    db
      .prepare('SELECT COUNT(*) AS c FROM invitation_magic_links WHERE campagne_id = ? AND assujetti_id = ?')
      .get(campagneId, aSansCompte) as { c: number }
  ).c;
  assert.equal(tokenCount, 1);

  const storedToken = db
    .prepare('SELECT token FROM invitation_magic_links WHERE campagne_id = ? AND assujetti_id = ? LIMIT 1')
    .get(campagneId, aSansCompte) as { token: string } | undefined;
  assert.ok(storedToken);
  assert.match(storedToken!.token, /^[a-f0-9]{64}$/);
});

test('sendInvitationsForCampagne permet renvoi cible pour un assujetti', () => {
  resetTables();
  const adminId = seedAdmin();

  const assujettiId = seedAssujetti({ code: 'TLPE-INV-010', email: 'renvoi@example.fr' });

  const campagneId = createCampagne({
    annee: 2033,
    date_ouverture: '2033-01-01',
    date_limite_declaration: '2033-03-31',
    date_cloture: '2033-04-15',
    created_by: adminId,
  });

  openCampagne(campagneId, adminId);

  const firstCount = (db.prepare('SELECT COUNT(*) AS c FROM notifications_email WHERE campagne_id = ?').get(campagneId) as { c: number }).c;
  assert.equal(firstCount, 1);

  const resend = sendInvitationsForCampagne({
    campagneId,
    userId: adminId,
    assujettiId,
    mode: 'manual',
    ip: '127.0.0.1',
  });

  assert.equal(resend.sent, 1);
  assert.equal(resend.failed, 0);

  const secondCount = (db.prepare('SELECT COUNT(*) AS c FROM notifications_email WHERE campagne_id = ?').get(campagneId) as { c: number }).c;
  assert.equal(secondCount, 2);
});
