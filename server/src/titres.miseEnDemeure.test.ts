import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { db, initSchema } from './db';
import { hashPassword, signToken, type AuthUser } from './auth';
import { titresRouter } from './routes/titres';
import { piecesJointesRouter } from './routes/piecesJointes';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/titres', titresRouter);
  app.use('/api/pieces-jointes', piecesJointesRouter);
  return app;
}

function makeAuthHeader(user: AuthUser): Record<string, string> {
  return { Authorization: `Bearer ${signToken(user)}` };
}

async function request(params: {
  method: 'GET' | 'POST' | 'DELETE';
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
    const contentTypeHeader = params.body ? { 'Content-Type': 'application/json' } : {};
    const res = await fetch(`http://127.0.0.1:${address.port}${params.path}`, {
      method: params.method,
      headers: {
        ...contentTypeHeader,
        ...(params.headers || {}),
      },
      body: params.body ? JSON.stringify(params.body) : undefined,
    });

    const contentType = res.headers.get('content-type') || '';
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const text = contentType.includes('application/pdf') ? '' : buffer.toString('utf8');
    return {
      status: res.status,
      contentType,
      text,
      buffer,
      json: contentType.includes('application/json') && text ? JSON.parse(text) : null,
    };
  } finally {
    server.close();
  }
}

async function requestJson(params: {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}) {
  return request(params);
}

function resetFixtures() {
  initSchema();
  const uploadsRoot = path.resolve(__dirname, '..', 'data', 'uploads');
  fs.rmSync(path.join(uploadsRoot, 'mises_en_demeure_titres'), { recursive: true, force: true });
  const hasTitreMisesEnDemeure = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'titre_mises_en_demeure'").get() as
      | { name: string }
      | undefined
  )?.name === 'titre_mises_en_demeure';
  if (hasTitreMisesEnDemeure) {
    db.exec('DELETE FROM titre_mises_en_demeure_sequences');
    db.exec('DELETE FROM titre_mises_en_demeure');
  }
  db.exec('DELETE FROM declaration_receipts');
  db.exec('DELETE FROM notifications_email');
  db.exec('DELETE FROM invitation_magic_links');
  db.exec('DELETE FROM campagne_jobs');
  db.exec('DELETE FROM mises_en_demeure');
  db.exec('DELETE FROM paiements');
  db.exec('DELETE FROM pesv2_export_titres');
  db.exec('DELETE FROM pesv2_exports');
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
    db.prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('ENS-MED', 'Enseigne MED', 'enseigne')`).run()
      .lastInsertRowid,
  );

  const financierId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES ('financier-med@tlpe.local', ?, 'Fin', 'Med', 'financier', 1)`,
    ).run(hashPassword('x')).lastInsertRowid,
  );

  const assujettiA = Number(
    db.prepare(
      `INSERT INTO assujettis (
        identifiant_tlpe, raison_sociale, siret, adresse_rue, adresse_cp, adresse_ville, email, statut
      ) VALUES ('TLPE-MED-001', 'Alpha Publicite', '32345678901234', '1 rue Alpha', '33000', 'Bordeaux', 'alpha@example.test', 'actif')`,
    ).run().lastInsertRowid,
  );
  const assujettiB = Number(
    db.prepare(
      `INSERT INTO assujettis (
        identifiant_tlpe, raison_sociale, siret, adresse_rue, adresse_cp, adresse_ville, email, statut
      ) VALUES ('TLPE-MED-002', 'Beta Enseignes', '42345678901234', '2 rue Beta', '33000', 'Bordeaux', 'beta@example.test', 'actif')`,
    ).run().lastInsertRowid,
  );

  const declarationA = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-MED-2026-001', ?, 2026, 'validee', 1200)`,
    ).run(assujettiA).lastInsertRowid,
  );
  const declarationB = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-MED-2026-002', ?, 2026, 'validee', 450.5)`,
    ).run(assujettiB).lastInsertRowid,
  );

  const dispositifA = Number(
    db.prepare(
      `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, statut)
       VALUES ('DSP-MED-001', ?, ?, 12, 1, 'declare')`,
    ).run(assujettiA, typeId).lastInsertRowid,
  );
  const dispositifB = Number(
    db.prepare(
      `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, statut)
       VALUES ('DSP-MED-002', ?, ?, 8, 2, 'declare')`,
    ).run(assujettiB, typeId).lastInsertRowid,
  );

  db.prepare(
    `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne)
     VALUES (?, ?, 12, 1, '2026-01-01', 1200)`,
  ).run(declarationA, dispositifA);
  db.prepare(
    `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne)
     VALUES (?, ?, 8, 2, '2026-01-01', 450.5)`,
  ).run(declarationB, dispositifB);

  const titreA = Number(
    db.prepare(
      `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, montant_paye, date_emission, date_echeance, statut)
       VALUES ('TIT-MED-2026-000001', ?, ?, 2026, 1200, 0, '2026-04-01', '2026-08-31', 'impaye')`,
    ).run(declarationA, assujettiA).lastInsertRowid,
  );
  const titreB = Number(
    db.prepare(
      `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, montant_paye, date_emission, date_echeance, statut)
       VALUES ('TIT-MED-2026-000002', ?, ?, 2026, 450.5, 100, '2026-04-05', '2026-08-31', 'paye_partiel')`,
    ).run(declarationB, assujettiB).lastInsertRowid,
  );

  return {
    titreA,
    titreB,
    financier: {
      id: financierId,
      email: 'financier-med@tlpe.local',
      role: 'financier' as const,
      nom: 'Fin',
      prenom: 'Med',
      assujetti_id: null,
    },
  };
}

