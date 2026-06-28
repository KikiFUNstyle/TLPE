import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { db, initSchema } from '../db';
import { upsertEmailTemplateOverride } from '../emailTemplates';
import { ensureDeclarationReceipt, getDeclarationReceiptByToken, getDeclarationReceiptRecord, createReceiptDownloadUrl, getReceiptDownloadPath } from './declarationReceipt';

function resetFixtures() {
  initSchema();
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('DELETE FROM email_templates');
    db.exec('DELETE FROM declaration_receipts');
    db.exec('DELETE FROM notifications_email');
    db.exec('DELETE FROM invitation_magic_links');
    db.exec('DELETE FROM campagne_jobs');
    db.exec('DELETE FROM mises_en_demeure');
    db.exec('DELETE FROM paiements');
    db.exec('DELETE FROM titres');
    db.exec('DELETE FROM pieces_jointes');
    db.exec('DELETE FROM contentieux');
    db.exec('DELETE FROM lignes_declaration');
    db.exec('DELETE FROM declarations');
    db.exec('DELETE FROM dispositifs');
    db.exec('DELETE FROM campagnes');
    db.exec('DELETE FROM audit_log');
    db.exec('DELETE FROM users');
    db.exec('DELETE FROM assujettis');
    db.exec('DELETE FROM types_dispositifs');
    db.exec('DELETE FROM zones');
  } finally {
    db.pragma('foreign_keys = ON');
  }

  const typeId = Number(
    db
      .prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('ENS-T', 'Enseigne test', 'enseigne')`)
      .run().lastInsertRowid,
  );

  const assujettiId = Number(
    db
      .prepare(
        `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, statut)
         VALUES ('TLPE-RCPT-1', 'Assujetti Recette', 'recette@example.fr', 'actif')`,
      )
      .run().lastInsertRowid,
  );

  const userId = Number(
    db
      .prepare(
        `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
         VALUES ('admin-receipt@tlpe.local', 'hash', 'Admin', 'Receipt', 'admin', 1)`,
      )
      .run().lastInsertRowid,
  );

  const dispositifId = Number(
    db
      .prepare(
        `INSERT INTO dispositifs (
          identifiant, assujetti_id, type_id, surface, nombre_faces,
          adresse_rue, adresse_cp, adresse_ville, statut
        ) VALUES ('DSP-RCPT-1', ?, ?, 4.5, 1, '12 rue Test', '75001', 'Paris', 'declare')`,
      )
      .run(assujettiId, typeId).lastInsertRowid,
  );

  const declarationId = Number(
    db
      .prepare(
        `INSERT INTO declarations (
          numero, assujetti_id, annee, statut, date_soumission, hash_soumission
        ) VALUES ('DEC-2026-000999', ?, 2026, 'soumise', '2026-03-15 08:20:00', 'abc')`,
      )
      .run(assujettiId).lastInsertRowid,
  );

  db.prepare(
    `INSERT INTO lignes_declaration (
      declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose
    ) VALUES (?, ?, 4.5, 1, '2025-01-01')`,
  ).run(declarationId, dispositifId);

  return { declarationId, assujettiId, userId };
}

test('ensureDeclarationReceipt génère le PDF, persiste le token et expose la vérification publique', async () => {
  const fx = resetFixtures();
  process.env.TLPE_EMAIL_DELIVERY_MODE = 'mock-success';
  upsertEmailTemplateOverride({
    templateCode: 'accuse_reception_declaration',
    subjectTemplate: 'AR mairie {{numero_declaration}}',
    htmlTemplate:
      '<p>Accusé personnalisé {{numero_declaration}}</p><p>{{raison_sociale}}</p><p>{{date_reception}}</p><p><a href="{{lien}}">{{lien}}</a></p><p>{{service}}</p>',
    textTemplate:
      'Accusé personnalisé {{numero_declaration}} :: {{raison_sociale}} :: {{date_reception}} :: {{lien}} :: {{service}}',
    updatedBy: fx.userId,
  });

  const receipt = await ensureDeclarationReceipt({
    declarationId: fx.declarationId,
    numeroDeclaration: 'DEC-2026-000999',
    payloadHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    generatedBy: fx.userId,
    submittedAtIsoUtc: '2026-03-15T08:20:00.000Z',
    assujetti: {
      id: fx.assujettiId,
      identifiantTlpe: 'TLPE-RCPT-1',
      raisonSociale: 'Assujetti Recette',
      email: 'recette@example.fr',
    },
    lignes: [
      {
        dispositifIdentifiant: 'DSP-RCPT-1',
        typeLibelle: 'Enseigne test',
        categorie: 'enseigne',
        surfaceDeclaree: 4.5,
        nombreFaces: 1,
        adresseRue: '12 rue Test',
        adresseCp: '75001',
        adresseVille: 'Paris',
      },
    ],
  });

  assert.equal(receipt.emailStatus, 'envoye');
  assert.equal(receipt.payloadHash.length, 64);
  assert.ok(receipt.verificationToken.includes(`${fx.declarationId}-`));
  assert.ok(receipt.publicVerificationUrl.includes('/verification/accuse/'));

  const absPdf = path.resolve(__dirname, '..', '..', 'data', receipt.pdfRelativePath);
  assert.ok(fs.existsSync(absPdf));
  assert.ok(fs.statSync(absPdf).size > 300);

  const notification = db
    .prepare(
      `SELECT objet, corps, template_code, statut
       FROM notifications_email
       WHERE assujetti_id = ? AND template_code = 'accuse_reception_declaration'
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(fx.assujettiId) as { objet: string; corps: string; template_code: string; statut: string } | undefined;
  assert.ok(notification);
  assert.equal(notification?.template_code, 'accuse_reception_declaration');
  assert.equal(notification?.statut, 'envoye');
  assert.equal(notification?.objet, 'AR mairie DEC-2026-000999');
  assert.match(notification?.corps ?? '', /Accusé personnalisé DEC-2026-000999/);
  assert.match(notification?.corps ?? '', /Service TLPE/);

  const record = getDeclarationReceiptRecord(fx.declarationId);
  assert.ok(record);
  assert.equal(record?.payload_hash, receipt.payloadHash);

  const byToken = getDeclarationReceiptByToken(receipt.verificationToken);
  assert.ok(byToken);
  assert.equal(byToken?.declaration_id, fx.declarationId);
  assert.equal(byToken?.payload_hash, receipt.payloadHash);
});

