import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { db, initSchema } from './db';
import { hashPassword, signToken, type AuthUser } from './auth';
import { contentieuxRouter } from './routes/contentieux';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/contentieux', contentieuxRouter);
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
      text,
      data: contentType.includes('application/json') && text ? JSON.parse(text) : null,
    };
  } finally {
    server.close();
  }
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
  db.exec('DELETE FROM pieces_jointes');
  db.exec('DELETE FROM evenements_contentieux');
  db.exec('DELETE FROM contentieux');
  db.exec('DELETE FROM audit_log');
  db.exec('DELETE FROM titres');
  db.exec('DELETE FROM declarations');
  db.exec('DELETE FROM dispositifs');
  db.exec('DELETE FROM campagnes');
  db.exec('DELETE FROM users');
  db.exec('DELETE FROM assujettis');

  const assujettiId = Number(
    db.prepare(
      `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, statut)
       VALUES ('TLPE-CTX-001', 'Alpha Contentieux', 'alpha-contentieux@example.test', 'actif')`,
    ).run().lastInsertRowid,
  );

  const gestionnaireId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES ('gestionnaire-contentieux@tlpe.local', ?, 'Gest', 'Contentieux', 'gestionnaire', 1)`,
    ).run(hashPassword('x')).lastInsertRowid,
  );

  const contribuableId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, assujetti_id, actif)
       VALUES ('contribuable-contentieux@tlpe.local', ?, 'Contrib', 'Contentieux', 'contribuable', ?, 1)`,
    ).run(hashPassword('x'), assujettiId).lastInsertRowid,
  );

  const declarationId = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-CTX-2026-001', ?, 2026, 'validee', 830)`,
    ).run(assujettiId).lastInsertRowid,
  );

  const titreId = Number(
    db.prepare(
      `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut)
       VALUES ('TIT-CTX-2026-000001', ?, ?, 2026, 830, '2026-03-10', '2026-07-31', 'emis')`,
    ).run(declarationId, assujettiId).lastInsertRowid,
  );

  const pieceJointeId = Number(
    db.prepare(
      `INSERT INTO pieces_jointes (entite, entite_id, nom, mime_type, taille, chemin, uploaded_by)
       VALUES ('contentieux', 9999, 'courrier.pdf', 'application/pdf', 512, 'contentieux/9999/courrier.pdf', ?)`,
    ).run(gestionnaireId).lastInsertRowid,
  );

  return {
    gestionnaire: {
      id: gestionnaireId,
      email: 'gestionnaire-contentieux@tlpe.local',
      role: 'gestionnaire' as const,
      nom: 'Gest',
      prenom: 'Contentieux',
      assujetti_id: null,
    },
    contribuable: {
      id: contribuableId,
      email: 'contribuable-contentieux@tlpe.local',
      role: 'contribuable' as const,
      nom: 'Contrib',
      prenom: 'Contentieux',
      assujetti_id: assujettiId,
    },
    assujettiId,
    titreId,
    pieceJointeId,
  };
}

test('schema contentieux inclut la table evenements_contentieux attendue', () => {
  initSchema();
  const columns = db.prepare("PRAGMA table_info('evenements_contentieux')").all() as Array<{ name: string }>;
  assert.deepEqual(
    columns.map((column) => column.name),
    ['id', 'contentieux_id', 'type', 'date', 'auteur', 'description', 'piece_jointe_id', 'created_at'],
  );
});

test('POST /api/contentieux alimente automatiquement la timeline d ouverture puis GET /:id/timeline retourne les événements chronologiques', async () => {
  const fx = resetFixtures();

  const created = await request({
    method: 'POST',
    path: '/api/contentieux',
    headers: makeAuthHeader(fx.gestionnaire),
    body: {
      assujetti_id: fx.assujettiId,
      titre_id: fx.titreId,
      type: 'contentieux',
      montant_litige: 830,
      description: 'Réclamation initiale sur le titre.',
    },
  });
  assert.equal(created.status, 201);

  const timeline = await request({
    method: 'GET',
    path: `/api/contentieux/${(created.data as { id: number }).id}/timeline`,
    headers: makeAuthHeader(fx.gestionnaire),
  });

  assert.equal(timeline.status, 200);
  assert.equal(Array.isArray(timeline.data), true);
  assert.equal((timeline.data as Array<{ type: string }>).length, 1);
  assert.equal((timeline.data as Array<{ type: string }>)[0].type, 'ouverture');
});

test('POST /api/contentieux/:id/decider et POST /api/contentieux/:id/evenements enrichissent la timeline puis le PDF s exporte', async () => {
  const fx = resetFixtures();

  const created = await request({
    method: 'POST',
    path: '/api/contentieux',
    headers: makeAuthHeader(fx.gestionnaire),
    body: {
      assujetti_id: fx.assujettiId,
      titre_id: fx.titreId,
      type: 'contentieux',
      montant_litige: 830,
      description: 'Ouverture du dossier.',
    },
  });
  assert.equal(created.status, 201);
  const contentieuxId = (created.data as { id: number }).id;

  const manual = await request({
    method: 'POST',
    path: `/api/contentieux/${contentieuxId}/evenements`,
    headers: makeAuthHeader(fx.gestionnaire),
    body: {
      type: 'courrier',
      date: '2026-06-15',
      auteur: 'Service contentieux',
      description: 'Courrier recommandé reçu.',
      piece_jointe_id: fx.pieceJointeId,
    },
  });
  assert.equal(manual.status, 201);

  const decided = await request({
    method: 'POST',
    path: `/api/contentieux/${contentieuxId}/decider`,
    headers: makeAuthHeader(fx.gestionnaire),
    body: {
      statut: 'clos_maintenu',
      decision: 'Le titre est maintenu après instruction.',
    },
  });
  assert.equal(decided.status, 200);

  const timeline = await request({
    method: 'GET',
    path: `/api/contentieux/${contentieuxId}/timeline`,
    headers: makeAuthHeader(fx.gestionnaire),
  });
  assert.equal(timeline.status, 200);
  assert.deepEqual(
    (timeline.data as Array<{ type: string }>).map((event) => event.type),
    ['ouverture', 'courrier', 'statut', 'decision'],
  );

  const pdf = await requestBinary({
    method: 'GET',
    path: `/api/contentieux/${contentieuxId}/timeline/pdf`,
    headers: makeAuthHeader(fx.gestionnaire),
  });
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.contentType, /application\/pdf/);
  assert.match(pdf.headers.disposition, /timeline-contentieux-/);
  assert.equal(pdf.buffer.subarray(0, 4).toString('utf8'), '%PDF');
});
