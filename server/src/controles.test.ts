import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { db, initSchema } from './db';
import { hashPassword, signToken, type AuthUser } from './auth';
import { controlesRouter } from './routes/controles';
import { piecesJointesRouter } from './routes/piecesJointes';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/controles', controlesRouter);
  app.use('/api/pieces-jointes', piecesJointesRouter);
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

function resetFixtures() {
  initSchema();
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('DELETE FROM pesv2_export_titres');
    db.exec('DELETE FROM pesv2_exports');
    db.exec('DELETE FROM declaration_receipts');
    db.exec('DELETE FROM notifications_email');
    db.exec('DELETE FROM invitation_magic_links');
    db.exec('DELETE FROM campagne_jobs');
    db.exec('DELETE FROM mises_en_demeure');
    db.exec('DELETE FROM paiements');
    db.exec('DELETE FROM evenements_contentieux');
    db.exec('DELETE FROM contentieux_alerts');
    db.exec('DELETE FROM contentieux');
    db.exec('DELETE FROM titre_mises_en_demeure');
    db.exec('DELETE FROM titre_mises_en_demeure_sequences');
    db.exec('DELETE FROM pieces_jointes');
    db.exec('DELETE FROM controles');
    db.exec('DELETE FROM recouvrement_actions');
    db.exec('DELETE FROM lignes_declaration');
    db.exec('DELETE FROM declarations');
    db.exec('DELETE FROM titres');
    db.exec('DELETE FROM campagnes');
    db.exec('DELETE FROM audit_log');
    db.exec('DELETE FROM users');
    db.exec('DELETE FROM dispositifs');
    db.exec('DELETE FROM assujettis');
    db.exec('DELETE FROM types_dispositifs');
    db.exec('DELETE FROM zones');
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  const assujettiId = Number(
    db.prepare(
      `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, statut)
       VALUES ('TLPE-CTRL-001', 'Alpha Controle', 'alpha-controle@example.test', 'actif')`,
    ).run().lastInsertRowid,
  );

  const typeId = Number(
    db.prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('ENS-CTRL', 'Enseigne contrôle', 'enseigne')`).run().lastInsertRowid,
  );

  const zoneId = Number(
    db.prepare(`INSERT INTO zones (code, libelle, coefficient) VALUES ('ZCTRL', 'Zone contrôle', 1.0)`).run().lastInsertRowid,
  );

  const dispositifId = Number(
    db.prepare(
      `INSERT INTO dispositifs (
        identifiant, assujetti_id, type_id, zone_id, adresse_rue, adresse_cp, adresse_ville,
        latitude, longitude, surface, nombre_faces, statut
      ) VALUES ('DSP-CTRL-001', ?, ?, ?, '1 rue du Test', '75001', 'Paris', 48.8566, 2.3522, 12, 2, 'declare')`,
    ).run(assujettiId, typeId, zoneId).lastInsertRowid,
  );

  const controleurId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES ('controleur-terrain@tlpe.local', ?, 'Terrain', 'Agent', 'controleur', 1)`,
    ).run(hashPassword('x')).lastInsertRowid,
  );

  const gestionnaireId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES ('gestionnaire-terrain@tlpe.local', ?, 'Gest', 'Terrain', 'gestionnaire', 1)`,
    ).run(hashPassword('x')).lastInsertRowid,
  );

  return {
    assujettiId,
    typeId,
    zoneId,
    dispositifId,
    controleur: {
      id: controleurId,
      email: 'controleur-terrain@tlpe.local',
      role: 'controleur' as const,
      nom: 'Terrain',
      prenom: 'Agent',
      assujetti_id: null,
    },
    gestionnaire: {
      id: gestionnaireId,
      email: 'gestionnaire-terrain@tlpe.local',
      role: 'gestionnaire' as const,
      nom: 'Gest',
      prenom: 'Terrain',
      assujetti_id: null,
    },
  };
}

test('schema controles expose la table attendue et autorise des photos via pieces_jointes', () => {
  initSchema();
  const columns = db.prepare("PRAGMA table_info('controles')").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));

  assert.ok(names.has('id'));
  assert.ok(names.has('dispositif_id'));
  assert.ok(names.has('agent_id'));
  assert.ok(names.has('date_controle'));
  assert.ok(names.has('latitude'));
  assert.ok(names.has('longitude'));
  assert.ok(names.has('surface_mesuree'));
  assert.ok(names.has('nombre_faces_mesurees'));
  assert.ok(names.has('ecart_detecte'));
  assert.ok(names.has('ecart_description'));
  assert.ok(names.has('statut'));

  const piecesSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pieces_jointes'").get() as { sql: string }).sql;
  assert.match(piecesSql, /entite\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*entite\s+IN\s*\('dispositif','declaration','contentieux','titre','controle'\)\s*\)/i);
});

test('POST /api/controles crée un constat rattaché à un dispositif existant puis GET /api/controles le restitue', async () => {
  const fx = resetFixtures();

  const created = await request({
    method: 'POST',
    path: '/api/controles',
    headers: makeAuthHeader(fx.controleur),
    body: {
      dispositif_id: fx.dispositifId,
      date_controle: '2026-05-12',
      latitude: 48.8566,
      longitude: 2.3522,
      surface_mesuree: 13.5,
      nombre_faces_mesurees: 2,
      ecart_detecte: true,
      ecart_description: 'Surface mesurée supérieure à la fiche déclarée',
      statut: 'saisi',
    },
  });

  assert.equal(created.status, 201);
  const createdBody = created.data as { id: number; dispositif_id: number; photos_count: number };
  assert.equal(createdBody.dispositif_id, fx.dispositifId);
  assert.equal(createdBody.photos_count, 0);

  const listed = await request({
    method: 'GET',
    path: '/api/controles',
    headers: makeAuthHeader(fx.controleur),
  });

  assert.equal(listed.status, 200);
  const rows = listed.data as Array<{
    id: number;
    dispositif_id: number | null;
    ecart_detecte: boolean;
    ecart_description: string | null;
    photos_count: number;
    agent_nom: string;
    dispositif_identifiant: string | null;
  }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, createdBody.id);
  assert.equal(rows[0].dispositif_id, fx.dispositifId);
  assert.equal(rows[0].ecart_detecte, true);
  assert.equal(rows[0].ecart_description, 'Surface mesurée supérieure à la fiche déclarée');
  assert.equal(rows[0].photos_count, 0);
  assert.equal(rows[0].dispositif_identifiant, 'DSP-CTRL-001');
  assert.match(rows[0].agent_nom, /Agent Terrain/);

  const auditRow = db.prepare(
    `SELECT action, entite FROM audit_log WHERE entite = 'controle' AND entite_id = ? ORDER BY id DESC LIMIT 1`,
  ).get(createdBody.id) as { action: string; entite: string } | undefined;
  assert.ok(auditRow);
  assert.equal(auditRow?.action, 'create');
});

test('POST /api/controles peut créer une nouvelle fiche dispositif à partir du constat terrain', async () => {
  const fx = resetFixtures();

  const created = await request({
    method: 'POST',
    path: '/api/controles',
    headers: makeAuthHeader(fx.controleur),
    body: {
      date_controle: '2026-05-13',
      latitude: 48.857,
      longitude: 2.353,
      surface_mesuree: 6,
      nombre_faces_mesurees: 1,
      ecart_detecte: true,
      ecart_description: 'Dispositif non déclaré constaté sur site',
      statut: 'saisi',
      create_dispositif: {
        assujetti_id: fx.assujettiId,
        type_id: fx.typeId,
        zone_id: fx.zoneId,
        adresse_rue: '99 avenue du Terrain',
        adresse_cp: '75002',
        adresse_ville: 'Paris',
        latitude: 48.857,
        longitude: 2.353,
        surface: 6,
        nombre_faces: 1,
        statut: 'controle',
        notes: 'Créé depuis un constat terrain',
      },
    },
  });

  assert.equal(created.status, 201);
  const createdBody = created.data as { id: number; dispositif_id: number; created_dispositif_identifiant: string | null };
  assert.ok(createdBody.dispositif_id > 0);
  assert.match(createdBody.created_dispositif_identifiant ?? '', /^DSP-/);

  const createdDispositif = db.prepare(
    `SELECT identifiant, statut, assujetti_id, notes FROM dispositifs WHERE id = ?`,
  ).get(createdBody.dispositif_id) as { identifiant: string; statut: string; assujetti_id: number; notes: string | null } | undefined;
  assert.ok(createdDispositif);
  assert.equal(createdDispositif?.assujetti_id, fx.assujettiId);
  assert.equal(createdDispositif?.statut, 'controle');
  assert.match(createdDispositif?.notes ?? '', /constat terrain/i);

  const dispositifAudit = db.prepare(
    `SELECT action, entite FROM audit_log WHERE entite = 'dispositif' AND entite_id = ? ORDER BY id DESC LIMIT 1`,
  ).get(createdBody.dispositif_id) as { action: string; entite: string } | undefined;
  assert.ok(dispositifAudit);
  assert.equal(dispositifAudit?.action, 'create');
});

test('POST /api/controles rejette un payload sans rattachement ni création de dispositif', async () => {
  const fx = resetFixtures();

  const response = await request({
    method: 'POST',
    path: '/api/controles',
    headers: makeAuthHeader(fx.controleur),
    body: {
      date_controle: '2026-05-12',
      latitude: 48.8566,
      longitude: 2.3522,
      surface_mesuree: 8,
      nombre_faces_mesurees: 1,
      ecart_detecte: false,
      statut: 'saisi',
    },
  });

  assert.equal(response.status, 400);
  assert.match(String((response.data as { error: string }).error), /dispositif/i);
});

test('POST /api/controles rejette une date de contrôle calendrier invalide', async () => {
  const fx = resetFixtures();

  const response = await request({
    method: 'POST',
    path: '/api/controles',
    headers: makeAuthHeader(fx.controleur),
    body: {
      dispositif_id: fx.dispositifId,
      date_controle: '2026-02-30',
      latitude: 48.8566,
      longitude: 2.3522,
      surface_mesuree: 13.5,
      nombre_faces_mesurees: 2,
      ecart_detecte: false,
      statut: 'saisi',
    },
  });

  assert.equal(response.status, 400);
  assert.match(String((response.data as { error: string }).error), /date invalide/i);
});

test('POST /api/pieces-jointes accepte les photos de contrôle pour un rôle contrôleur', async () => {
  const fx = resetFixtures();

  const created = await request({
    method: 'POST',
    path: '/api/controles',
    headers: makeAuthHeader(fx.controleur),
    body: {
      dispositif_id: fx.dispositifId,
      date_controle: '2026-05-12',
      latitude: 48.8566,
      longitude: 2.3522,
      surface_mesuree: 13.5,
      nombre_faces_mesurees: 2,
      ecart_detecte: true,
      ecart_description: 'Photo terrain nécessaire',
      statut: 'saisi',
    },
  });

  assert.equal(created.status, 201);
  const controleId = (created.data as { id: number }).id;

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
    const form = new FormData();
    form.set('entite', 'controle');
    form.set('entite_id', String(controleId));
    form.set('fichier', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], { type: 'image/jpeg' }), 'controle.jpg');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/pieces-jointes`, {
      method: 'POST',
      headers: makeAuthHeader(fx.controleur),
      body: form,
    });

    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.entite, 'controle');
    assert.equal(body.entite_id, controleId);
  } finally {
    server.close();
  }
});

test('POST /api/pieces-jointes refuse au contrôleur les pièces jointes hors entité contrôle', async () => {
  const fx = resetFixtures();

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
    const form = new FormData();
    form.set('entite', 'dispositif');
    form.set('entite_id', String(fx.dispositifId));
    form.set('fichier', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], { type: 'image/jpeg' }), 'controle.jpg');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/pieces-jointes`, {
      method: 'POST',
      headers: makeAuthHeader(fx.controleur),
      body: form,
    });

    assert.equal(response.status, 403);
    assert.match(await response.text(), /droits insuffisants/i);
  } finally {
    server.close();
  }
});
