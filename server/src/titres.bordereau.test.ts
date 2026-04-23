import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import XLSX from 'xlsx';
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

async function requestBinary(params: {
  method: 'GET';
  path: string;
  headers?: Record<string, string>;
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
      headers: params.headers,
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      headers: {
        contentType: res.headers.get('content-type') || '',
        disposition: res.headers.get('content-disposition') || '',
      },
      buffer,
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

  const typeId = Number(
    db.prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('ENS-BORD', 'Enseigne Bordereau', 'enseigne')`).run()
      .lastInsertRowid,
  );
  const assujettiA = Number(
    db.prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES ('TLPE-B-001', 'Alpha Publicite', 'actif')`).run()
      .lastInsertRowid,
  );
  const assujettiB = Number(
    db.prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES ('TLPE-B-002', 'Beta Enseignes', 'actif')`).run()
      .lastInsertRowid,
  );
  const financierId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES ('financier-bord@tlpe.local', ?, 'Fin', 'Ancier', 'financier', 1)`,
    ).run(hashPassword('x')).lastInsertRowid,
  );
  const contribuableId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, assujetti_id, actif)
       VALUES ('contrib-bord@tlpe.local', ?, 'Contrib', 'Uable', 'contribuable', ?, 1)`,
    ).run(hashPassword('x'), assujettiA).lastInsertRowid,
  );

  const declarationA = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-BORD-2026-001', ?, 2026, 'validee', 1200)`,
    ).run(assujettiA).lastInsertRowid,
  );
  const declarationB = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-BORD-2026-002', ?, 2026, 'validee', 450.5)`,
    ).run(assujettiB).lastInsertRowid,
  );
  const declarationOtherYear = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-BORD-2025-001', ?, 2025, 'validee', 999)`,
    ).run(assujettiA).lastInsertRowid,
  );

  const dispositifA = Number(
    db.prepare(
      `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, adresse_rue, adresse_cp, adresse_ville, statut)
       VALUES ('DSP-BORD-001', ?, ?, 12, 1, '1 rue Alpha', '33000', 'Bordeaux', 'declare')`,
    ).run(assujettiA, typeId).lastInsertRowid,
  );
  const dispositifB = Number(
    db.prepare(
      `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, adresse_rue, adresse_cp, adresse_ville, statut)
       VALUES ('DSP-BORD-002', ?, ?, 4.5, 2, '2 rue Beta', '33000', 'Bordeaux', 'declare')`,
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
     VALUES ('TIT-2026-000002', ?, ?, 2026, 450.5, '2026-04-05', '2026-08-31', 'emis')`,
  ).run(declarationB, assujettiB);
  db.prepare(
    `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut)
     VALUES ('TIT-2025-000001', ?, ?, 2025, 999, '2025-03-01', '2025-08-31', 'emis')`,
  ).run(declarationOtherYear, assujettiA);

  return {
    financier: {
      id: financierId,
      email: 'financier-bord@tlpe.local',
      role: 'financier' as const,
      nom: 'Fin',
      prenom: 'Ancier',
      assujetti_id: null,
    },
    contribuable: {
      id: contribuableId,
      email: 'contrib-bord@tlpe.local',
      role: 'contribuable' as const,
      nom: 'Contrib',
      prenom: 'Uable',
      assujetti_id: assujettiA,
    },
  };
}

test('GET /api/titres/bordereau?annee=2026&format=xlsx exporte un classeur filtre avec hash et audit', async () => {
  const fx = resetFixtures();

  const res = await requestBinary({
    method: 'GET',
    path: '/api/titres/bordereau?annee=2026&format=xlsx',
    headers: makeAuthHeader(fx.financier),
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.contentType, /application\/vnd.openxmlformats-officedocument.spreadsheetml.sheet/);
  assert.match(res.headers.disposition, /bordereau-titres-2026\.xlsx/);

  const workbook = XLSX.read(res.buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }) as Array<Array<string | number>>;

  assert.equal(String(rows[0][0]), 'Bordereau récapitulatif des titres de recettes');
  assert.equal(String(rows[1][1]), '2026');
  assert.equal(String(rows[5][0]), 'Numero');
  assert.equal(String(rows[6][0]), 'TIT-2026-000001');
  assert.equal(String(rows[7][0]), 'TIT-2026-000002');
  assert.equal(String(rows[8][0]), 'TOTAL');
  assert.equal(Number(rows[8][2]), 1650.5);
  assert.match(String(rows[3][1]), /^[a-f0-9]{64}$/);

  const audit = db.prepare("SELECT action, entite, details FROM audit_log WHERE action = 'export-bordereau'").get() as
    | { action: string; entite: string; details: string }
    | undefined;
  assert.ok(audit);
  assert.equal(audit!.entite, 'titre');
  assert.match(audit!.details, /\"annee\":2026/);
  assert.match(audit!.details, /\"format\":\"xlsx\"/);
});

test('GET /api/titres/bordereau?annee=2026&format=pdf retourne un PDF et refuse le role contribuable', async () => {
  const fx = resetFixtures();

  const forbidden = await requestBinary({
    method: 'GET',
    path: '/api/titres/bordereau?annee=2026&format=pdf',
    headers: makeAuthHeader(fx.contribuable),
  });
  assert.equal(forbidden.status, 403);

  const res = await requestBinary({
    method: 'GET',
    path: '/api/titres/bordereau?annee=2026&format=pdf',
    headers: makeAuthHeader(fx.financier),
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.contentType, /application\/pdf/);
  assert.match(res.headers.disposition, /bordereau-titres-2026\.pdf/);
  assert.equal(res.buffer.subarray(0, 4).toString('utf8'), '%PDF');
});

test('GET /api/titres/bordereau valide les paramètres requis', async () => {
  const fx = resetFixtures();

  const missingYear = await requestBinary({
    method: 'GET',
    path: '/api/titres/bordereau?format=pdf',
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(missingYear.status, 400);

  const invalidFormat = await requestBinary({
    method: 'GET',
    path: '/api/titres/bordereau?annee=2026&format=csv',
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(invalidFormat.status, 400);
});
