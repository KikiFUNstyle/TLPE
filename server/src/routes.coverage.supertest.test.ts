import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { db, initSchema } from './db';
import { hashPassword, signToken, type AuthUser } from './auth';
import { campagnesRouter } from './routes/campagnes';
import { dashboardRouter } from './routes/dashboard';
import { declarationsRouter } from './routes/declarations';
import { dispositifsRouter } from './routes/dispositifs';
import { geocodingRouter } from './routes/geocoding';
import { referentielsRouter } from './routes/referentiels';
import { simulateurRouter } from './routes/simulateur';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/campagnes', campagnesRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/declarations', declarationsRouter);
  app.use('/api/dispositifs', dispositifsRouter);
  app.use('/api/geocoding', geocodingRouter);
  app.use('/api/referentiels', referentielsRouter);
  app.use('/api/simulateur', simulateurRouter);
  return app;
}

function authHeader(user: AuthUser) {
  return { Authorization: `Bearer ${signToken(user)}` };
}

function resetFixtures() {
  initSchema();
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('DELETE FROM declaration_receipts');
    db.exec('DELETE FROM notifications_email');
    db.exec('DELETE FROM invitation_magic_links');
    db.exec('DELETE FROM campagne_jobs');
    db.exec('DELETE FROM mises_en_demeure');
    db.exec('DELETE FROM paiements');
    db.exec('DELETE FROM recouvrement_actions');
    db.exec('DELETE FROM pieces_jointes');
    db.exec('DELETE FROM evenements_contentieux');
    db.exec('DELETE FROM contentieux_alerts');
    db.exec('DELETE FROM contentieux');
    db.exec('DELETE FROM lignes_declaration');
    db.exec('DELETE FROM declarations');
    db.exec('DELETE FROM controles');
    db.exec('DELETE FROM titres');
    db.exec('DELETE FROM dispositifs');
    db.exec('DELETE FROM campagnes');
    db.exec('DELETE FROM bareme_activation');
    db.exec('DELETE FROM baremes');
    db.exec('DELETE FROM exonerations');
    db.exec('DELETE FROM audit_log');
    db.exec('DELETE FROM users');
    db.exec('DELETE FROM assujettis');
    db.exec('DELETE FROM types_dispositifs');
    db.exec('DELETE FROM zones');
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  const adminId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES ('admin-routes@tlpe.local', ?, 'Admin', 'Routes', 'admin', 1)`,
    ).run(hashPassword('secret123')).lastInsertRowid,
  );
  const gestionnaireId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES ('gestionnaire-routes@tlpe.local', ?, 'Gest', 'Routes', 'gestionnaire', 1)`,
    ).run(hashPassword('secret123')).lastInsertRowid,
  );
  const contribuableAssujettiId = Number(
    db.prepare(
      `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, siret, email, statut, portail_actif)
       VALUES ('TLPE-ROUTES-001', 'Alpha Routes', '12345678901234', 'alpha-routes@example.test', 'actif', 1)`,
    ).run().lastInsertRowid,
  );
  const otherAssujettiId = Number(
    db.prepare(
      `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, siret, email, statut, portail_actif)
       VALUES ('TLPE-ROUTES-002', 'Beta Routes', '22345678901234', 'beta-routes@example.test', 'actif', 1)`,
    ).run().lastInsertRowid,
  );
  const contribuableId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, assujetti_id, actif)
       VALUES ('contribuable-routes@tlpe.local', ?, 'Contrib', 'Routes', 'contribuable', ?, 1)`,
    ).run(hashPassword('secret123'), contribuableAssujettiId).lastInsertRowid,
  );

  const zoneId = Number(
    db.prepare(`INSERT INTO zones (code, libelle, coefficient, description) VALUES ('Z1', 'Zone 1', 1.1, 'Zone de test')`).run()
      .lastInsertRowid,
  );
  const typeId = Number(
    db.prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('ENS', 'Enseigne test', 'enseigne')`).run()
      .lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO baremes (annee, categorie, surface_min, surface_max, tarif_m2, tarif_fixe, exonere, libelle)
     VALUES (2026, 'enseigne', 0, 7, 0, 0, 1, 'Enseigne <= 7m²')`,
  ).run();
  db.prepare(
    `INSERT INTO baremes (annee, categorie, surface_min, surface_max, tarif_m2, tarif_fixe, exonere, libelle)
     VALUES (2026, 'enseigne', 7, 12, null, 75, 0, 'Enseigne 7-12m²')`,
  ).run();
  db.prepare(
    `INSERT INTO baremes (annee, categorie, surface_min, surface_max, tarif_m2, tarif_fixe, exonere, libelle)
     VALUES (2026, 'enseigne', 12, null, 15, null, 0, 'Enseigne > 12m²')`,
  ).run();

  const dispositifId = Number(
    db.prepare(
      `INSERT INTO dispositifs (
        identifiant, assujetti_id, type_id, zone_id, adresse_rue, adresse_cp, adresse_ville,
        latitude, longitude, surface, nombre_faces, statut
      ) VALUES ('DSP-ROUTES-001', ?, ?, ?, '1 rue des Tests', '75001', 'Paris', 48.8566, 2.3522, 10, 1, 'declare')`,
    ).run(contribuableAssujettiId, typeId, zoneId).lastInsertRowid,
  );

  const declarationId = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-ROUTES-2026-000001', ?, 2026, 'brouillon', 0)`,
    ).run(contribuableAssujettiId).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO lignes_declaration
       (declaration_id, dispositif_id, surface_declaree, nombre_faces, quote_part, date_pose)
     VALUES (?, ?, 10, 1, 1, '2026-01-01')`,
  ).run(declarationId, dispositifId);

  return {
    admin: {
      id: adminId,
      email: 'admin-routes@tlpe.local',
      nom: 'Admin',
      prenom: 'Routes',
      role: 'admin' as const,
      assujetti_id: null,
    },
    gestionnaire: {
      id: gestionnaireId,
      email: 'gestionnaire-routes@tlpe.local',
      nom: 'Gest',
      prenom: 'Routes',
      role: 'gestionnaire' as const,
      assujetti_id: null,
    },
    contribuable: {
      id: contribuableId,
      email: 'contribuable-routes@tlpe.local',
      nom: 'Contrib',
      prenom: 'Routes',
      role: 'contribuable' as const,
      assujetti_id: contribuableAssujettiId,
    },
    contribuableAssujettiId,
    otherAssujettiId,
    zoneId,
    typeId,
    dispositifId,
    declarationId,
  };
}

test('routes coverage smoke: dashboard, simulateur, geocoding et référentiels répondent sur les cas clés', async () => {
  const fx = resetFixtures();
  const app = createApp();

  const dashboardRes = await request(app).get('/api/dashboard').set(authHeader(fx.admin));
  assert.equal(dashboardRes.status, 200);
  assert.equal(typeof dashboardRes.body.operationnel, 'object');

  const simulateurKo = await request(app).post('/api/simulateur').send({ annee: 2026 });
  assert.equal(simulateurKo.status, 400);

  const simulateurOk = await request(app).post('/api/simulateur').send({
    annee: 2026,
    categorie: 'enseigne',
    surface: 10,
    nombre_faces: 1,
    coefficient_zone: 1.1,
  });
  assert.equal(simulateurOk.status, 200);
  assert.equal(typeof simulateurOk.body.montant, 'number');
  assert.equal(typeof simulateurOk.body.detail?.montant_arrondi, 'number');

  const geoBad = await request(app).get('/api/geocoding/search?q=ab').set(authHeader(fx.admin));
  assert.equal(geoBad.status, 400);

  const zonesRes = await request(app).get('/api/referentiels/zones').set(authHeader(fx.admin));
  assert.equal(zonesRes.status, 200);
  assert.equal(zonesRes.body[0].code, 'Z1');

  const baremesRes = await request(app).get('/api/referentiels/baremes?annee=2026').set(authHeader(fx.admin));
  assert.equal(baremesRes.status, 200);
  assert.equal(baremesRes.body.length, 3);

  const activeYearRes = await request(app).get('/api/referentiels/baremes/active-year').set(authHeader(fx.admin));
  assert.equal(activeYearRes.status, 200);
  assert.equal(activeYearRes.body.annee_active, 2026);

  const invalidZone = await request(app)
    .post('/api/referentiels/zones')
    .set(authHeader(fx.admin))
    .send({
      code: 'ZBAD',
      libelle: 'Zone invalide',
      coefficient: 1,
      geometry: { type: 'Polygon', coordinates: [] },
    });
  assert.equal(invalidZone.status, 400);

  const missingGeojson = await request(app)
    .post('/api/referentiels/zones/import')
    .set(authHeader(fx.admin))
    .send({});
  assert.equal(missingGeojson.status, 400);

  const emptyBaremes = await request(app)
    .post('/api/referentiels/baremes/import')
    .set(authHeader(fx.admin))
    .send({ rows: [] });
  assert.equal(emptyBaremes.status, 400);

  const invalidActivation = await request(app)
    .post('/api/referentiels/baremes/activate-year/1999')
    .set(authHeader(fx.admin));
  assert.equal(invalidActivation.status, 400);

  const createExoneration = await request(app)
    .post('/api/referentiels/exonerations')
    .set(authHeader(fx.admin))
    .send({
      type: 'droit',
      critere: { categorie: 'enseigne' },
      taux: 1,
      date_debut: '2026-01-01',
      date_fin: '2026-12-31',
      active: true,
    });
  assert.equal(createExoneration.status, 201);

  const exonerationsRes = await request(app).get('/api/referentiels/exonerations').set(authHeader(fx.admin));
  assert.equal(exonerationsRes.status, 200);
  assert.equal(exonerationsRes.body.length, 1);
});

test('routes coverage smoke: dispositifs et déclarations couvrent les parcours CRUD essentiels', async () => {
  const fx = resetFixtures();
  const app = createApp();

  const ownList = await request(app).get('/api/dispositifs').set(authHeader(fx.contribuable));
  assert.equal(ownList.status, 200);
  assert.equal(ownList.body.length, 1);

  const yearsList = await request(app).get('/api/dispositifs/annees').set(authHeader(fx.contribuable));
  assert.equal(yearsList.status, 200);
  assert.deepEqual(yearsList.body, [2026]);

  const invalidCreate = await request(app)
    .post('/api/dispositifs')
    .set(authHeader(fx.admin))
    .send({
      assujetti_id: fx.contribuableAssujettiId,
      type_id: fx.typeId,
      zone_id: fx.zoneId,
      surface: 12,
      nombre_faces: 1,
      date_pose: '2026-12-31',
      date_depose: '2026-01-01',
    });
  assert.equal(invalidCreate.status, 400);

  const created = await request(app)
    .post('/api/dispositifs')
    .set(authHeader(fx.admin))
    .send({
      assujetti_id: fx.contribuableAssujettiId,
      type_id: fx.typeId,
      zone_id: fx.zoneId,
      adresse_rue: '2 rue des Tests',
      adresse_cp: '75002',
      adresse_ville: 'Paris',
      surface: 14,
      nombre_faces: 2,
      statut: 'controle',
    });
  assert.equal(created.status, 201);
  const createdId = Number(created.body.id);

  const detail = await request(app).get(`/api/dispositifs/${createdId}`).set(authHeader(fx.contribuable));
  assert.equal(detail.status, 200);
  assert.equal(detail.body.identifiant, created.body.identifiant);

  const forbiddenOther = await request(app)
    .get(`/api/dispositifs/${createdId}`)
    .set(
      authHeader({
        ...fx.contribuable,
        assujetti_id: fx.otherAssujettiId,
        email: 'other-contribuable@tlpe.local',
      }),
    );
  assert.equal(forbiddenOther.status, 403);

  const updated = await request(app)
    .put(`/api/dispositifs/${createdId}`)
    .set(authHeader(fx.admin))
    .send({
      assujetti_id: fx.contribuableAssujettiId,
      type_id: fx.typeId,
      zone_id: fx.zoneId,
      adresse_rue: '2 rue des Tests',
      adresse_cp: '75002',
      adresse_ville: 'Paris',
      surface: 15,
      nombre_faces: 2,
      statut: 'controle',
    });
  assert.equal(updated.status, 200);

  const declList = await request(app).get('/api/declarations').set(authHeader(fx.contribuable));
  assert.equal(declList.status, 200);
  assert.equal(declList.body.length, 1);

  const declDetail = await request(app)
    .get(`/api/declarations/${fx.declarationId}`)
    .set(authHeader(fx.contribuable));
  assert.equal(declDetail.status, 200);
  assert.equal(declDetail.body.lignes.length, 1);

  const quotePartError = await request(app)
    .put(`/api/declarations/${fx.declarationId}/lignes`)
    .set(authHeader(fx.contribuable))
    .send([
      { dispositif_id: fx.dispositifId, surface_declaree: 10, nombre_faces: 1, quote_part: 0.7 },
      { dispositif_id: fx.dispositifId, surface_declaree: 10, nombre_faces: 1, quote_part: 0.5 },
    ]);
  assert.equal(quotePartError.status, 400);

  const deleted = await request(app).delete(`/api/dispositifs/${createdId}`).set(authHeader(fx.admin));
  assert.equal(deleted.status, 204);

  const createdDecl = await request(app)
    .post('/api/declarations')
    .set(authHeader(fx.contribuable))
    .send({ assujetti_id: fx.contribuableAssujettiId, annee: 2027 });
  assert.equal(createdDecl.status, 201);

  const duplicateDecl = await request(app)
    .post('/api/declarations')
    .set(authHeader(fx.contribuable))
    .send({ assujetti_id: fx.contribuableAssujettiId, annee: 2027 });
  assert.equal(duplicateDecl.status, 409);
});

test('routes coverage smoke: campagnes couvrent création, synthèse, ouverture et clôture', async () => {
  const fx = resetFixtures();
  const app = createApp();

  const activeBefore = await request(app).get('/api/campagnes/active').set(authHeader(fx.gestionnaire));
  assert.equal(activeBefore.status, 200);
  assert.equal(activeBefore.body.campagne, null);

  const created = await request(app)
    .post('/api/campagnes')
    .set(authHeader(fx.gestionnaire))
    .send({
      annee: 2026,
      date_ouverture: '2026-01-01',
      date_limite_declaration: '2026-03-31',
      date_cloture: '2026-04-01',
      relance_j7_courrier: true,
    });
  assert.equal(created.status, 201);
  const campagneId = Number(created.body.id);

  const list = await request(app).get('/api/campagnes').set(authHeader(fx.gestionnaire));
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);

  const summary = await request(app).get(`/api/campagnes/${campagneId}/summary`).set(authHeader(fx.gestionnaire));
  assert.equal(summary.status, 200);
  assert.equal(summary.body.campagne.id, campagneId);

  const openRes = await request(app).post(`/api/campagnes/${campagneId}/open`).set(authHeader(fx.gestionnaire));
  assert.equal(openRes.status, 200);
  assert.equal(openRes.body.ok, true);

  const sendInvitations = await request(app)
    .post(`/api/campagnes/${campagneId}/envoyer-invitations`)
    .set(authHeader(fx.gestionnaire))
    .send({ assujetti_id: fx.contribuableAssujettiId });
  assert.equal(sendInvitations.status, 200);

  const closeRes = await request(app).post(`/api/campagnes/${campagneId}/close`).set(authHeader(fx.gestionnaire));
  assert.equal(closeRes.status, 200);
  assert.equal(closeRes.body.ok, true);

  const runRelancesClosed = await request(app)
    .post(`/api/campagnes/${campagneId}/run-relances`)
    .set(authHeader(fx.gestionnaire))
    .send({ run_date: '2026-03-16' });
  assert.equal(runRelancesClosed.status, 409);
}
);