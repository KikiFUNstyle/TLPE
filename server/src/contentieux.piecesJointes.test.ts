import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { db, initSchema } from './db';
import { hashPassword, signToken, type AuthUser } from './auth';
import { piecesJointesRouter } from './routes/piecesJointes';
import { contentieuxRouter } from './routes/contentieux';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/pieces-jointes', piecesJointesRouter);
  app.use('/api/contentieux', contentieuxRouter);
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

async function requestMultipart(params: {
  path: string;
  headers?: Record<string, string>;
  formData: FormData;
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
      method: 'POST',
      headers: params.headers,
      body: params.formData,
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

function resetFixtures() {
  initSchema();
  db.exec('DELETE FROM pieces_jointes');
  db.exec('DELETE FROM evenements_contentieux');
  db.exec('DELETE FROM contentieux_alerts');
  db.exec('DELETE FROM contentieux');
  db.exec('DELETE FROM audit_log');
  db.exec('DELETE FROM titres');
  db.exec('DELETE FROM declarations');
  db.exec('DELETE FROM controles');
  db.exec('DELETE FROM dispositifs');
  db.exec('DELETE FROM campagnes');
  db.exec('DELETE FROM users');
  db.exec('DELETE FROM assujettis');

  const assujettiId = Number(
    db.prepare(
      `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, statut)
       VALUES ('TLPE-CTX-PJ-001', 'Alpha Pièces Jointes', 'alpha-pj@example.test', 'actif')`,
    ).run().lastInsertRowid,
  );

  const otherAssujettiId = Number(
    db.prepare(
      `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, statut)
       VALUES ('TLPE-CTX-PJ-002', 'Beta Pièces Jointes', 'beta-pj@example.test', 'actif')`,
    ).run().lastInsertRowid,
  );

  const gestionnaireId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES ('gestionnaire-pj@tlpe.local', ?, 'Gest', 'PJ', 'gestionnaire', 1)`,
    ).run(hashPassword('x')).lastInsertRowid,
  );

  const financierId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES ('financier-pj@tlpe.local', ?, 'Fin', 'PJ', 'financier', 1)`,
    ).run(hashPassword('x')).lastInsertRowid,
  );

  const contribuableId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, assujetti_id, actif)
       VALUES ('contribuable-pj@tlpe.local', ?, 'Contrib', 'PJ', 'contribuable', ?, 1)`,
    ).run(hashPassword('x'), assujettiId).lastInsertRowid,
  );

  const outsiderId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, assujetti_id, actif)
       VALUES ('outsider-pj@tlpe.local', ?, 'Outsider', 'PJ', 'contribuable', ?, 1)`,
    ).run(hashPassword('x'), otherAssujettiId).lastInsertRowid,
  );

  const declarationId = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-CTX-PJ-2026-001', ?, 2026, 'validee', 830)`,
    ).run(assujettiId).lastInsertRowid,
  );

  const titreId = Number(
    db.prepare(
      `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut)
       VALUES ('TIT-CTX-PJ-2026-000001', ?, ?, 2026, 830, '2026-03-10', '2026-07-31', 'emis')`,
    ).run(declarationId, assujettiId).lastInsertRowid,
  );

  return {
    gestionnaire: {
      id: gestionnaireId,
      email: 'gestionnaire-pj@tlpe.local',
      role: 'gestionnaire' as const,
      nom: 'Gest',
      prenom: 'PJ',
      assujetti_id: null,
    },
    financier: {
      id: financierId,
      email: 'financier-pj@tlpe.local',
      role: 'financier' as const,
      nom: 'Fin',
      prenom: 'PJ',
      assujetti_id: null,
    },
    contribuable: {
      id: contribuableId,
      email: 'contribuable-pj@tlpe.local',
      role: 'contribuable' as const,
      nom: 'Contrib',
      prenom: 'PJ',
      assujetti_id: assujettiId,
    },
    outsider: {
      id: outsiderId,
      email: 'outsider-pj@tlpe.local',
      role: 'contribuable' as const,
      nom: 'Outsider',
      prenom: 'PJ',
      assujetti_id: otherAssujettiId,
    },
    assujettiId,
    titreId,
  };
}

async function createContentieux(fx: ReturnType<typeof resetFixtures>) {
  const created = await request({
    method: 'POST',
    path: '/api/contentieux',
    headers: makeAuthHeader(fx.gestionnaire),
    body: {
      assujetti_id: fx.assujettiId,
      titre_id: fx.titreId,
      type: 'contentieux',
      montant_litige: 830,
      description: 'Dossier contentieux pour pièces jointes.',
    },
  });
  assert.equal(created.status, 201);
  return (created.data as { id: number }).id;
}