test('ensureDeclarationReceipt marque un échec si l’email assujetti est absent', async () => {
  const fx = resetFixtures();
  process.env.TLPE_EMAIL_DELIVERY_MODE = 'mock-success';

  const receipt = await ensureDeclarationReceipt({
    declarationId: fx.declarationId,
    numeroDeclaration: 'DEC-2026-000999',
    payloadHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    generatedBy: fx.userId,
    submittedAtIsoUtc: '2026-03-15T08:20:00.000Z',
    assujetti: {
      id: fx.assujettiId,
      identifiantTlpe: 'TLPE-RCPT-1',
      raisonSociale: 'Assujetti Recette',
      email: null,
    },
    lignes: [],
  });

  assert.equal(receipt.emailStatus, 'echec');
  assert.equal(receipt.emailSentAt, null);
  assert.match(receipt.emailError ?? '', /Email assujetti manquant/);
});

test('ensureDeclarationReceipt marque un échec en mode mock-failure', async () => {
  const fx = resetFixtures();
  process.env.TLPE_EMAIL_DELIVERY_MODE = 'mock-failure';

  const receipt = await ensureDeclarationReceipt({
    declarationId: fx.declarationId,
    numeroDeclaration: 'DEC-2026-000999',
    payloadHash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    generatedBy: fx.userId,
    submittedAtIsoUtc: '2026-03-15T08:20:00.000Z',
    assujetti: {
      id: fx.assujettiId,
      identifiantTlpe: 'TLPE-RCPT-1',
      raisonSociale: 'Assujetti Recette',
      email: 'recette@example.fr',
    },
    lignes: [],
  });

  assert.equal(receipt.emailStatus, 'echec');
  assert.match(receipt.emailError ?? '', /mock-failure/);
  assert.equal(receipt.emailSentAt, null);
});

test('createReceiptDownloadUrl encode correctement les segments et getReceiptDownloadPath résout le chemin local', () => {
  const relativePath = 'receipts/declarations/token test/accusé.pdf';

  assert.equal(
    createReceiptDownloadUrl(relativePath),
    '/api/declarations/receipts/receipts/declarations/token%20test/accus%C3%A9.pdf',
  );

  const absolutePath = getReceiptDownloadPath(relativePath);
  assert.equal(absolutePath, path.resolve(__dirname, '..', '..', 'data', relativePath));
});

test('getDeclarationReceiptByToken retourne null pour un jeton inconnu', () => {
  resetFixtures();
  assert.equal(getDeclarationReceiptByToken('token-inconnu'), null);
});

test('getDeclarationReceiptRecord retourne null pour une déclaration inconnue', () => {
  resetFixtures();
  assert.equal(getDeclarationReceiptRecord(999999), null);
});

