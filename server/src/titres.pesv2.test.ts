import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import express from 'express';
import { db, initSchema } from './db';
import { hashPassword, signToken, type AuthUser } from './auth';
import { titresRouter } from './routes/titres';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/titres', titresRouter);
  return app;
}

function makeAuthHeader(user: AuthUser): Record<string, string> {
  return { Authorization: `Bearer ${signToken(user)}` };
}

async function request(params: {
  method: 'POST';
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
        'Content-Type': 'application/json',
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

function resetFixtures() {
  initSchema();
  db.exec('DELETE FROM declaration_receipts');
  db.exec('DELETE FROM notifications_email');
  db.exec('DELETE FROM invitation_magic_links');
  db.exec('DELETE FROM campagne_jobs');
  db.exec('DELETE FROM mises_en_demeure');
  db.exec('DELETE FROM paiements');
  const hasPesv2Exports = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pesv2_exports'").get() as
      | { name: string }
      | undefined
  )?.name === 'pesv2_exports';
  if (hasPesv2Exports) {
    db.exec('DELETE FROM pesv2_export_titres');
    db.exec('DELETE FROM pesv2_exports');
  }
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
    db.prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('ENS-PES', 'Enseigne PES', 'enseigne')`).run()
      .lastInsertRowid,
  );

  const financierId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES ('financier-pes@tlpe.local', ?, 'Fin', 'Pes', 'financier', 1)`,
    ).run(hashPassword('x')).lastInsertRowid,
  );

  const assujettiA = Number(
    db.prepare(
      `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, siret, statut)
       VALUES ('TLPE-PES-001', 'Alpha Publicite', '12345678901234', 'actif')`,
    ).run().lastInsertRowid,
  );
  const assujettiB = Number(
    db.prepare(
      `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, siret, statut)
       VALUES ('TLPE-PES-002', 'Beta Enseignes', '22345678901234', 'actif')`,
    ).run().lastInsertRowid,
  );

  const campagneId = Number(
    db.prepare(
      `INSERT INTO campagnes (annee, date_ouverture, date_limite_declaration, date_cloture, statut, created_by)
       VALUES (2026, '2026-01-01', '2026-03-31', '2026-04-30', 'cloturee', ?)`,
    ).run(financierId).lastInsertRowid,
  );

  const declarationA = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-PES-2026-001', ?, 2026, 'validee', 1200)`,
    ).run(assujettiA).lastInsertRowid,
  );
  const declarationB = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-PES-2026-002', ?, 2026, 'validee', 450.5)`,
    ).run(assujettiB).lastInsertRowid,
  );
  const declarationOtherYear = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-PES-2025-001', ?, 2025, 'validee', 999)`,
    ).run(assujettiA).lastInsertRowid,
  );

  const dispositifA = Number(
    db.prepare(
      `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, statut)
       VALUES ('DSP-PES-001', ?, ?, 12, 1, 'declare')`,
    ).run(assujettiA, typeId).lastInsertRowid,
  );
  const dispositifB = Number(
    db.prepare(
      `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, statut)
       VALUES ('DSP-PES-002', ?, ?, 4.5, 2, 'declare')`,
    ).run(assujettiB, typeId).lastInsertRowid,
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
    `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut)
     VALUES ('TIT-2026-000001', ?, ?, 2026, 1200, '2026-04-01', '2026-08-31', 'emis')`,
  ).run(declarationA, assujettiA);
  db.prepare(
    `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut)
     VALUES ('TIT-2026-000002', ?, ?, 2026, 450.5, '2026-05-10', '2026-08-31', 'emis')`,
  ).run(declarationB, assujettiB);
  db.prepare(
    `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut)
     VALUES ('TIT-2025-000001', ?, ?, 2025, 999, '2025-03-01', '2025-08-31', 'emis')`,
  ).run(declarationOtherYear, assujettiA);

  return {
    campagneId,
    financier: {
      id: financierId,
      email: 'financier-pes@tlpe.local',
      role: 'financier' as const,
      nom: 'Fin',
      prenom: 'Pes',
      assujetti_id: null,
    },
  };
}

