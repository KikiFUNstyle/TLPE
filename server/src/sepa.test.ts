import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { db, initSchema } from './db';
import { hashPassword, signToken, type AuthUser } from './auth';
import { assujettisRouter } from './routes/assujettis';
import { sepaRouter } from './routes/sepa';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/assujettis', assujettisRouter);
  app.use('/api/sepa', sepaRouter);
  return app;
}

function makeAuthHeader(user: AuthUser): Record<string, string> {
  return { Authorization: `Bearer ${signToken(user)}` };
}

async function request(params: {
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}) {
  const app = createApp();
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Impossible de determiner le port de test');
  }

  try {
    const res = await fetch(`http://127.0.0.1:${address.port}${params.path}`, {
      method: params.method,
      headers: {
        ...(params.body ? { 'Content-Type': 'application/json' } : {}),
        ...(params.headers || {}),
      },
      body: params.body ? JSON.stringify(params.body) : undefined,
    });
    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    return {
      status: res.status,
      contentType,
      disposition: res.headers.get('content-disposition') || '',
      text,
    };
  } finally {
    server.close();
  }
}

function validateCurrentPain008Xsd(xml: string): { ok: boolean; report: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlpe-sepa-test-'));
  const xmlPath = path.join(tempDir, 'pain.008.xml');
  const xsdPath = path.join(__dirname, 'xsd', 'pain.008.001.02.xsd');
  fs.writeFileSync(xmlPath, xml, 'utf8');
  try {
    execFileSync('xmllint', ['--noout', '--schema', xsdPath, xmlPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, report: 'ok' };
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String((error as { stderr?: string | Buffer }).stderr ?? '').trim()
        : String(error);
    return { ok: false, report: stderr };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function resetFixtures() {
  initSchema();
  db.exec('DELETE FROM declaration_receipts');
  db.exec('DELETE FROM notifications_email');
  db.exec('DELETE FROM invitation_magic_links');
  db.exec('DELETE FROM campagne_jobs');
  db.exec('DELETE FROM mises_en_demeure');
  db.exec('DELETE FROM paiements');
  db.exec('DELETE FROM sepa_export_items');
  db.exec('DELETE FROM sepa_exports');
  db.exec('DELETE FROM sepa_prelevements');
  db.exec('DELETE FROM mandats_sepa');
  db.exec('DELETE FROM pesv2_export_titres');
  db.exec('DELETE FROM pesv2_exports');
  db.exec('DELETE FROM titres');
  db.exec('DELETE FROM pieces_jointes');
  db.exec('DELETE FROM contentieux');
  db.exec('DELETE FROM lignes_declaration');
  db.exec('DELETE FROM declarations');
  db.exec('DELETE FROM controles');
  db.exec('DELETE FROM dispositifs');
  db.exec('DELETE FROM campagnes');
  db.exec('DELETE FROM audit_log');
  db.exec('DELETE FROM users');
  db.exec('DELETE FROM assujettis');
  db.exec('DELETE FROM types_dispositifs');

  const typeId = Number(
    db.prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('ENS-SEPA', 'Enseigne SEPA', 'enseigne')`).run()
      .lastInsertRowid,
  );

  const gestionnaireId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES ('gestionnaire-sepa@tlpe.local', ?, 'Gest', 'Sepa', 'gestionnaire', 1)`,
    ).run(hashPassword('x')).lastInsertRowid,
  );
  const financierId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES ('financier-sepa@tlpe.local', ?, 'Fin', 'Sepa', 'financier', 1)`,
    ).run(hashPassword('x')).lastInsertRowid,
  );
  const contribuableAssujettiId = Number(
    db.prepare(
      `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, siret, email, statut)
       VALUES ('TLPE-SEPA-001', 'Alpha Publicite', '12345678901234', 'alpha@example.test', 'actif')`,
    ).run().lastInsertRowid,
  );
  const otherAssujettiId = Number(
    db.prepare(
      `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, siret, email, statut)
       VALUES ('TLPE-SEPA-002', 'Beta Enseignes', '22345678901234', 'beta@example.test', 'actif')`,
    ).run().lastInsertRowid,
  );
  const contribuableId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, assujetti_id, actif)
       VALUES ('contribuable-sepa@tlpe.local', ?, 'Contrib', 'Sepa', 'contribuable', ?, 1)`,
    ).run(hashPassword('x'), contribuableAssujettiId).lastInsertRowid,
  );

  const declarationA = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-SEPA-2026-001', ?, 2026, 'validee', 1200)`,
    ).run(contribuableAssujettiId).lastInsertRowid,
  );
  const declarationB = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-SEPA-2025-002', ?, 2025, 'validee', 450.5)`,
    ).run(contribuableAssujettiId).lastInsertRowid,
  );
  const declarationOther = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-SEPA-2026-003', ?, 2026, 'validee', 300)`,
    ).run(otherAssujettiId).lastInsertRowid,
  );

  const dispositifA = Number(
    db.prepare(
      `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, statut)
       VALUES ('DSP-SEPA-001', ?, ?, 12, 1, 'declare')`,
    ).run(contribuableAssujettiId, typeId).lastInsertRowid,
  );
  const dispositifB = Number(
    db.prepare(
      `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, statut)
       VALUES ('DSP-SEPA-002', ?, ?, 4.5, 2, 'declare')`,
    ).run(contribuableAssujettiId, typeId).lastInsertRowid,
  );
  const dispositifOther = Number(
    db.prepare(
      `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, statut)
       VALUES ('DSP-SEPA-003', ?, ?, 2.5, 1, 'declare')`,
    ).run(otherAssujettiId, typeId).lastInsertRowid,
  );

  db.prepare(
    `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne)
     VALUES (?, ?, 12, 1, '2026-01-01', 1200)`,
  ).run(declarationA, dispositifA);
  db.prepare(
    `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne)
     VALUES (?, ?, 4.5, 2, '2026-01-01', 450.5)`,
  ).run(declarationB, dispositifB);
  db.prepare(
    `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne)
     VALUES (?, ?, 2.5, 1, '2026-01-01', 300)`,
  ).run(declarationOther, dispositifOther);

  const titreDue = Number(
    db.prepare(
      `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut)
       VALUES ('TIT-SEPA-2026-000001', ?, ?, 2026, 1200, '2026-04-01', '2026-08-31', 'emis')`,
    ).run(declarationA, contribuableAssujettiId).lastInsertRowid,
  );
  const titreLater = Number(
    db.prepare(
      `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut)
       VALUES ('TIT-SEPA-2025-000002', ?, ?, 2025, 450.5, '2026-05-10', '2026-09-15', 'emis')`,
    ).run(declarationB, contribuableAssujettiId).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut)
     VALUES ('TIT-SEPA-2026-000003', ?, ?, 2026, 300, '2026-04-01', '2026-08-31', 'emis')`,
  ).run(declarationOther, otherAssujettiId);

  return {
    gestionnaire: {
      id: gestionnaireId,
      email: 'gestionnaire-sepa@tlpe.local',
      role: 'gestionnaire' as const,
      nom: 'Gest',
      prenom: 'Sepa',
      assujetti_id: null,
    },
    financier: {
      id: financierId,
      email: 'financier-sepa@tlpe.local',
      role: 'financier' as const,
      nom: 'Fin',
      prenom: 'Sepa',
      assujetti_id: null,
    },
    contribuable: {
      id: contribuableId,
      email: 'contribuable-sepa@tlpe.local',
      role: 'contribuable' as const,
      nom: 'Contrib',
      prenom: 'Sepa',
      assujetti_id: contribuableAssujettiId,
    },
    assujettiId: contribuableAssujettiId,
    otherAssujettiId,
    titreDue,
    titreLater,
  };
}

test('POST /api/assujettis/:id/mandats-sepa valide IBAN/BIC et journalise la création du mandat', async () => {
  const fx = resetFixtures();

  const invalid = await request({
    method: 'POST',
    path: `/api/assujettis/${fx.assujettiId}/mandats-sepa`,
    headers: makeAuthHeader(fx.gestionnaire),
    body: {
      rum: 'RUM-INVALID',
      iban: 'FR761234',
      bic: 'AGRIFRPP',
      date_signature: '2026-01-15',
    },
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.text, /IBAN invalide/i);

  const created = await request({
    method: 'POST',
    path: `/api/assujettis/${fx.assujettiId}/mandats-sepa`,
    headers: makeAuthHeader(fx.gestionnaire),
    body: {
      rum: 'RUM-ALPHA-001',
      iban: 'FR7630006000011234567890189',
      bic: 'AGRIFRPPXXX',
      date_signature: '2026-01-15',
    },
  });
  assert.equal(created.status, 201);
  assert.match(created.text, /RUM-ALPHA-001/);
  assert.match(created.text, /\*\*\*\*0189/);

  const stored = db.prepare('SELECT rum, statut, iban, bic FROM mandats_sepa WHERE assujetti_id = ?').get(fx.assujettiId) as
    | { rum: string; statut: string; iban: string; bic: string }
    | undefined;
  assert.ok(stored);
  assert.equal(stored!.rum, 'RUM-ALPHA-001');
  assert.equal(stored!.statut, 'actif');
  assert.equal(stored!.iban, 'FR7630006000011234567890189');
  assert.equal(stored!.bic, 'AGRIFRPPXXX');

  assert.throws(
    () =>
      db.prepare(
        `INSERT INTO mandats_sepa (assujetti_id, rum, iban, bic, date_signature, statut)
         VALUES (?, 'RUM-DIRECT-002', 'FR7630006000011234567890189', 'AGRIFRPPXXX', '2026-02-01', 'actif')`,
      ).run(fx.assujettiId),
    /UNIQUE/i,
  );

  const audit = db.prepare("SELECT action, details FROM audit_log WHERE action = 'create-mandat-sepa'").get() as
    | { action: string; details: string }
    | undefined;
  assert.ok(audit);
  assert.match(audit!.details, /RUM-ALPHA-001/);
});

test('POST /api/assujettis/:id/mandats-sepa/:mandatId/revoke révoque le mandat actif et autorise un nouveau mandat', async () => {
  const fx = resetFixtures();

  const first = await request({
    method: 'POST',
    path: `/api/assujettis/${fx.assujettiId}/mandats-sepa`,
    headers: makeAuthHeader(fx.gestionnaire),
    body: {
      rum: 'RUM-ALPHA-001',
      iban: 'FR7630006000011234567890189',
      bic: 'AGRIFRPPXXX',
      date_signature: '2026-01-15',
    },
  });
  assert.equal(first.status, 201);

  const activeMandat = db.prepare('SELECT id FROM mandats_sepa WHERE assujetti_id = ? AND statut = ?').get(fx.assujettiId, 'actif') as
    | { id: number }
    | undefined;
  assert.ok(activeMandat);

  const duplicate = await request({
    method: 'POST',
    path: `/api/assujettis/${fx.assujettiId}/mandats-sepa`,
    headers: makeAuthHeader(fx.gestionnaire),
    body: {
      rum: 'RUM-ALPHA-002',
      iban: 'FR7630006000011234567890189',
      bic: 'AGRIFRPPXXX',
      date_signature: '2026-02-01',
    },
  });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.text, /mandat actif/i);

  const revoked = await request({
    method: 'POST',
    path: `/api/assujettis/${fx.assujettiId}/mandats-sepa/${activeMandat!.id}/revoke`,
    headers: makeAuthHeader(fx.gestionnaire),
    body: { date_revocation: '2026-09-01' },
  });
  assert.equal(revoked.status, 200);
  assert.match(revoked.text, /revoque/);
  assert.match(revoked.text, /2026-09-01/);

  const storedRevoked = db.prepare('SELECT statut, date_revocation FROM mandats_sepa WHERE id = ?').get(activeMandat!.id) as
    | { statut: string; date_revocation: string | null }
    | undefined;
  assert.ok(storedRevoked);
  assert.equal(storedRevoked!.statut, 'revoque');
  assert.equal(storedRevoked!.date_revocation, '2026-09-01');

  const audit = db.prepare("SELECT action, details FROM audit_log WHERE action = 'revoke-mandat-sepa'").get() as
    | { action: string; details: string }
    | undefined;
  assert.ok(audit);
  assert.match(audit!.details, /2026-09-01/);

  const replacement = await request({
    method: 'POST',
    path: `/api/assujettis/${fx.assujettiId}/mandats-sepa`,
    headers: makeAuthHeader(fx.gestionnaire),
    body: {
      rum: 'RUM-ALPHA-002',
      iban: 'FR7630006000011234567890189',
      bic: 'AGRIFRPPXXX',
      date_signature: '2026-09-02',
    },
  });
  assert.equal(replacement.status, 201);
  assert.match(replacement.text, /RUM-ALPHA-002/);
});

test('POST /api/sepa/export-batch génère les ordres à échéance puis exporte FRST puis RCUR en pain.008', async () => {
  const fx = resetFixtures();

  const mandatInfo = db.prepare(
    `INSERT INTO mandats_sepa (assujetti_id, rum, iban, bic, date_signature, statut)
     VALUES (?, 'RUM-ALPHA-001', 'FR7630006000011234567890189', 'AGRIFRPPXXX', '2026-01-15', 'actif')`,
  ).run(fx.assujettiId);
  const mandatId = Number(mandatInfo.lastInsertRowid);

  const first = await request({
    method: 'POST',
    path: '/api/sepa/export-batch',
    headers: makeAuthHeader(fx.financier),
    body: { date_reference: '2026-08-31', date_prelevement: '2026-09-05' },
  });

  assert.equal(first.status, 200);
  assert.match(first.contentType, /xml/);
  assert.match(first.disposition, /pain\.008-000001\.xml/);
  assert.match(first.text, /<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain\.008\.001\.02"/);
  assert.match(first.text, /<SeqTp>FRST<\/SeqTp>/);
  assert.match(first.text, /<InstrId>SEPA-FRST-1-1<\/InstrId>/);
  assert.match(first.text, /<SchmeNm>\s*<Prtry>SEPA<\/Prtry>\s*<\/SchmeNm>/);
  assert.match(first.text, /<EndToEndId>RUM-ALPHA-001-TIT-SEPA-2026-000001<\/EndToEndId>/);
  assert.doesNotMatch(first.text, /TIT-SEPA-2025-000002/);

  const firstOrder = db.prepare('SELECT sequence_type, statut, mandat_id, titre_id FROM sepa_prelevements WHERE titre_id = ?').get(fx.titreDue) as
    | { sequence_type: string; statut: string; mandat_id: number; titre_id: number }
    | undefined;
  assert.ok(firstOrder);
  assert.equal(firstOrder!.sequence_type, 'FRST');
  assert.equal(firstOrder!.statut, 'exporte');
  assert.equal(firstOrder!.mandat_id, mandatId);

  const second = await request({
    method: 'POST',
    path: '/api/sepa/export-batch',
    headers: makeAuthHeader(fx.financier),
    body: { date_reference: '2026-09-15', date_prelevement: '2026-09-20' },
  });

  assert.equal(second.status, 200);
  assert.match(second.text, /<SeqTp>RCUR<\/SeqTp>/);
  assert.match(second.text, /<InstrId>SEPA-RCUR-1-1<\/InstrId>/);
  assert.match(second.text, /TIT-SEPA-2025-000002/);

  const xsdValidation = validateCurrentPain008Xsd(second.text);
  assert.equal(xsdValidation.ok, true, xsdValidation.report);

  const exports = db.prepare('SELECT numero_lot, xsd_validation_ok, ordres_count FROM sepa_exports ORDER BY numero_lot').all() as Array<{
    numero_lot: number;
    xsd_validation_ok: number;
    ordres_count: number;
  }>;
  assert.deepEqual(exports.map((row) => row.numero_lot), [1, 2]);
  assert.deepEqual(exports.map((row) => row.xsd_validation_ok), [1, 1]);
  assert.deepEqual(exports.map((row) => row.ordres_count), [1, 1]);

  const secondOrder = db.prepare('SELECT sequence_type, statut FROM sepa_prelevements WHERE titre_id = ?').get(fx.titreLater) as
    | { sequence_type: string; statut: string }
    | undefined;
  assert.ok(secondOrder);
  assert.equal(secondOrder!.sequence_type, 'RCUR');
  assert.equal(secondOrder!.statut, 'exporte');
});

test('POST /api/sepa/export-batch ignore les mandats révoqués et masque les erreurs XSD côté client', async () => {
  const fx = resetFixtures();

  const revokedMandat = Number(
    db.prepare(
      `INSERT INTO mandats_sepa (assujetti_id, rum, iban, bic, date_signature, statut, date_revocation)
       VALUES (?, 'RUM-REV-001', 'FR7630006000011234567890189', 'AGRIFRPPXXX', '2026-01-15', 'revoque', '2026-08-01')`,
    ).run(fx.assujettiId).lastInsertRowid,
  );
  assert.ok(revokedMandat > 0);

  const blocked = await request({
    method: 'POST',
    path: '/api/sepa/export-batch',
    headers: makeAuthHeader(fx.financier),
    body: { date_reference: '2026-08-31', date_prelevement: '2026-09-05' },
  });
  assert.equal(blocked.status, 404);
  assert.match(blocked.text, /Aucun ordre SEPA à exporter/);

  db.prepare("UPDATE mandats_sepa SET statut = 'actif', date_revocation = NULL WHERE assujetti_id = ?").run(fx.assujettiId);
  const xsdPath = path.join(__dirname, 'xsd', 'pain.008.001.02.xsd');
  const backupPath = path.join(__dirname, 'xsd', 'pain.008.001.02.xsd.bak');
  fs.renameSync(xsdPath, backupPath);
  try {
    const errored = await request({
      method: 'POST',
      path: '/api/sepa/export-batch',
      headers: makeAuthHeader(fx.financier),
      body: { date_reference: '2026-08-31', date_prelevement: '2026-09-05' },
    });
    assert.equal(errored.status, 500);
    assert.match(errored.text, /Erreur interne export SEPA/);
    assert.doesNotMatch(errored.text, /XSD SEPA introuvable/);
  } finally {
    fs.renameSync(backupPath, xsdPath);
  }
});

test('POST /api/sepa/export-batch valide aussi les coordonnées créancier configurées côté environnement', async () => {
  const fx = resetFixtures();

  db.prepare(
    `INSERT INTO mandats_sepa (assujetti_id, rum, iban, bic, date_signature, statut)
     VALUES (?, 'RUM-ALPHA-001', 'FR7630006000011234567890189', 'AGRIFRPPXXX', '2026-01-15', 'actif')`,
  ).run(fx.assujettiId);

  const previousIban = process.env.TLPE_SEPA_CREDITOR_IBAN;
  const previousBic = process.env.TLPE_SEPA_CREDITOR_BIC;
  process.env.TLPE_SEPA_CREDITOR_IBAN = 'FR761234';
  process.env.TLPE_SEPA_CREDITOR_BIC = 'BIC-INVALIDE';

  try {
    const errored = await request({
      method: 'POST',
      path: '/api/sepa/export-batch',
      headers: makeAuthHeader(fx.financier),
      body: { date_reference: '2026-08-31', date_prelevement: '2026-09-05' },
    });

    assert.equal(errored.status, 500);
    assert.match(errored.text, /Erreur interne export SEPA/);
    assert.doesNotMatch(errored.text, /IBAN créancier invalide/i);
    assert.doesNotMatch(errored.text, /BIC créancier invalide/i);
  } finally {
    if (previousIban === undefined) {
      delete process.env.TLPE_SEPA_CREDITOR_IBAN;
    } else {
      process.env.TLPE_SEPA_CREDITOR_IBAN = previousIban;
    }

    if (previousBic === undefined) {
      delete process.env.TLPE_SEPA_CREDITOR_BIC;
    } else {
      process.env.TLPE_SEPA_CREDITOR_BIC = previousBic;
    }
  }
});