test('ensureDeclarationReceipt laisse l’email en pending si le SMTP n’est pas configuré', async () => {
  const fx = resetFixtures();
  delete process.env.TLPE_EMAIL_DELIVERY_MODE;

  const receipt = await ensureDeclarationReceipt({
    declarationId: fx.declarationId,
    numeroDeclaration: 'DEC-2026-000999',
    payloadHash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    generatedBy: fx.userId,
    submittedAtIsoUtc: '2026-03-15T08:20:00.000Z',
    assujetti: {
      id: fx.assujettiId,
      identifiantTlpe: 'TLPE-RCPT-1',
      raisonSociale: 'Assujetti Recette',
      email: 'recette@example.fr',
    },
    lignes: [],
  });

  assert.equal(receipt.emailStatus, 'pending');
  assert.equal(receipt.emailSentAt, null);
  assert.match(receipt.emailError ?? '', /SMTP non configuré|Envoi différé/);
});

test('ensureDeclarationReceipt accepte un horodatage UTC sans suffixe timezone', async () => {
  const fx = resetFixtures();
  process.env.TLPE_EMAIL_DELIVERY_MODE = 'mock-success';

  const receipt = await ensureDeclarationReceipt({
    declarationId: fx.declarationId,
    numeroDeclaration: 'DEC-2026-000999',
    payloadHash: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    generatedBy: fx.userId,
    submittedAtIsoUtc: '2026-03-15T08:20:00',
    assujetti: {
      id: fx.assujettiId,
      identifiantTlpe: 'TLPE-RCPT-1',
      raisonSociale: 'Assujetti Recette',
      email: 'recette@example.fr',
    },
    lignes: [],
  });

  assert.equal(receipt.emailStatus, 'envoye');
  assert.ok(receipt.generatedAt);
});

test('ensureDeclarationReceipt génère plusieurs pages quand la déclaration contient de nombreuses lignes', async () => {
  const fx = resetFixtures();
  process.env.TLPE_EMAIL_DELIVERY_MODE = 'mock-success';

  const lignes = Array.from({ length: 35 }, (_, index) => ({
    dispositifIdentifiant: `DSP-RCPT-${index + 1}`,
    typeLibelle: `Enseigne test ${index + 1}`,
    categorie: 'enseigne',
    surfaceDeclaree: 4.5 + index,
    nombreFaces: (index % 3) + 1,
    adresseRue: `${index + 1} rue Test`,
    adresseCp: '75001',
    adresseVille: 'Paris',
  }));

  const receipt = await ensureDeclarationReceipt({
    declarationId: fx.declarationId,
    numeroDeclaration: 'DEC-2026-000999',
    payloadHash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    generatedBy: fx.userId,
    submittedAtIsoUtc: '2026-03-15T08:20:00.000Z',
    assujetti: {
      id: fx.assujettiId,
      identifiantTlpe: 'TLPE-RCPT-1',
      raisonSociale: 'Assujetti Recette',
      email: 'recette@example.fr',
    },
    lignes,
  });

  const absPdf = path.resolve(__dirname, '..', '..', 'data', receipt.pdfRelativePath);
  assert.ok(fs.existsSync(absPdf));
  assert.ok(fs.statSync(absPdf).size > 1500);
});

test('ensureDeclarationReceipt est idempotent pour un hash identique', async () => {
  const fx = resetFixtures();
  process.env.TLPE_EMAIL_DELIVERY_MODE = 'mock-success';

  const payloadHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  const first = await ensureDeclarationReceipt({
    declarationId: fx.declarationId,
    numeroDeclaration: 'DEC-2026-000999',
    payloadHash,
    generatedBy: fx.userId,
    submittedAtIsoUtc: '2026-03-15T08:20:00.000Z',
    assujetti: {
      id: fx.assujettiId,
      identifiantTlpe: 'TLPE-RCPT-1',
      raisonSociale: 'Assujetti Recette',
      email: 'recette@example.fr',
    },
    lignes: [],
  });

  const second = await ensureDeclarationReceipt({
    declarationId: fx.declarationId,
    numeroDeclaration: 'DEC-2026-000999',
    payloadHash,
    generatedBy: fx.userId,
    submittedAtIsoUtc: '2026-03-15T08:20:00.000Z',
    assujetti: {
      id: fx.assujettiId,
      identifiantTlpe: 'TLPE-RCPT-1',
      raisonSociale: 'Assujetti Recette',
      email: 'recette@example.fr',
    },
    lignes: [],
  });

  assert.equal(first.verificationToken, second.verificationToken);
  assert.equal(first.pdfRelativePath, second.pdfRelativePath);
});
