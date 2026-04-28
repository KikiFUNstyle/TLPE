import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import XLSX from 'xlsx';
import { db, initSchema } from './db';
import { hashPassword, signToken, type AuthUser } from './auth';
import { resolveUploadAbsolutePath } from './routes/piecesJointes';
import { rapportsRouter } from './routes/rapports';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/rapports', rapportsRouter);
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
  db.exec('DELETE FROM rapports_exports');
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
  db.exec('DELETE FROM controles');
  db.exec('DELETE FROM dispositifs');
  db.exec('DELETE FROM campagnes');
  db.exec('DELETE FROM audit_log');
  db.exec('DELETE FROM users');
  db.exec('DELETE FROM assujettis');
  db.exec('DELETE FROM types_dispositifs');

  const typeId = Number(
    db.prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('ENS-ROLE', 'Enseigne Role', 'enseigne')`).run()
      .lastInsertRowid,
  );
  const assujettiA = Number(
    db.prepare(
      `INSERT INTO assujettis (
        identifiant_tlpe, raison_sociale, siret, adresse_rue, adresse_cp, adresse_ville, statut
      ) VALUES ('TLPE-R-001', 'Alpha Publicite', '12345678901234', '1 rue Alpha', '33000', 'Bordeaux', 'actif')`,
    ).run().lastInsertRowid,
  );
  const assujettiB = Number(
    db.prepare(
      `INSERT INTO assujettis (
        identifiant_tlpe, raison_sociale, siret, adresse_rue, adresse_cp, adresse_ville, statut
      ) VALUES ('TLPE-R-002', 'Beta Enseignes', '10987654321098', '2 avenue Beta', '33100', 'Bordeaux', 'actif')`,
    ).run().lastInsertRowid,
  );
  const financierId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES ('financier-role@tlpe.local', ?, 'Fin', 'Ancier', 'financier', 1)`,
    ).run(hashPassword('x')).lastInsertRowid,
  );
  const contribuableId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, assujetti_id, actif)
       VALUES ('contrib-role@tlpe.local', ?, 'Contrib', 'Uable', 'contribuable', ?, 1)`,
    ).run(hashPassword('x'), assujettiA).lastInsertRowid,
  );

  const declarationA = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-ROLE-2026-001', ?, 2026, 'validee', 1200)`,
    ).run(assujettiA).lastInsertRowid,
  );
  const declarationB = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-ROLE-2026-002', ?, 2026, 'validee', 450.5)`,
    ).run(assujettiB).lastInsertRowid,
  );

  const dispositifA1 = Number(
    db.prepare(
      `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, adresse_rue, adresse_cp, adresse_ville, statut)
       VALUES ('DSP-ROLE-001', ?, ?, 12, 1, '1 rue Alpha', '33000', 'Bordeaux', 'declare')`,
    ).run(assujettiA, typeId).lastInsertRowid,
  );
  const dispositifA2 = Number(
    db.prepare(
      `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, adresse_rue, adresse_cp, adresse_ville, statut)
       VALUES ('DSP-ROLE-002', ?, ?, 6, 1, '1 rue Alpha', '33000', 'Bordeaux', 'controle')`,
    ).run(assujettiA, typeId).lastInsertRowid,
  );
  const dispositifB1 = Number(
    db.prepare(
      `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, adresse_rue, adresse_cp, adresse_ville, statut)
       VALUES ('DSP-ROLE-003', ?, ?, 4.5, 2, '2 avenue Beta', '33100', 'Bordeaux', 'declare')`,
    ).run(assujettiB, typeId).lastInsertRowid,
  );

  db.prepare(
    `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne)
     VALUES (?, ?, 12, 1, '2026-01-01', 800)`,
  ).run(declarationA, dispositifA1);
  db.prepare(
    `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne)
     VALUES (?, ?, 6, 1, '2026-01-15', 400)`,
  ).run(declarationA, dispositifA2);
  db.prepare(
    `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne)
     VALUES (?, ?, 4.5, 2, '2026-02-01', 450.5)`,
  ).run(declarationB, dispositifB1);

  const titreA = Number(
    db.prepare(
      `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, montant_paye, date_emission, date_echeance, statut)
       VALUES ('TIT-2026-000010', ?, ?, 2026, 1200, 300, '2026-04-01', '2026-08-31', 'paye_partiel')`,
    ).run(declarationA, assujettiA).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO paiements (titre_id, montant, date_paiement, modalite, provider, statut, reference)
     VALUES (?, 300, '2026-05-10', 'virement', 'manuel', 'confirme', 'PAY-ROLE-1')`,
  ).run(titreA);
  db.prepare(
    `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, montant_paye, date_emission, date_echeance, statut)
     VALUES ('TIT-2026-000011', ?, ?, 2026, 450.5, 0, '2026-04-05', '2026-08-31', 'emis')`,
  ).run(declarationB, assujettiB);

  return {
    financier: {
      id: financierId,
      email: 'financier-role@tlpe.local',
      role: 'financier' as const,
      nom: 'Fin',
      prenom: 'Ancier',
      assujetti_id: null,
    },
    contribuable: {
      id: contribuableId,
      email: 'contrib-role@tlpe.local',
      role: 'contribuable' as const,
      nom: 'Contrib',
      prenom: 'Uable',
      assujetti_id: assujettiA,
    },
  };
}

test('GET /api/rapports/role?annee=2026&format=xlsx exporte le role TLPE detaille et archive chaque generation', async () => {
  const fx = resetFixtures();

  const first = await requestBinary({
    method: 'GET',
    path: '/api/rapports/role?annee=2026&format=xlsx',
    headers: makeAuthHeader(fx.financier),
  });
  const second = await requestBinary({
    method: 'GET',
    path: '/api/rapports/role?annee=2026&format=xlsx',
    headers: makeAuthHeader(fx.financier),
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.match(first.headers.contentType, /application\/vnd.openxmlformats-officedocument.spreadsheetml.sheet/);
  assert.match(first.headers.disposition, /role-tlpe-2026\.xlsx/);

  const workbook = XLSX.read(first.buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }) as Array<Array<string | number>>;

  assert.equal(String(rows[0][0]), 'Rôle de la TLPE');
  assert.equal(String(rows[1][1]), '2026');
  assert.equal(String(rows[5][0]), 'N° titre');
  assert.equal(String(rows[5][1]), 'Débiteur');
  assert.equal(String(rows[5][2]), 'SIRET');
  assert.equal(String(rows[5][3]), 'Adresse');
  assert.equal(String(rows[5][4]), 'Dispositifs');
  assert.equal(String(rows[5][5]), 'Montant');
  assert.equal(String(rows[5][6]), 'Statut paiement');
  assert.equal(String(rows[6][0]), 'TIT-2026-000010');
  assert.match(String(rows[6][4]), /DSP-ROLE-001/);
  assert.match(String(rows[6][4]), /DSP-ROLE-002/);
  assert.equal(Number(rows[8][5]), 1650.5);
  assert.equal(String(rows[11][0]), 'Signature ordonnateur');

  const audit = db.prepare("SELECT action, entite, details FROM audit_log WHERE action = 'export-role-tlpe' ORDER BY id DESC LIMIT 1").get() as
    | { action: string; entite: string; details: string }
    | undefined;
  assert.ok(audit);
  assert.equal(audit!.entite, 'rapport');
  assert.match(audit!.details, /\"annee\":2026/);
  assert.match(audit!.details, /\"format\":\"xlsx\"/);

  const archives = db.prepare(
    `SELECT format, annee, filename, storage_path, content_hash, titres_count, total_montant
     FROM rapports_exports
     WHERE type_rapport = 'role_tlpe'
     ORDER BY id`,
  ).all() as Array<{
    format: string;
    annee: number;
    filename: string;
    storage_path: string;
    content_hash: string;
    titres_count: number;
    total_montant: number;
  }>;
  assert.equal(archives.length, 2);
  assert.equal(archives[0].annee, 2026);
  assert.equal(archives[0].format, 'xlsx');
  assert.match(archives[0].filename, /^role-tlpe-2026\.xlsx$/);
  assert.match(archives[0].storage_path, /rapports\/role_tlpe\/2026\//);
  assert.match(archives[0].content_hash, /^[a-f0-9]{64}$/);
  assert.equal(archives[0].titres_count, 2);
  assert.equal(archives[0].total_montant, 1650.5);
});

test('GET /api/rapports/role?annee=2026&format=pdf retourne un PDF et refuse le role contribuable', async () => {
  const fx = resetFixtures();

  const forbidden = await requestBinary({
    method: 'GET',
    path: '/api/rapports/role?annee=2026&format=pdf',
    headers: makeAuthHeader(fx.contribuable),
  });
  assert.equal(forbidden.status, 403);

  const res = await requestBinary({
    method: 'GET',
    path: '/api/rapports/role?annee=2026&format=pdf',
    headers: makeAuthHeader(fx.financier),
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.contentType, /application\/pdf/);
  assert.match(res.headers.disposition, /role-tlpe-2026\.pdf/);
  assert.equal(res.buffer.subarray(0, 4).toString('utf8'), '%PDF');
});

test('GET /api/rapports/role nettoie le fichier archivé si la persistance SQL échoue', async () => {
  const fx = resetFixtures();

  const previousPrepare = db.prepare.bind(db);
  let forcedOnce = false;
  // @ts-ignore test monkey patch for fault injection
  db.prepare = ((sql: string) => {
    if (!forcedOnce && sql.includes('INSERT INTO rapports_exports')) {
      forcedOnce = true;
      throw new Error('disk I/O error');
    }
    return previousPrepare(sql);
  }) as typeof db.prepare;

  const roleDir = resolveUploadAbsolutePath('rapports/role_tlpe/2026');
  fs.rmSync(roleDir, { recursive: true, force: true });

  try {
    const res = await requestBinary({
      method: 'GET',
      path: '/api/rapports/role?annee=2026&format=pdf',
      headers: makeAuthHeader(fx.financier),
    });

    assert.equal(res.status, 500);
    const archives = db.prepare(`SELECT storage_path FROM rapports_exports WHERE type_rapport = 'role_tlpe'`).all() as Array<{ storage_path: string }>;
    assert.equal(archives.length, 0);

    const remainingFiles = fs.existsSync(roleDir) ? fs.readdirSync(roleDir) : [];
    assert.equal(remainingFiles.length, 0);
  } finally {
    // @ts-ignore restore monkey patch after fault injection
    db.prepare = previousPrepare;
  }
});

test('GET /api/rapports/role valide les paramètres requis', async () => {
  const fx = resetFixtures();

  const missingYear = await requestBinary({
    method: 'GET',
    path: '/api/rapports/role?format=pdf',
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(missingYear.status, 400);

  const invalidFormat = await requestBinary({
    method: 'GET',
    path: '/api/rapports/role?annee=2026&format=csv',
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(invalidFormat.status, 400);
});
