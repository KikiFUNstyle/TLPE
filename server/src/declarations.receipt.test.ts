import test from 'node:test';
import assert from 'node:assert/strict';
import { db, initSchema } from './db';
import { hashPassword, signToken, type AuthUser } from './auth';
import { declarationsRouter } from './routes/declarations';
import express from 'express';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/declarations', declarationsRouter);
  return app;
}

function makeAuthHeader(user: AuthUser): Record<string, string> {
  return { Authorization: `Bearer ${signToken(user)}` };
}

async function requestJson(params: {
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}) {
  const app = createApp();
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${params.path}`, {
      method: params.method,
      headers: {
        'Content-Type': 'application/json',
        ...(params.headers || {}),
      },
      body: params.body ? JSON.stringify(params.body) : undefined,
    });
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, data };
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
    db
      .prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('ENS-API', 'Enseigne API', 'enseigne')`)
      .run().lastInsertRowid,
  );

  const assujettiId = Number(
    db
      .prepare(
        `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, statut)
         VALUES ('TLPE-API-1', 'Assujetti API', 'api@example.fr', 'actif')`,
      )
      .run().lastInsertRowid,
  );

  const adminId = Number(
    db
      .prepare(
        `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
         VALUES ('admin-api@tlpe.local', ?, 'Admin', 'API', 'admin', 1)`,
      )
      .run(hashPassword('x')).lastInsertRowid,
  );

  const contributerId = Number(
    db
      .prepare(
        `INSERT INTO users (email, password_hash, nom, prenom, role, assujetti_id, actif)
         VALUES ('contrib-api@tlpe.local', ?, 'Contrib', 'API', 'contribuable', ?, 1)`,
      )
      .run(hashPassword('x'), assujettiId).lastInsertRowid,
  );

  const dispositifId = Number(
    db
      .prepare(
        `INSERT INTO dispositifs (
          identifiant, assujetti_id, type_id, surface, nombre_faces,
          adresse_rue, adresse_cp, adresse_ville, statut
        ) VALUES ('DSP-API-1', ?, ?, 7.2, 1, '10 rue API', '75002', 'Paris', 'declare')`,
      )
      .run(assujettiId, typeId).lastInsertRowid,
  );

  const declarationId = Number(
    db
      .prepare(
        `INSERT INTO declarations (numero, assujetti_id, annee, statut)
         VALUES ('DEC-2026-API-1', ?, 2026, 'brouillon')`,
      )
      .run(assujettiId).lastInsertRowid,
  );

  db.prepare(
    `INSERT INTO lignes_declaration (
      declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose
    ) VALUES (?, ?, 7.2, 1, '2025-01-01')`,
  ).run(declarationId, dispositifId);

  return {
    declarationId,
    assujettiId,
    adminUser: {
      id: adminId,
      email: 'admin-api@tlpe.local',
      role: 'admin' as const,
      nom: 'Admin',
      prenom: 'API',
      assujetti_id: null,
    },
    contribUser: {
      id: contributerId,
      email: 'contrib-api@tlpe.local',
      role: 'contribuable' as const,
      nom: 'Contrib',
      prenom: 'API',
      assujetti_id: assujettiId,
    },
  };
}

test('soumission retourne un accusé PDF et endpoint de vérification publique', async () => {
  process.env.TLPE_EMAIL_DELIVERY_MODE = 'mock-success';
  const fx = resetFixtures();

  const submit = await requestJson({
    method: 'POST',
    path: `/api/declarations/${fx.declarationId}/soumettre`,
    headers: makeAuthHeader(fx.contribUser),
  });

  assert.equal(submit.status, 200);
  const receipt = (submit.data as any).receipt;
  assert.ok(receipt);
  assert.equal(typeof receipt.verification_token, 'string');
  assert.equal(receipt.payload_hash.length, 64);
  assert.equal(receipt.email_status, 'envoye');

  const verify = await requestJson({
    method: 'GET',
    path: `/api/declarations/receipt/verify/${encodeURIComponent(receipt.verification_token)}`,
  });

  assert.equal(verify.status, 200);
  assert.equal((verify.data as any).verified, true);
  assert.equal((verify.data as any).hash_soumission, receipt.payload_hash);
});

test('route /:id retourne les métadonnées de receipt après soumission', async () => {
  process.env.TLPE_EMAIL_DELIVERY_MODE = 'mock-success';
  const fx = resetFixtures();

  await requestJson({
    method: 'POST',
    path: `/api/declarations/${fx.declarationId}/soumettre`,
    headers: makeAuthHeader(fx.contribUser),
  });

  const detail = await requestJson({
    method: 'GET',
    path: `/api/declarations/${fx.declarationId}`,
    headers: makeAuthHeader(fx.adminUser),
  });

  assert.equal(detail.status, 200);
  assert.ok((detail.data as any).receipt);
  assert.equal(typeof (detail.data as any).receipt.download_url, 'string');
  assert.equal((detail.data as any).receipt.download_url, `/api/declarations/${fx.declarationId}/receipt/pdf`);
});