test('POST /api/titres/:id/mise-en-demeure genere un PDF, stocke la piece jointe et passe le titre en mise_en_demeure', async () => {
  const fx = resetFixtures();

  const res = await requestJson({
    method: 'POST',
    path: `/api/titres/${fx.titreA}/mise-en-demeure`,
    headers: makeAuthHeader(fx.financier),
  });

  assert.equal(res.status, 201);
  assert.equal(res.json?.numero, 'MED-2026-000001');
  assert.equal(res.json?.titre_id, fx.titreA);
  assert.match(String(res.json?.download_url), /^\/api\/pieces-jointes\/\d+$/);

  const titre = db.prepare('SELECT statut FROM titres WHERE id = ?').get(fx.titreA) as { statut: string } | undefined;
  assert.equal(titre?.statut, 'mise_en_demeure');

  const piece = db.prepare('SELECT entite, entite_id, mime_type, chemin FROM pieces_jointes WHERE id = ?').get(res.json?.piece_jointe_id) as
    | { entite: string; entite_id: number; mime_type: string; chemin: string }
    | undefined;
  assert.ok(piece);
  assert.equal(piece?.entite, 'titre');
  assert.equal(piece?.entite_id, fx.titreA);
  assert.equal(piece?.mime_type, 'application/pdf');
  assert.match(piece?.chemin ?? '', /mises_en_demeure_titres/);

  const piecePath = path.resolve(__dirname, '..', 'data', 'uploads', piece?.chemin ?? '');
  assert.ok(fs.existsSync(piecePath));

  const med = db.prepare('SELECT numero, titre_id, piece_jointe_id FROM titre_mises_en_demeure WHERE titre_id = ?').get(fx.titreA) as
    | { numero: string; titre_id: number; piece_jointe_id: number }
    | undefined;
  assert.ok(med);
  assert.equal(med?.numero, 'MED-2026-000001');
  assert.equal(med?.piece_jointe_id, res.json?.piece_jointe_id);

  const secondRes = await requestJson({
    method: 'POST',
    path: `/api/titres/${fx.titreA}/mise-en-demeure`,
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(secondRes.status, 201);
  assert.equal(secondRes.json?.numero, 'MED-2026-000001');
  assert.equal(secondRes.json?.piece_jointe_id, res.json?.piece_jointe_id);

  const audit = db.prepare("SELECT action, details FROM audit_log WHERE action = 'generate-mise-en-demeure'").get() as
    | { action: string; details: string }
    | undefined;
  assert.ok(audit);
  assert.match(audit?.details ?? '', /MED-2026-000001/);
});

test('POST /api/titres/:id/mise-en-demeure permet au financier de telecharger le PDF genere', async () => {
  const fx = resetFixtures();

  const generationRes = await requestJson({
    method: 'POST',
    path: `/api/titres/${fx.titreA}/mise-en-demeure`,
    headers: makeAuthHeader(fx.financier),
  });

  assert.equal(generationRes.status, 201);

  const downloadRes = await request({
    method: 'GET',
    path: String(generationRes.json?.download_url),
    headers: makeAuthHeader(fx.financier),
  });

  assert.equal(downloadRes.status, 200);
  assert.match(downloadRes.contentType, /application\/pdf/i);
  assert.ok(downloadRes.buffer.length > 0);
  assert.equal(downloadRes.buffer.subarray(0, 5).toString('utf8'), '%PDF-');
});

test('POST /api/titres/mises-en-demeure/batch est atomique si un titre est introuvable', async () => {
  const fx = resetFixtures();

  const res = await requestJson({
    method: 'POST',
    path: '/api/titres/mises-en-demeure/batch',
    headers: makeAuthHeader(fx.financier),
    body: { titre_ids: [fx.titreA, 999999] },
  });

  assert.equal(res.status, 404);
  const count = (db.prepare('SELECT COUNT(*) AS c FROM titre_mises_en_demeure').get() as { c: number }).c;
  assert.equal(count, 0);
  const titre = db.prepare('SELECT statut FROM titres WHERE id = ?').get(fx.titreA) as { statut: string } | undefined;
  assert.equal(titre?.statut, 'impaye');
});

test('POST /api/titres/mises-en-demeure/batch est atomique si un titre est deja solde', async () => {
  const fx = resetFixtures();
  db.prepare("UPDATE titres SET montant_paye = montant, statut = 'paye' WHERE id = ?").run(fx.titreB);

  const res = await requestJson({
    method: 'POST',
    path: '/api/titres/mises-en-demeure/batch',
    headers: makeAuthHeader(fx.financier),
    body: { titre_ids: [fx.titreA, fx.titreB] },
  });

  assert.equal(res.status, 409);
  assert.match(res.text, /solde|paye/i);

  const count = (db.prepare('SELECT COUNT(*) AS c FROM titre_mises_en_demeure').get() as { c: number }).c;
  assert.equal(count, 0);
  const titres = db.prepare('SELECT id, statut FROM titres ORDER BY id').all() as Array<{ id: number; statut: string }>;
  assert.deepEqual(titres.map((row) => row.statut), ['impaye', 'paye']);
});

test('GET et DELETE /api/pieces-jointes/:id refusent au financier l acces aux pieces non liees a un titre', async () => {
  const fx = resetFixtures();
  const declarationId = Number((db.prepare('SELECT id FROM declarations ORDER BY id LIMIT 1').get() as { id: number }).id);
  const relativePath = 'declaration/test/attestation.pdf';
  const absolutePath = path.resolve(__dirname, '..', 'data', 'uploads', relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, Buffer.from('%PDF-1.4\nforbidden\n', 'utf8'));

  const pieceId = Number(
    db
      .prepare(
        `INSERT INTO pieces_jointes (entite, entite_id, nom, mime_type, taille, chemin, uploaded_by)
         VALUES ('declaration', ?, 'attestation.pdf', 'application/pdf', ?, ?, ?)`,
      )
      .run(declarationId, Buffer.byteLength('%PDF-1.4\nforbidden\n', 'utf8'), relativePath, fx.financier.id).lastInsertRowid,
  );

  const downloadRes = await request({
    method: 'GET',
    path: `/api/pieces-jointes/${pieceId}`,
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(downloadRes.status, 403);

  const deleteRes = await request({
    method: 'DELETE',
    path: `/api/pieces-jointes/${pieceId}`,
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(deleteRes.status, 403);

  const deletedAt = (db.prepare('SELECT deleted_at FROM pieces_jointes WHERE id = ?').get(pieceId) as { deleted_at: string | null }).deleted_at;
  assert.equal(deletedAt, null);
});

test('POST /api/titres/:id/mise-en-demeure regenere un PDF si l ancienne piece jointe a ete supprimee logiquement', async () => {
  const fx = resetFixtures();

  const firstRes = await requestJson({
    method: 'POST',
    path: `/api/titres/${fx.titreA}/mise-en-demeure`,
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(firstRes.status, 201);

  const deleteRes = await request({
    method: 'DELETE',
    path: `/api/pieces-jointes/${firstRes.json?.piece_jointe_id}`,
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(deleteRes.status, 204);

  const secondRes = await requestJson({
    method: 'POST',
    path: `/api/titres/${fx.titreA}/mise-en-demeure`,
    headers: makeAuthHeader(fx.financier),
  });

  assert.equal(secondRes.status, 201);
  assert.notEqual(secondRes.json?.piece_jointe_id, firstRes.json?.piece_jointe_id);
  assert.notEqual(secondRes.json?.numero, firstRes.json?.numero);
});

test('POST /api/titres/mises-en-demeure/batch genere un lot avec numerotation unique et statuts mis a jour', async () => {
  const fx = resetFixtures();

  const res = await requestJson({
    method: 'POST',
    path: '/api/titres/mises-en-demeure/batch',
    headers: makeAuthHeader(fx.financier),
    body: { titre_ids: [fx.titreA, fx.titreB] },
  });

  assert.equal(res.status, 201);
  assert.equal(res.json?.count, 2);
  assert.deepEqual(
    (res.json?.items || []).map((item: { numero: string }) => item.numero),
    ['MED-2026-000001', 'MED-2026-000002'],
  );

  const rows = db.prepare('SELECT numero, titre_id, mode FROM titre_mises_en_demeure ORDER BY numero').all() as Array<{
    numero: string;
    titre_id: number;
    mode: string;
  }>;
  assert.deepEqual(rows, [
    { numero: 'MED-2026-000001', titre_id: fx.titreA, mode: 'batch' },
    { numero: 'MED-2026-000002', titre_id: fx.titreB, mode: 'batch' },
  ]);

  const titres = db.prepare('SELECT id, statut FROM titres ORDER BY id').all() as Array<{ id: number; statut: string }>;
  assert.deepEqual(titres.map((row) => row.statut), ['mise_en_demeure', 'mise_en_demeure']);
});

test('POST /api/titres/:id/mise-en-demeure refuse un titre deja solde', async () => {
  const fx = resetFixtures();
  db.prepare("UPDATE titres SET montant_paye = montant, statut = 'paye' WHERE id = ?").run(fx.titreA);

  const res = await requestJson({
    method: 'POST',
    path: `/api/titres/${fx.titreA}/mise-en-demeure`,
    headers: makeAuthHeader(fx.financier),
  });

  assert.equal(res.status, 409);
  assert.match(res.text, /solde|paye/i);
});