function buildPdfUploadForm(entiteId: number, typePiece: string) {
  const formData = new FormData();
  formData.set('entite', 'contentieux');
  formData.set('entite_id', String(entiteId));
  formData.set('type_piece', typePiece);
  formData.set(
    'fichier',
    new File([Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n', 'utf8')], 'piece.pdf', { type: 'application/pdf' }),
  );
  return formData;
}

test('POST upload contentieux + GET liste exposent les métadonnées attendues pour un contribuable', async () => {
  const fx = resetFixtures();
  const contentieuxId = await createContentieux(fx);

  const uploaded = await requestMultipart({
    path: '/api/pieces-jointes',
    headers: makeAuthHeader(fx.contribuable),
    formData: buildPdfUploadForm(contentieuxId, 'courrier-contribuable'),
  });

  assert.equal(uploaded.status, 201);
  assert.equal((uploaded.data as { entite: string }).entite, 'contentieux');

  const listed = await request({
    method: 'GET',
    path: `/api/contentieux/${contentieuxId}/pieces-jointes`,
    headers: makeAuthHeader(fx.contribuable),
  });

  assert.equal(listed.status, 200);
  const rows = listed.data as Array<{
    id: number;
    nom: string;
    mime_type: string;
    type_piece: string;
    auteur: string;
    can_delete: boolean;
    download_url: string;
  }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mime_type, 'application/pdf');
  assert.equal(rows[0].type_piece, 'courrier-contribuable');
  assert.equal(rows[0].auteur, 'PJ Contrib');
  assert.equal(rows[0].can_delete, false);
  assert.equal(rows[0].download_url, `/api/pieces-jointes/${rows[0].id}`);

  const auditRow = db.prepare(
    `SELECT action, details FROM audit_log WHERE entite = 'piece_jointe' AND entite_id = ? ORDER BY id DESC LIMIT 1`,
  ).get(rows[0].id) as { action: string; details: string | null } | undefined;
  assert.ok(auditRow);
  assert.equal(auditRow?.action, 'upload');
  assert.match(auditRow?.details ?? '', /courrier-contribuable/);
});

test('GET liste contentieux montre les pièces administration en lecture seule pour le contribuable et refuse l’accès au financier', async () => {
  const fx = resetFixtures();
  const contentieuxId = await createContentieux(fx);

  const adminUpload = await requestMultipart({
    path: '/api/pieces-jointes',
    headers: makeAuthHeader(fx.gestionnaire),
    formData: buildPdfUploadForm(contentieuxId, 'decision'),
  });
  assert.equal(adminUpload.status, 201);

  const contribuableList = await request({
    method: 'GET',
    path: `/api/contentieux/${contentieuxId}/pieces-jointes`,
    headers: makeAuthHeader(fx.contribuable),
  });
  assert.equal(contribuableList.status, 200);
  const rows = contribuableList.data as Array<{ type_piece: string; access_mode: string; auteur_role: string; can_delete: boolean }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type_piece, 'decision');
  assert.equal(rows[0].access_mode, 'lecture-seule');
  assert.equal(rows[0].auteur_role, 'gestionnaire');
  assert.equal(rows[0].can_delete, false);

  const financierList = await request({
    method: 'GET',
    path: `/api/contentieux/${contentieuxId}/pieces-jointes`,
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(financierList.status, 403);
});

test('DELETE /api/pieces-jointes/:id refuse la suppression des pièces contentieux par un contribuable', async () => {
  const fx = resetFixtures();
  const contentieuxId = await createContentieux(fx);

  const uploaded = await requestMultipart({
    path: '/api/pieces-jointes',
    headers: makeAuthHeader(fx.contribuable),
    formData: buildPdfUploadForm(contentieuxId, 'courrier-contribuable'),
  });
  assert.equal(uploaded.status, 201);
  const pieceId = (uploaded.data as { id: number }).id;

  const deleted = await request({
    method: 'DELETE',
    path: `/api/pieces-jointes/${pieceId}`,
    headers: makeAuthHeader(fx.contribuable),
  });
  assert.equal(deleted.status, 403);

  const row = db.prepare('SELECT deleted_at FROM pieces_jointes WHERE id = ?').get(pieceId) as { deleted_at: string | null };
  assert.equal(row.deleted_at, null);
});

test('GET liste contentieux refuse l’accès à un contribuable d’un autre assujetti', async () => {
  const fx = resetFixtures();
  const contentieuxId = await createContentieux(fx);

  const outsiderList = await request({
    method: 'GET',
    path: `/api/contentieux/${contentieuxId}/pieces-jointes`,
    headers: makeAuthHeader(fx.outsider),
  });
  assert.equal(outsiderList.status, 403);
});

test('POST /api/pieces-jointes retourne 400 sans fichier multipart', async () => {
  const fx = resetFixtures();
  const contentieuxId = await createContentieux(fx);

  const res = await request({
    method: 'POST',
    path: '/api/pieces-jointes',
    headers: makeAuthHeader(fx.gestionnaire),
    body: {
      entite: 'contentieux',
      entite_id: contentieuxId,
      type_piece: 'decision',
    },
  });

  assert.equal(res.status, 400);
  assert.equal(res.data?.error, 'Fichier requis (champ "fichier")');
});

test('POST /api/pieces-jointes rejette un contenu incohérent avec le MIME annoncé', async () => {
  const fx = resetFixtures();
  const contentieuxId = await createContentieux(fx);
  const formData = new FormData();
  formData.set('entite', 'contentieux');
  formData.set('entite_id', String(contentieuxId));
  formData.set('type_piece', 'decision');
  formData.set('fichier', new File([Buffer.from('ceci n\'est pas un PDF', 'utf8')], 'piece.pdf', { type: 'application/pdf' }));

  const res = await requestMultipart({
    path: '/api/pieces-jointes',
    headers: makeAuthHeader(fx.gestionnaire),
    formData,
  });

  assert.equal(res.status, 400);
  assert.equal(res.data?.error, 'Contenu du fichier incoherent avec le type MIME annonce');
});

test('POST /api/pieces-jointes retourne 404 quand l’entité ciblée est introuvable', async () => {
  const fx = resetFixtures();
  const formData = buildPdfUploadForm(999999, 'decision');

  const res = await requestMultipart({
    path: '/api/pieces-jointes',
    headers: makeAuthHeader(fx.gestionnaire),
    formData,
  });

  assert.equal(res.status, 404);
  assert.equal(res.data?.error, 'Entite introuvable');
});

test('GET /api/pieces-jointes/:id retourne 404 quand le fichier stocké a disparu', async () => {
  const fx = resetFixtures();
  const contentieuxId = await createContentieux(fx);

  const uploaded = await requestMultipart({
    path: '/api/pieces-jointes',
    headers: makeAuthHeader(fx.gestionnaire),
    formData: buildPdfUploadForm(contentieuxId, 'decision'),
  });
  assert.equal(uploaded.status, 201);
  const pieceId = (uploaded.data as { id: number }).id;
  const piece = db.prepare('SELECT chemin FROM pieces_jointes WHERE id = ?').get(pieceId) as { chemin: string };
  const absolutePath = path.resolve(__dirname, '..', 'data', 'uploads', piece.chemin);
  fs.unlinkSync(absolutePath);

  const download = await request({
    method: 'GET',
    path: `/api/pieces-jointes/${pieceId}`,
    headers: makeAuthHeader(fx.gestionnaire),
  });

  assert.equal(download.status, 404);
  assert.equal(download.data?.error, 'Fichier introuvable dans le stockage');
});

test('DELETE /api/pieces-jointes/:id retourne 404 pour une pièce absente', async () => {
  const fx = resetFixtures();

  const deleted = await request({
    method: 'DELETE',
    path: '/api/pieces-jointes/999999',
    headers: makeAuthHeader(fx.gestionnaire),
  });

  assert.equal(deleted.status, 404);
  assert.equal(deleted.data?.error, 'Piece jointe introuvable');
});

test('POST /api/pieces-jointes refuse un upload qui dépasse le quota total par entité', async () => {
  const fx = resetFixtures();
  const contentieuxId = await createContentieux(fx);
  db.prepare(
    `INSERT INTO pieces_jointes (entite, entite_id, nom, mime_type, taille, chemin, type_piece, uploaded_by)
     VALUES ('contentieux', ?, 'quota.pdf', 'application/pdf', ?, 'contentieux/quota/quota.pdf', 'decision', ?)`,
  ).run(contentieuxId, 50 * 1024 * 1024, fx.gestionnaire.id);

  const uploaded = await requestMultipart({
    path: '/api/pieces-jointes',
    headers: makeAuthHeader(fx.gestionnaire),
    formData: buildPdfUploadForm(contentieuxId, 'decision'),
  });

  assert.equal(uploaded.status, 400);
  assert.equal(uploaded.data?.error, 'Taille totale depassee (50 Mo maximum par entite)');
});