test('POST /api/titres/export-pesv2 exporte un XML PESV2 valide pour une campagne avec journalisation et bordereau incrémental', async () => {
  const fx = resetFixtures();

  const res = await request({
    method: 'POST',
    path: '/api/titres/export-pesv2',
    headers: makeAuthHeader(fx.financier),
    body: { campagne_id: fx.campagneId },
  });

  assert.equal(res.status, 200);
  assert.match(res.contentType, /xml/);
  assert.match(res.disposition, /pesv2-000001\.xml/);
  assert.match(res.text, /<NumeroBordereau>000001<\/NumeroBordereau>/);
  assert.match(res.text, /<NumeroTitre>TIT-2026-000001<\/NumeroTitre>/);
  assert.match(res.text, /<NumeroTitre>TIT-2026-000002<\/NumeroTitre>/);
  assert.doesNotMatch(res.text, /TIT-2025-000001/);
  assert.match(res.text, /<HorodatageExport>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z<\/HorodatageExport>/);

  const exportLog = db.prepare('SELECT numero_bordereau, selection_type, xsd_validation_ok FROM pesv2_exports').get() as
    | { numero_bordereau: number; selection_type: string; xsd_validation_ok: number }
    | undefined;
  assert.ok(exportLog);
  assert.equal(exportLog!.numero_bordereau, 1);
  assert.equal(exportLog!.selection_type, 'campagne');
  assert.equal(exportLog!.xsd_validation_ok, 1);

  const audit = db.prepare("SELECT action, details FROM audit_log WHERE action = 'export-pesv2'").get() as
    | { action: string; details: string }
    | undefined;
  assert.ok(audit);
  assert.match(audit!.details, /\"numero_bordereau\":1/);
});

test('POST /api/titres/export-pesv2 bloque un ré-export sans confirmation puis autorise avec bordereau suivant', async () => {
  const fx = resetFixtures();

  const first = await request({
    method: 'POST',
    path: '/api/titres/export-pesv2',
    headers: makeAuthHeader(fx.financier),
    body: { campagne_id: fx.campagneId },
  });
  assert.equal(first.status, 200);

  const blocked = await request({
    method: 'POST',
    path: '/api/titres/export-pesv2',
    headers: makeAuthHeader(fx.financier),
    body: { campagne_id: fx.campagneId },
  });
  assert.equal(blocked.status, 409);
  assert.match(blocked.text, /déjà exporté/i);

  const confirmed = await request({
    method: 'POST',
    path: '/api/titres/export-pesv2',
    headers: makeAuthHeader(fx.financier),
    body: { campagne_id: fx.campagneId, confirm_reexport: true },
  });
  assert.equal(confirmed.status, 200);
  assert.match(confirmed.text, /<NumeroBordereau>000002<\/NumeroBordereau>/);
});

test('POST /api/titres/export-pesv2 supporte une sélection par période de date d\'émission', async () => {
  const fx = resetFixtures();

  const res = await request({
    method: 'POST',
    path: '/api/titres/export-pesv2',
    headers: makeAuthHeader(fx.financier),
    body: { date_debut: '2026-04-01', date_fin: '2026-04-30' },
  });

  assert.equal(res.status, 200);
  assert.match(res.text, /TIT-2026-000001/);
  assert.doesNotMatch(res.text, /TIT-2026-000002/);
  assert.doesNotMatch(res.text, /TIT-2025-000001/);
});

test('POST /api/titres/export-pesv2 valide les sélections campagne/période exclusives et complètes', async () => {
  const fx = resetFixtures();

  const mixedSelection = await request({
    method: 'POST',
    path: '/api/titres/export-pesv2',
    headers: makeAuthHeader(fx.financier),
    body: { campagne_id: fx.campagneId, date_debut: '2026-04-01', date_fin: '2026-04-30' },
  });
  assert.equal(mixedSelection.status, 400);
  assert.match(mixedSelection.text, /campagne_id|date_debut|date_fin/i);

  const missingDateFin = await request({
    method: 'POST',
    path: '/api/titres/export-pesv2',
    headers: makeAuthHeader(fx.financier),
    body: { date_debut: '2026-04-01' },
  });
  assert.equal(missingDateFin.status, 400);
  assert.match(missingDateFin.text, /date_debut et date_fin sont requis/i);

  const reversedPeriod = await request({
    method: 'POST',
    path: '/api/titres/export-pesv2',
    headers: makeAuthHeader(fx.financier),
    body: { date_debut: '2026-05-01', date_fin: '2026-04-01' },
  });
  assert.equal(reversedPeriod.status, 400);
  assert.match(reversedPeriod.text, /date_debut doit être antérieure ou égale à date_fin/i);
});

test('POST /api/titres/export-pesv2 retourne 404 quand une période valide ne contient aucun titre', async () => {
  const fx = resetFixtures();

  const res = await request({
    method: 'POST',
    path: '/api/titres/export-pesv2',
    headers: makeAuthHeader(fx.financier),
    body: { date_debut: '2035-01-01', date_fin: '2035-01-31' },
  });

  assert.equal(res.status, 404);
  assert.match(res.text, /Aucun titre à exporter/i);
});

test('POST /api/titres/export-pesv2 rejette une date de période invalide au format calendrier', async () => {
  const fx = resetFixtures();

  const res = await request({
    method: 'POST',
    path: '/api/titres/export-pesv2',
    headers: makeAuthHeader(fx.financier),
    body: { date_debut: '2026-02-31', date_fin: '2026-04-30' },
  });

  assert.equal(res.status, 400);
  assert.match(res.text, /Date invalide: 2026-02-31/);
});

test('POST /api/titres/export-pesv2 retourne 500 générique si le schéma XSD est indisponible', async () => {
  const fx = resetFixtures();
  const xsdPath = path.join(__dirname, 'xsd', 'pesv2-titres.xsd');
  const backupPath = path.join(__dirname, 'xsd', 'pesv2-titres.xsd.bak');

  fs.renameSync(xsdPath, backupPath);
  try {
    const res = await request({
      method: 'POST',
      path: '/api/titres/export-pesv2',
      headers: makeAuthHeader(fx.financier),
      body: { campagne_id: fx.campagneId },
    });

    assert.equal(res.status, 500);
    assert.match(res.text, /Erreur interne export PESV2/);
    assert.doesNotMatch(res.text, /Schéma XSD PESV2 introuvable/);
  } finally {
    fs.renameSync(backupPath, xsdPath);
  }
});

test('POST /api/titres/export-pesv2 retourne 400 pour une campagne non clôturée', async () => {
  const fx = resetFixtures();
  db.prepare("UPDATE campagnes SET statut = 'ouverte' WHERE id = ?").run(fx.campagneId);

  const res = await request({
    method: 'POST',
    path: '/api/titres/export-pesv2',
    headers: makeAuthHeader(fx.financier),
    body: { campagne_id: fx.campagneId },
  });

  assert.equal(res.status, 400);
  assert.match(res.text, /campagnes clôturées/i);
});

test('POST /api/titres/export-pesv2 retourne 404 pour une campagne introuvable', async () => {
  const fx = resetFixtures();

  const res = await request({
    method: 'POST',
    path: '/api/titres/export-pesv2',
    headers: makeAuthHeader(fx.financier),
    body: { campagne_id: fx.campagneId + 999 },
  });

  assert.equal(res.status, 404);
  assert.match(res.text, /Campagne introuvable/);
});

test('POST /api/titres/export-pesv2 retourne 400 pour une date ISO malformée qui passe le regex', async () => {
  const fx = resetFixtures();

  const res = await request({
    method: 'POST',
    path: '/api/titres/export-pesv2',
    headers: makeAuthHeader(fx.financier),
    body: { date_debut: '2026-04-01', date_fin: '2026-13-01' },
  });

  assert.equal(res.status, 400);
  assert.match(res.text, /Date invalide: 2026-13-01/);
});
