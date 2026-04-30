import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
import { assujettisRouter } from './routes/assujettis';

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
  app.use('/api/assujettis', assujettisRouter);
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
    db.exec('DELETE FROM sepa_prelevements');
    db.exec('DELETE FROM sepa_exports');
    db.exec('DELETE FROM mandats_sepa');
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
    db.exec('DELETE FROM api_entreprise_cache');
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

function createMandatPayload(overrides: Partial<{ rum: string; iban: string; bic: string; date_signature: string }> = {}) {
  return {
    rum: overrides.rum ?? 'RUM-TLPE-001',
    iban: overrides.iban ?? 'FR1420041010050500013M02606',
    bic: overrides.bic ?? 'PSSTFRPPPAR',
    date_signature: overrides.date_signature ?? '2026-01-15',
  };
}

function encodeCsvBase64(lines: string[]) {
  return Buffer.from(lines.join('\n'), 'utf-8').toString('base64');
}

function cacheApiEntrepriseRecord(params: {
  siret: string;
  raisonSociale?: string;
  estRadie?: boolean;
  expiresInDays?: number;
}) {
  db.prepare(
    `INSERT INTO api_entreprise_cache (
      siret, raison_sociale, forme_juridique, adresse_rue, adresse_cp, adresse_ville, adresse_pays,
      est_radie, source_statut, fetched_at, expires_at
    ) VALUES (?, ?, 'SARL', '1 rue API', '75001', 'Paris', 'France', ?, ?, datetime('now'), datetime('now', ?))`,
  ).run(
    params.siret,
    params.raisonSociale ?? 'Société API',
    params.estRadie ? 1 : 0,
    params.estRadie ? 'F' : 'A',
    `+${params.expiresInDays ?? 10} day`,
  );
}

test('routes coverage smoke: assujettis couvrent CRUD, enrichissement SIRENE, import et téléchargement de template', async () => {
  const fx = resetFixtures();
  const app = createApp();

  const ownList = await request(app).get('/api/assujettis').set(authHeader(fx.contribuable));
  assert.equal(ownList.status, 200);
  assert.equal(ownList.body.length, 1);
  assert.equal(ownList.body[0].id, fx.contribuableAssujettiId);

  const filteredList = await request(app)
    .get('/api/assujettis?q=Alpha&statut=actif')
    .set(authHeader(fx.admin));
  assert.equal(filteredList.status, 200);
  assert.equal(filteredList.body.length, 1);

  const ownDetail = await request(app)
    .get(`/api/assujettis/${fx.contribuableAssujettiId}`)
    .set(authHeader(fx.contribuable));
  assert.equal(ownDetail.status, 200);
  assert.equal(ownDetail.body.id, fx.contribuableAssujettiId);
  assert.equal(Array.isArray(ownDetail.body.dispositifs), true);
  assert.equal(Array.isArray(ownDetail.body.declarations), true);
  assert.equal(Array.isArray(ownDetail.body.titres), true);
  assert.equal(Array.isArray(ownDetail.body.mandats_sepa), true);

  const forbiddenDetail = await request(app)
    .get(`/api/assujettis/${fx.otherAssujettiId}`)
    .set(authHeader(fx.contribuable));
  assert.equal(forbiddenDetail.status, 403);

  const missingDetail = await request(app).get('/api/assujettis/999999').set(authHeader(fx.admin));
  assert.equal(missingDetail.status, 404);

  const invalidCreate = await request(app)
    .post('/api/assujettis')
    .set(authHeader(fx.admin))
    .send({ raison_sociale: 'SIRET KO', siret: '123' });
  assert.equal(invalidCreate.status, 400);

  cacheApiEntrepriseRecord({ siret: '73282932000074', estRadie: true, raisonSociale: 'Radiée SARL' });
  const radieCreate = await request(app)
    .post('/api/assujettis')
    .set(authHeader(fx.admin))
    .send({ raison_sociale: 'Radiée SARL', siret: '73282932000074' });
  assert.equal(radieCreate.status, 422);

  const created = await request(app)
    .post('/api/assujettis')
    .set(authHeader(fx.admin))
    .send({
      raison_sociale: 'Gamma Routes',
      siret: '55210055400005',
      email: 'gamma@example.test',
      portail_actif: true,
      statut: 'actif',
    });
  assert.equal(created.status, 201);
  assert.equal(created.body.sirene_status, 'degraded');
  const createdAssujettiId = Number(created.body.id);

  const duplicateCreate = await request(app)
    .post('/api/assujettis')
    .set(authHeader(fx.admin))
    .send({
      raison_sociale: 'Gamma Routes bis',
      siret: '55210055400005',
      email: 'gamma-bis@example.test',
      portail_actif: false,
      statut: 'inactif',
    });
  assert.equal(duplicateCreate.status, 409);

  const invalidUpdate = await request(app)
    .put(`/api/assujettis/${createdAssujettiId}`)
    .set(authHeader(fx.admin))
    .send({ raison_sociale: 'Gamma Routes', siret: 'bad-siret' });
  assert.equal(invalidUpdate.status, 400);

  cacheApiEntrepriseRecord({ siret: '34921495400001', estRadie: true, raisonSociale: 'Radiee Update SAS' });
  const radieUpdate = await request(app)
    .put(`/api/assujettis/${createdAssujettiId}`)
    .set(authHeader(fx.admin))
    .send({ raison_sociale: 'Gamma Routes', siret: '34921495400001' });
  assert.equal(radieUpdate.status, 422);

  const updated = await request(app)
    .put(`/api/assujettis/${createdAssujettiId}`)
    .set(authHeader(fx.admin))
    .send({
      raison_sociale: 'Gamma Routes MAJ',
      siret: '55210055400005',
      email: 'gamma-maj@example.test',
      portail_actif: false,
      statut: 'inactif',
      notes: 'Mis à jour par test',
    });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.sirene_status, 'degraded');

  const missingUpdate = await request(app)
    .put('/api/assujettis/999999')
    .set(authHeader(fx.admin))
    .send({ raison_sociale: 'Inexistant' });
  assert.equal(missingUpdate.status, 404);

  const template = await request(app)
    .get('/api/assujettis/import/template')
    .set(authHeader(fx.admin));
  assert.equal(template.status, 200);
  assert.match(String(template.headers['content-type'] ?? ''), /text\/csv/);
  assert.match(String(template.headers['content-disposition'] ?? ''), /assujettis-template\.csv/);
  assert.match(template.text, /identifiant_tlpe,raison_sociale,siret,forme_juridique,adresse_rue,adresse_cp,adresse_ville,adresse_pays,contact_nom,contact_prenom,contact_fonction,email,telephone,portail_actif,statut,notes/);

  const invalidImportSchema = await request(app)
    .post('/api/assujettis/import')
    .set(authHeader(fx.admin))
    .send({ fileName: '', contentBase64: '' });
  assert.equal(invalidImportSchema.status, 400);

  const invalidImportDecode = await request(app)
    .post('/api/assujettis/import')
    .set(authHeader(fx.admin))
    .send({ fileName: 'assujettis.csv', contentBase64: 'not-base64', mode: 'preview' });
  assert.equal(invalidImportDecode.status, 200);
  assert.equal(invalidImportDecode.body.total, 0);
  assert.equal(invalidImportDecode.body.valid, 0);
  assert.equal(invalidImportDecode.body.rejected, 0);

  const previewCsv = encodeCsvBase64([
    'identifiant_tlpe,raison_sociale,siret,email,portail_actif,statut',
    'TLPE-2026-00990,Import Preview,12345678901005,preview@example.test,oui,actif',
    'TLPE-2026-00991,,123,broken-email,peut-etre,inconnu',
  ]);
  const previewImport = await request(app)
    .post('/api/assujettis/import')
    .set(authHeader(fx.admin))
    .send({ fileName: 'assujettis.csv', contentBase64: previewCsv, mode: 'preview' });
  assert.equal(previewImport.status, 200);
  assert.equal(previewImport.body.total, 2);
  assert.equal(previewImport.body.valid, 1);
  assert.equal(previewImport.body.rejected, 1);
  assert.equal(previewImport.body.sirene_status, 'degraded');
  assert.ok(previewImport.body.anomalies.length >= 4);

  const abortImport = await request(app)
    .post('/api/assujettis/import')
    .set(authHeader(fx.admin))
    .send({ fileName: 'assujettis.csv', contentBase64: previewCsv, mode: 'commit', onError: 'abort' });
  assert.equal(abortImport.status, 400);

  const commitImport = await request(app)
    .post('/api/assujettis/import')
    .set(authHeader(fx.admin))
    .send({ fileName: 'assujettis.csv', contentBase64: previewCsv, mode: 'commit', onError: 'skip' });
  assert.equal(commitImport.status, 201);
  assert.equal(commitImport.body.created, 1);
  assert.equal(commitImport.body.updated, 0);
  assert.equal(commitImport.body.rejected, 1);
  assert.equal(commitImport.body.sirene_status, 'degraded');

  const deleted = await request(app)
    .delete(`/api/assujettis/${createdAssujettiId}`)
    .set(authHeader(fx.admin));
  assert.equal(deleted.status, 204);

  const missingDelete = await request(app)
    .delete('/api/assujettis/999999')
    .set(authHeader(fx.admin));
  assert.equal(missingDelete.status, 404);

  cacheApiEntrepriseRecord({ siret: '55210055400021', raisonSociale: 'Cache Delta', expiresInDays: 15 });
  const createdFromCache = await request(app)
    .post('/api/assujettis')
    .set(authHeader(fx.admin))
    .send({
      raison_sociale: 'Placeholder cache',
      siret: '55210055400021',
      portail_actif: true,
      statut: 'actif',
    });
  assert.equal(createdFromCache.status, 201);
  assert.equal(createdFromCache.body.sirene_status, 'cache');
  const cachedCreatedRow = db.prepare(
    'SELECT raison_sociale, forme_juridique, adresse_rue, adresse_cp, adresse_ville FROM assujettis WHERE id = ?',
  ).get(Number(createdFromCache.body.id)) as {
    raison_sociale: string;
    forme_juridique: string | null;
    adresse_rue: string | null;
    adresse_cp: string | null;
    adresse_ville: string | null;
  };
  assert.equal(cachedCreatedRow.raison_sociale, 'Cache Delta');
  assert.equal(cachedCreatedRow.forme_juridique, 'SARL');
  assert.equal(cachedCreatedRow.adresse_rue, '1 rue API');
  assert.equal(cachedCreatedRow.adresse_cp, '75001');
  assert.equal(cachedCreatedRow.adresse_ville, 'Paris');

  cacheApiEntrepriseRecord({ siret: '73282932000017', estRadie: true, raisonSociale: 'Import Radié SARL' });
  const radiatedImportCsv = encodeCsvBase64([
    'identifiant_tlpe,raison_sociale,siret,email,portail_actif,statut',
    'TLPE-2026-00992,Import Radié,73282932000017,radie@example.test,oui,actif',
  ]);
  const previewRadiatedImport = await request(app)
    .post('/api/assujettis/import')
    .set(authHeader(fx.admin))
    .send({ fileName: 'assujettis.csv', contentBase64: radiatedImportCsv, mode: 'preview' });
  assert.equal(previewRadiatedImport.status, 200);
  assert.equal(previewRadiatedImport.body.valid, 0);
  assert.equal(previewRadiatedImport.body.rejected, 1);
  assert.match(JSON.stringify(previewRadiatedImport.body.anomalies), /radié/i);

  const skipRadiatedImport = await request(app)
    .post('/api/assujettis/import')
    .set(authHeader(fx.admin))
    .send({ fileName: 'assujettis.csv', contentBase64: radiatedImportCsv, mode: 'commit', onError: 'skip' });
  assert.equal(skipRadiatedImport.status, 400);
  assert.match(String(skipRadiatedImport.body.error ?? ''), /Aucune ligne valide/i);
});

test('routes coverage smoke: dashboard, simulateur, geocoding et référentiels répondent sur les cas clés', async () => {
  const fx = resetFixtures();
  const app = createApp();

  const invalidZoneSchema = await request(app)
    .post('/api/referentiels/zones')
    .set(authHeader(fx.admin))
    .send({ libelle: '', coefficient: 0 });
  assert.equal(invalidZoneSchema.status, 400);

  const createdZone = await request(app)
    .post('/api/referentiels/zones')
    .set(authHeader(fx.admin))
    .send({
      code: 'Z2',
      libelle: 'Zone 2',
      coefficient: 1.25,
      description: 'Zone secondaire',
    });
  assert.equal(createdZone.status, 201);

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

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        features: [
          {
            properties: {
              label: '10 Rue de Rivoli 75004 Paris',
              postcode: '75004',
              city: 'Paris',
            },
            geometry: { coordinates: [2.3522, 48.8566] },
          },
        ],
      }),
    }) as Response) as typeof fetch;

  try {
    const geoOk = await request(app)
      .get('/api/geocoding/search?q=10%20rue%20de%20rivoli&limit=3')
      .set(authHeader(fx.admin));
    assert.equal(geoOk.status, 200);
    assert.equal(Array.isArray(geoOk.body.suggestions), true);
    assert.equal(geoOk.body.suggestions[0].adresse, '10 Rue de Rivoli 75004 Paris');
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () => ({ ok: false, status: 503 }) as Response) as typeof fetch;
  try {
    const geoUnavailable = await request(app)
      .get('/api/geocoding/search?q=10%20rue%20de%20rivoli')
      .set(authHeader(fx.admin));
    assert.equal(geoUnavailable.status, 503);
    assert.match(String(geoUnavailable.body.error ?? ''), /BAN indisponible/i);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const zonesRes = await request(app).get('/api/referentiels/zones').set(authHeader(fx.admin));
  assert.equal(zonesRes.status, 200);
  assert.equal(zonesRes.body[0].code, 'Z1');

  const zonesGeojsonRes = await request(app).get('/api/referentiels/zones/geojson').set(authHeader(fx.admin));
  assert.equal(zonesGeojsonRes.status, 200);
  assert.equal(zonesGeojsonRes.body.type, 'FeatureCollection');

  db.prepare('UPDATE zones SET geometry = ? WHERE id = ?').run(
    JSON.stringify({
      type: 'Polygon',
      coordinates: [[[2.3, 48.3], [2.4, 48.3], [2.4, 48.4], [2.3, 48.4], [2.3, 48.3]]],
    }),
    fx.zoneId,
  );
  const zonesGeojsonWithGeometry = await request(app).get('/api/referentiels/zones/geojson').set(authHeader(fx.admin));
  assert.equal(zonesGeojsonWithGeometry.status, 200);
  assert.equal(zonesGeojsonWithGeometry.body.features.length, 1);
  assert.equal(zonesGeojsonWithGeometry.body.features[0].properties.code, 'Z1');
  assert.equal(zonesGeojsonWithGeometry.body.features[0].geometry.type, 'Polygon');

  const typesRes = await request(app).get('/api/referentiels/types').set(authHeader(fx.admin));
  assert.equal(typesRes.status, 200);
  assert.equal(typesRes.body.length, 1);

  const createType = await request(app)
    .post('/api/referentiels/types')
    .set(authHeader(fx.admin))
    .send({ code: 'PRE-TEST', libelle: 'Préenseigne test', categorie: 'preenseigne' });
  assert.equal(createType.status, 201);

  const baremesRes = await request(app).get('/api/referentiels/baremes?annee=2026').set(authHeader(fx.admin));
  assert.equal(baremesRes.status, 200);
  assert.equal(baremesRes.body.length, 3);

  const baremesAllRes = await request(app).get('/api/referentiels/baremes').set(authHeader(fx.admin));
  assert.equal(baremesAllRes.status, 200);
  assert.ok(baremesAllRes.body.length >= 3);

  const baremesHistoryRes = await request(app).get('/api/referentiels/baremes/history').set(authHeader(fx.admin));
  assert.equal(baremesHistoryRes.status, 200);
  assert.equal(baremesHistoryRes.body[0].annee, 2026);

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

  const invalidZonesImportSchema = await request(app)
    .post('/api/referentiels/zones/import')
    .set(authHeader(fx.admin))
    .send({ content: 123 });
  assert.equal(invalidZonesImportSchema.status, 400);

  const invalidZonesImportJson = await request(app)
    .post('/api/referentiels/zones/import')
    .set(authHeader(fx.admin))
    .send({ content: 'not-json' });
  assert.equal(invalidZonesImportJson.status, 400);

  const missingGeojson = await request(app)
    .post('/api/referentiels/zones/import')
    .set(authHeader(fx.admin))
    .send({});
  assert.equal(missingGeojson.status, 400);

  const invalidGeojsonImport = await request(app)
    .post('/api/referentiels/zones/import')
    .set(authHeader(fx.admin))
    .send({
      geojson: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { libelle: 'Zone sans code', coefficient: 1.2 },
            geometry: { type: 'Polygon', coordinates: [[[2, 48], [2.1, 48], [2.1, 48.1], [2, 48.1], [2, 48]]] },
          },
        ],
      },
    });
  assert.equal(invalidGeojsonImport.status, 400);

  const validGeojsonImport = await request(app)
    .post('/api/referentiels/zones/import')
    .set(authHeader(fx.admin))
    .send({
      geojson: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { code: 'ZGEO', libelle: 'Zone Geo', coefficient: 1.3, description: 'Importée' },
            geometry: { type: 'Polygon', coordinates: [[[2.3, 48.3], [2.4, 48.3], [2.4, 48.4], [2.3, 48.4], [2.3, 48.3]]] },
          },
        ],
      },
    });
  assert.equal(validGeojsonImport.status, 201);
  assert.equal(validGeojsonImport.body.created, 1);

  const emptyBaremes = await request(app)
    .post('/api/referentiels/baremes/import')
    .set(authHeader(fx.admin))
    .send({ rows: [] });
  assert.equal(emptyBaremes.status, 400);

  const baremesImportSchemaError = await request(app)
    .post('/api/referentiels/baremes/import')
    .set(authHeader(fx.admin))
    .send({ csv: 123 });
  assert.equal(baremesImportSchemaError.status, 400);

  const baremesImportCsvError = await request(app)
    .post('/api/referentiels/baremes/import')
    .set(authHeader(fx.admin))
    .send({ csv: 'annee,categorie,surface_min,tarif_m2,exonere,libelle\n2027,enseigne,0,10,0,Bad row' });
  assert.equal(baremesImportCsvError.status, 400);

  const baremesImportRows = await request(app)
    .post('/api/referentiels/baremes/import')
    .set(authHeader(fx.admin))
    .send({
      rows: [
        {
          annee: 2027,
          categorie: 'enseigne',
          surface_min: 0,
          surface_max: 7,
          tarif_m2: 0,
          tarif_fixe: 0,
          exonere: true,
          libelle: 'Enseigne <= 7m² 2027',
        },
      ],
    });
  assert.equal(baremesImportRows.status, 201);

  const invalidActivation = await request(app)
    .post('/api/referentiels/baremes/activate-year/1999')
    .set(authHeader(fx.admin));
  assert.equal(invalidActivation.status, 400);

  const validActivation = await request(app)
    .post('/api/referentiels/baremes/activate-year/2026')
    .set(authHeader(fx.admin));
  assert.equal(validActivation.status, 200);
  assert.equal(validActivation.body.annee, 2026);

  const missingActivation = await request(app)
    .post('/api/referentiels/baremes/activate-year/2035')
    .set(authHeader(fx.admin));
  assert.equal(missingActivation.status, 200);
  assert.equal(missingActivation.body.activated, false);

  const createdBareme = await request(app)
    .post('/api/referentiels/baremes')
    .set(authHeader(fx.admin))
    .send({
      annee: 2028,
      categorie: 'preenseigne',
      surface_min: 0,
      surface_max: 5,
      tarif_m2: 20,
      tarif_fixe: null,
      exonere: false,
      libelle: 'Préenseigne 2028',
    });
  assert.equal(createdBareme.status, 201);

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

  const invalidExoneration = await request(app)
    .post('/api/referentiels/exonerations')
    .set(authHeader(fx.admin))
    .send({
      type: 'eco',
      critere: { categorie: 'publicitaire' },
      taux: 0.25,
      date_debut: '2026-12-31',
      date_fin: '2026-01-01',
    });
  assert.equal(invalidExoneration.status, 400);

  const inactiveExoneration = await request(app)
    .post('/api/referentiels/exonerations')
    .set(authHeader(fx.admin))
    .send({
      type: 'deliberee',
      critere: { categorie: 'preenseigne' },
      taux: 0.5,
      date_debut: null,
      date_fin: null,
      active: false,
    });
  assert.equal(inactiveExoneration.status, 201);

  const exonerationsRes = await request(app).get('/api/referentiels/exonerations').set(authHeader(fx.admin));
  assert.equal(exonerationsRes.status, 200);
  assert.equal(exonerationsRes.body.length, 2);

  const deleteExoneration = await request(app)
    .delete(`/api/referentiels/exonerations/${createExoneration.body.id}`)
    .set(authHeader(fx.admin));
  assert.equal(deleteExoneration.status, 204);

  const deleteMissingExoneration = await request(app)
    .delete('/api/referentiels/exonerations/999999')
    .set(authHeader(fx.admin));
  assert.equal(deleteMissingExoneration.status, 404);

  const deleteBareme = await request(app)
    .delete(`/api/referentiels/baremes/${createdBareme.body.id}`)
    .set(authHeader(fx.admin));
  assert.equal(deleteBareme.status, 204);

  const deleteMissingBareme = await request(app)
    .delete('/api/referentiels/baremes/999999')
    .set(authHeader(fx.admin));
  assert.equal(deleteMissingBareme.status, 404);
});

test('routes coverage smoke: dispositifs et déclarations couvrent les parcours CRUD essentiels', async () => {
  const fx = resetFixtures();
  const app = createApp();

  const ownList = await request(app).get('/api/dispositifs').set(authHeader(fx.contribuable));
  assert.equal(ownList.status, 200);
  assert.equal(ownList.body.length, 1);

  const adminFilteredList = await request(app)
    .get(`/api/dispositifs?assujetti_id=${fx.contribuableAssujettiId}&statut=declare&zone_id=${fx.zoneId}&type_id=${fx.typeId}&annee=2026&q=Paris`)
    .set(authHeader(fx.admin));
  assert.equal(adminFilteredList.status, 200);
  assert.equal(adminFilteredList.body.length, 1);

  const yearsList = await request(app).get('/api/dispositifs/annees').set(authHeader(fx.contribuable));
  assert.equal(yearsList.status, 200);
  assert.deepEqual(yearsList.body, [2026]);

  const adminYearsList = await request(app)
    .get(`/api/dispositifs/annees?assujetti_id=${fx.contribuableAssujettiId}`)
    .set(authHeader(fx.admin));
  assert.equal(adminYearsList.status, 200);
  assert.deepEqual(adminYearsList.body, [2026]);

  const noAssujettiContribuable = { ...fx.contribuable, assujetti_id: null };
  const emptyDispositifs = await request(app).get('/api/dispositifs').set(authHeader(noAssujettiContribuable));
  assert.equal(emptyDispositifs.status, 200);
  assert.deepEqual(emptyDispositifs.body, []);

  const emptyYears = await request(app).get('/api/dispositifs/annees').set(authHeader(noAssujettiContribuable));
  assert.equal(emptyYears.status, 200);
  assert.deepEqual(emptyYears.body, []);

  const invalidImportSchema = await request(app)
    .post('/api/dispositifs/import')
    .set(authHeader(fx.admin))
    .send({});
  assert.equal(invalidImportSchema.status, 400);

  const invalidImportDecode = await request(app)
    .post('/api/dispositifs/import')
    .set(authHeader(fx.admin))
    .send({
      fileName: 'dispositifs.xlsx',
      contentBase64: 'not-base64',
      mode: 'preview',
    });
  assert.equal(invalidImportDecode.status, 400);

  const importTemplate = await request(app)
    .get('/api/dispositifs/import/template')
    .set(authHeader(fx.admin));
  assert.equal(importTemplate.status, 200);
  assert.match(String(importTemplate.headers['content-type'] ?? ''), /text\/csv/);
  assert.match(String(importTemplate.headers['content-disposition'] ?? ''), /dispositifs-template\.csv/);

  const validImportCsv = encodeCsvBase64([
    'identifiant_assujetti,type_code,adresse,lat,lon,surface,faces,date_pose,zone_code,statut',
    'TLPE-ROUTES-001,ENS,3 rue du Test,48.857,2.353,8,1,2026-01-10,Z1,declare',
  ]);
  const previewImport = await request(app)
    .post('/api/dispositifs/import')
    .set(authHeader(fx.admin))
    .send({
      fileName: 'dispositifs.csv',
      contentBase64: validImportCsv,
      mode: 'preview',
    });
  assert.equal(previewImport.status, 200);
  assert.equal(previewImport.body.valid, 1);

  const invalidImportCsv = encodeCsvBase64([
    'identifiant_assujetti,type_code,adresse,lat,lon,surface,faces,date_pose,zone_code,statut',
    'INCONNU,ENS,,48.1,,0,6,01-01-2026,BAD,invalid',
  ]);
  const abortedImport = await request(app)
    .post('/api/dispositifs/import')
    .set(authHeader(fx.admin))
    .send({
      fileName: 'dispositifs.csv',
      contentBase64: invalidImportCsv,
      mode: 'commit',
      onError: 'abort',
    });
  assert.equal(abortedImport.status, 400);

  const skippedImport = await request(app)
    .post('/api/dispositifs/import')
    .set(authHeader(fx.admin))
    .send({
      fileName: 'dispositifs.csv',
      contentBase64: invalidImportCsv,
      mode: 'commit',
      onError: 'skip',
    });
  assert.equal(skippedImport.status, 400);

  const committedImport = await request(app)
    .post('/api/dispositifs/import')
    .set(authHeader(fx.admin))
    .send({
      fileName: 'dispositifs.csv',
      contentBase64: validImportCsv,
      mode: 'commit',
      onError: 'skip',
    });
  assert.equal(committedImport.status, 201);
  assert.equal(committedImport.body.created, 1);

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

  db.prepare('UPDATE zones SET geometry = ? WHERE id = ?').run(
    JSON.stringify({
      type: 'Polygon',
      coordinates: [[[2.34, 48.85], [2.36, 48.85], [2.36, 48.87], [2.34, 48.87], [2.34, 48.85]]],
    }),
    fx.zoneId,
  );
  const autoZoned = await request(app)
    .post('/api/dispositifs')
    .set(authHeader(fx.admin))
    .send({
      assujetti_id: fx.contribuableAssujettiId,
      type_id: fx.typeId,
      adresse_rue: '3 rue auto-zone',
      adresse_cp: '75003',
      adresse_ville: 'Paris',
      latitude: 48.8566,
      longitude: 2.3522,
      auto_zone: true,
      surface: 9,
      nombre_faces: 1,
    });
  assert.equal(autoZoned.status, 201);
  const autoZonedRow = db.prepare('SELECT zone_id FROM dispositifs WHERE id = ?').get(Number(autoZoned.body.id)) as { zone_id: number | null };
  assert.equal(autoZonedRow.zone_id, fx.zoneId);

  const detail = await request(app).get(`/api/dispositifs/${createdId}`).set(authHeader(fx.contribuable));
  assert.equal(detail.status, 200);
  assert.equal(detail.body.identifiant, created.body.identifiant);

  const missingDetail = await request(app).get('/api/dispositifs/999999').set(authHeader(fx.admin));
  assert.equal(missingDetail.status, 404);

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

  const invalidUpdateDates = await request(app)
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
      date_pose: '2026-12-31',
      date_depose: '2026-01-01',
      statut: 'controle',
    });
  assert.equal(invalidUpdateDates.status, 400);

  const missingUpdate = await request(app)
    .put('/api/dispositifs/999999')
    .set(authHeader(fx.admin))
    .send({
      assujetti_id: fx.contribuableAssujettiId,
      type_id: fx.typeId,
      zone_id: fx.zoneId,
      adresse_rue: 'Rue inconnue',
      adresse_cp: '75002',
      adresse_ville: 'Paris',
      surface: 15,
      nombre_faces: 2,
      statut: 'controle',
    });
  assert.equal(missingUpdate.status, 404);

  const declList = await request(app).get('/api/declarations').set(authHeader(fx.contribuable));
  assert.equal(declList.status, 200);
  assert.equal(declList.body.length, 1);

  const declListFiltered = await request(app)
    .get('/api/declarations?annee=2026&statut=brouillon')
    .set(authHeader(fx.admin));
  assert.equal(declListFiltered.status, 200);
  assert.equal(declListFiltered.body.length, 1);

  const emptyDeclarations = await request(app).get('/api/declarations').set(authHeader(noAssujettiContribuable));
  assert.equal(emptyDeclarations.status, 200);
  assert.deepEqual(emptyDeclarations.body, []);

  const declDetail = await request(app)
    .get(`/api/declarations/${fx.declarationId}`)
    .set(authHeader(fx.contribuable));
  assert.equal(declDetail.status, 200);
  assert.equal(declDetail.body.lignes.length, 1);

  const missingDeclarationDetail = await request(app)
    .get('/api/declarations/999999')
    .set(authHeader(fx.admin));
  assert.equal(missingDeclarationDetail.status, 404);

  const forbiddenDeclarationDetail = await request(app)
    .get(`/api/declarations/${fx.declarationId}`)
    .set(authHeader({ ...fx.contribuable, assujetti_id: fx.otherAssujettiId, email: 'other-declaration@tlpe.local' }));
  assert.equal(forbiddenDeclarationDetail.status, 403);

  const quotePartError = await request(app)
    .put(`/api/declarations/${fx.declarationId}/lignes`)
    .set(authHeader(fx.contribuable))
    .send([
      { dispositif_id: fx.dispositifId, surface_declaree: 10, nombre_faces: 1, quote_part: 0.7 },
      { dispositif_id: fx.dispositifId, surface_declaree: 10, nombre_faces: 1, quote_part: 0.5 },
    ]);
  assert.equal(quotePartError.status, 400);

  const missingDeclarationLines = await request(app)
    .put('/api/declarations/999999/lignes')
    .set(authHeader(fx.admin))
    .send([{ dispositif_id: fx.dispositifId, surface_declaree: 10, nombre_faces: 1, quote_part: 1 }]);
  assert.equal(missingDeclarationLines.status, 404);

  const successfulDeclarationLines = await request(app)
    .put(`/api/declarations/${fx.declarationId}/lignes`)
    .set(authHeader(fx.contribuable))
    .send([
      {
        dispositif_id: fx.dispositifId,
        surface_declaree: 11.5,
        nombre_faces: 2,
        quote_part: 1,
        date_pose: '2026-02-01',
        date_depose: null,
      },
    ]);
  assert.equal(successfulDeclarationLines.status, 200);
  const updatedLine = db.prepare(
    'SELECT surface_declaree, nombre_faces, quote_part, date_pose, date_depose FROM lignes_declaration WHERE declaration_id = ?',
  ).get(fx.declarationId) as {
    surface_declaree: number;
    nombre_faces: number;
    quote_part: number;
    date_pose: string | null;
    date_depose: string | null;
  };
  assert.equal(updatedLine.surface_declaree, 11.5);
  assert.equal(updatedLine.nombre_faces, 2);
  assert.equal(updatedLine.quote_part, 1);
  assert.equal(updatedLine.date_pose, '2026-02-01');
  assert.equal(updatedLine.date_depose, null);

  const forbiddenDeclarationLines = await request(app)
    .put(`/api/declarations/${fx.declarationId}/lignes`)
    .set(authHeader({ ...fx.contribuable, assujetti_id: fx.otherAssujettiId, email: 'other-lines@tlpe.local' }))
    .send([{ dispositif_id: fx.dispositifId, surface_declaree: 10, nombre_faces: 1, quote_part: 1 }]);
  assert.equal(forbiddenDeclarationLines.status, 403);

  db.prepare(`UPDATE declarations SET statut = 'soumise' WHERE id = ?`).run(fx.declarationId);
  const lockedDeclarationLines = await request(app)
    .put(`/api/declarations/${fx.declarationId}/lignes`)
    .set(authHeader(fx.contribuable))
    .send([{ dispositif_id: fx.dispositifId, surface_declaree: 10, nombre_faces: 1, quote_part: 1 }]);
  assert.equal(lockedDeclarationLines.status, 409);
  db.prepare(`UPDATE declarations SET statut = 'brouillon' WHERE id = ?`).run(fx.declarationId);

  const missingReceipt = await request(app)
    .get(`/api/declarations/${fx.declarationId}/receipt/pdf`)
    .set(authHeader(fx.contribuable));
  assert.equal(missingReceipt.status, 404);

  const receiptsDataRoot = path.resolve(__dirname, '..', 'data');
  const receiptRelativePath = 'receipts/test-routes-coverage.pdf';
  fs.mkdirSync(path.join(receiptsDataRoot, 'receipts'), { recursive: true });
  fs.writeFileSync(path.join(receiptsDataRoot, receiptRelativePath), Buffer.from('%PDF-1.4\nroute coverage\n', 'utf8'));
  db.prepare(
    `INSERT INTO declaration_receipts (
      declaration_id, verification_token, payload_hash, pdf_path, generated_by, generated_at, email_status, email_error, email_sent_at
    ) VALUES (?, 'receipt-ok', 'hash-ok', ?, ?, datetime('now'), 'envoye', NULL, datetime('now'))`,
  ).run(fx.declarationId, receiptRelativePath, fx.admin.id);

  const publicVerify = await request(app).get('/api/declarations/receipt/verify/receipt-ok');
  assert.equal(publicVerify.status, 200);
  assert.equal(publicVerify.body.verified, true);
  assert.equal(publicVerify.body.numero, 'DEC-ROUTES-2026-000001');

  const successfulReceipt = await request(app)
    .get(`/api/declarations/${fx.declarationId}/receipt/pdf`)
    .set(authHeader(fx.contribuable));
  assert.equal(successfulReceipt.status, 200);
  assert.match(String(successfulReceipt.headers['content-type'] ?? ''), /application\/pdf/);
  assert.match(String(successfulReceipt.headers['content-disposition'] ?? ''), /accuse-DEC-ROUTES-2026-000001-test-routes-coverage\.pdf/);
  db.prepare('DELETE FROM declaration_receipts WHERE declaration_id = ?').run(fx.declarationId);

  db.prepare(
    `INSERT INTO declaration_receipts (declaration_id, verification_token, payload_hash, pdf_path, generated_by, generated_at)
     VALUES (?, 'receipt-invalid', 'hash-invalid', '../escape.pdf', ?, datetime('now'))`,
  ).run(fx.declarationId, fx.admin.id);
  const invalidReceiptPath = await request(app)
    .get(`/api/declarations/${fx.declarationId}/receipt/pdf`)
    .set(authHeader(fx.contribuable));
  assert.equal(invalidReceiptPath.status, 400);
  db.prepare('DELETE FROM declaration_receipts WHERE declaration_id = ?').run(fx.declarationId);

  db.prepare(
    `INSERT INTO declaration_receipts (declaration_id, verification_token, payload_hash, pdf_path, generated_by, generated_at)
     VALUES (?, 'receipt-missing', 'hash-missing', 'receipts/missing.pdf', ?, datetime('now'))`,
  ).run(fx.declarationId, fx.admin.id);
  const missingReceiptFile = await request(app)
    .get(`/api/declarations/${fx.declarationId}/receipt/pdf`)
    .set(authHeader(fx.contribuable));
  assert.equal(missingReceiptFile.status, 404);

  const forbiddenReceipt = await request(app)
    .get(`/api/declarations/${fx.declarationId}/receipt/pdf`)
    .set(authHeader({ ...fx.contribuable, assujetti_id: fx.otherAssujettiId, email: 'other-receipt@tlpe.local' }));
  assert.equal(forbiddenReceipt.status, 403);
  db.prepare('DELETE FROM declaration_receipts WHERE declaration_id = ?').run(fx.declarationId);

  db.prepare('DELETE FROM lignes_declaration WHERE declaration_id = ?').run(fx.declarationId);
  const submitNoLines = await request(app)
    .post(`/api/declarations/${fx.declarationId}/soumettre`)
    .set(authHeader(fx.contribuable));
  assert.equal(submitNoLines.status, 400);
  db.prepare(
    `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, quote_part, date_pose)
     VALUES (?, ?, 10, 1, 1, '2026-01-01')`,
  ).run(fx.declarationId, fx.dispositifId);

  const forbiddenSubmit = await request(app)
    .post(`/api/declarations/${fx.declarationId}/soumettre`)
    .set(authHeader({ ...fx.contribuable, assujetti_id: fx.otherAssujettiId, email: 'other-submit@tlpe.local' }));
  assert.equal(forbiddenSubmit.status, 403);

  db.prepare(`UPDATE declarations SET statut = 'soumise' WHERE id = ?`).run(fx.declarationId);
  const submitWrongStatus = await request(app)
    .post(`/api/declarations/${fx.declarationId}/soumettre`)
    .set(authHeader(fx.contribuable));
  assert.equal(submitWrongStatus.status, 409);

  const validateSuccess = await request(app)
    .post(`/api/declarations/${fx.declarationId}/valider`)
    .set(authHeader(fx.gestionnaire));
  assert.equal(validateSuccess.status, 200);
  assert.ok(validateSuccess.body.montant_total >= 0);

  const validateWrongStatus = await request(app)
    .post(`/api/declarations/${fx.declarationId}/valider`)
    .set(authHeader(fx.gestionnaire));
  assert.equal(validateWrongStatus.status, 409);

  const rejectWrongStatus = await request(app)
    .post(`/api/declarations/${fx.declarationId}/rejeter`)
    .set(authHeader(fx.gestionnaire))
    .send({ motif: 'Déjà validée' });
  assert.equal(rejectWrongStatus.status, 409);

  const createdDecl = await request(app)
    .post('/api/declarations')
    .set(authHeader(fx.contribuable))
    .send({ assujetti_id: fx.contribuableAssujettiId, annee: 2027 });
  assert.equal(createdDecl.status, 201);
  const createdDeclId = Number(createdDecl.body.id);

  const invalidCreateDeclaration = await request(app)
    .post('/api/declarations')
    .set(authHeader(fx.contribuable))
    .send({ annee: 2027 });
  assert.equal(invalidCreateDeclaration.status, 400);

  const forbiddenCreateDeclaration = await request(app)
    .post('/api/declarations')
    .set(authHeader(fx.contribuable))
    .send({ assujetti_id: fx.otherAssujettiId, annee: 2028 });
  assert.equal(forbiddenCreateDeclaration.status, 403);

  const duplicateDecl = await request(app)
    .post('/api/declarations')
    .set(authHeader(fx.contribuable))
    .send({ assujetti_id: fx.contribuableAssujettiId, annee: 2027 });
  assert.equal(duplicateDecl.status, 409);

  db.prepare(`UPDATE declarations SET statut = 'soumise' WHERE id = ?`).run(createdDeclId);
  const rejectSuccess = await request(app)
    .post(`/api/declarations/${createdDeclId}/rejeter`)
    .set(authHeader(fx.gestionnaire))
    .send({ motif: 'Pièce manquante' });
  assert.equal(rejectSuccess.status, 200);

  const conflictDelete = await request(app).delete(`/api/dispositifs/${createdId}`).set(authHeader(fx.admin));
  assert.equal(conflictDelete.status, 409);

  db.prepare('DELETE FROM lignes_declaration WHERE dispositif_id = ?').run(createdId);
  const deleted = await request(app).delete(`/api/dispositifs/${createdId}`).set(authHeader(fx.admin));
  assert.equal(deleted.status, 204);

  const missingDelete = await request(app).delete('/api/dispositifs/999999').set(authHeader(fx.admin));
  assert.equal(missingDelete.status, 404);
});

test('routes coverage smoke: campagnes couvrent création, synthèse, ouverture et clôture', async () => {
  const fx = resetFixtures();
  const app = createApp();

  const invalidSummaryId = await request(app).get('/api/campagnes/abc/summary').set(authHeader(fx.gestionnaire));
  assert.equal(invalidSummaryId.status, 400);

  const invalidOpenId = await request(app).post('/api/campagnes/0/open').set(authHeader(fx.gestionnaire));
  assert.equal(invalidOpenId.status, 400);

  const invalidSendId = await request(app)
    .post('/api/campagnes/abc/envoyer-invitations')
    .set(authHeader(fx.gestionnaire))
    .send({});
  assert.equal(invalidSendId.status, 400);

  const invalidRelancesId = await request(app)
    .post('/api/campagnes/abc/run-relances')
    .set(authHeader(fx.gestionnaire))
    .send({});
  assert.equal(invalidRelancesId.status, 400);

  const invalidCloseId = await request(app).post('/api/campagnes/0/close').set(authHeader(fx.gestionnaire));
  assert.equal(invalidCloseId.status, 400);

  const activeBefore = await request(app).get('/api/campagnes/active').set(authHeader(fx.gestionnaire));
  assert.equal(activeBefore.status, 200);
  assert.equal(activeBefore.body.campagne, null);

  const invalidCreate = await request(app)
    .post('/api/campagnes')
    .set(authHeader(fx.gestionnaire))
    .send({ annee: '2026' });
  assert.equal(invalidCreate.status, 400);

  const invalidCalendarCreate = await request(app)
    .post('/api/campagnes')
    .set(authHeader(fx.gestionnaire))
    .send({
      annee: 2025,
      date_ouverture: '2025-02-31',
      date_limite_declaration: '2025-03-31',
      date_cloture: '2025-04-01',
    });
  assert.equal(invalidCalendarCreate.status, 400);

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

  const duplicateCreate = await request(app)
    .post('/api/campagnes')
    .set(authHeader(fx.gestionnaire))
    .send({
      annee: 2026,
      date_ouverture: '2026-01-01',
      date_limite_declaration: '2026-03-31',
      date_cloture: '2026-04-01',
    });
  assert.equal(duplicateCreate.status, 409);

  const list = await request(app).get('/api/campagnes').set(authHeader(fx.gestionnaire));
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);

  const summary = await request(app).get(`/api/campagnes/${campagneId}/summary`).set(authHeader(fx.gestionnaire));
  assert.equal(summary.status, 200);
  assert.equal(summary.body.campagne.id, campagneId);

  const missingSummary = await request(app).get('/api/campagnes/999999/summary').set(authHeader(fx.gestionnaire));
  assert.equal(missingSummary.status, 404);

  const sendInvitationsWhileDraft = await request(app)
    .post(`/api/campagnes/${campagneId}/envoyer-invitations`)
    .set(authHeader(fx.gestionnaire))
    .send({ assujetti_id: fx.contribuableAssujettiId });
  assert.equal(sendInvitationsWhileDraft.status, 409);

  const invalidInvitationsBody = await request(app)
    .post(`/api/campagnes/${campagneId}/envoyer-invitations`)
    .set(authHeader(fx.gestionnaire))
    .send({ assujetti_id: -1 });
  assert.equal(invalidInvitationsBody.status, 400);

  const missingOpen = await request(app).post('/api/campagnes/999999/open').set(authHeader(fx.gestionnaire));
  assert.equal(missingOpen.status, 404);

  const closeWhileDraft = await request(app).post(`/api/campagnes/${campagneId}/close`).set(authHeader(fx.gestionnaire));
  assert.equal(closeWhileDraft.status, 409);

  const relancesWhileDraft = await request(app)
    .post(`/api/campagnes/${campagneId}/run-relances`)
    .set(authHeader(fx.gestionnaire))
    .send({ run_date: '2026-03-16' });
  assert.equal(relancesWhileDraft.status, 409);

  const openRes = await request(app).post(`/api/campagnes/${campagneId}/open`).set(authHeader(fx.gestionnaire));
  assert.equal(openRes.status, 200);
  assert.equal(openRes.body.ok, true);

  const activeAfterOpen = await request(app).get('/api/campagnes/active').set(authHeader(fx.gestionnaire));
  assert.equal(activeAfterOpen.status, 200);
  assert.equal(activeAfterOpen.body.campagne.id, campagneId);

  const reopenOpenCampaign = await request(app).post(`/api/campagnes/${campagneId}/open`).set(authHeader(fx.gestionnaire));
  assert.equal(reopenOpenCampaign.status, 409);

  const invalidRunRelancesBody = await request(app)
    .post(`/api/campagnes/${campagneId}/run-relances`)
    .set(authHeader(fx.gestionnaire))
    .send({ run_date: '2026/03/16' });
  assert.equal(invalidRunRelancesBody.status, 400);

  const sendInvitations = await request(app)
    .post(`/api/campagnes/${campagneId}/envoyer-invitations`)
    .set(authHeader(fx.gestionnaire))
    .send({ assujetti_id: fx.contribuableAssujettiId });
  assert.equal(sendInvitations.status, 200);

  const runRelancesSuccess = await request(app)
    .post(`/api/campagnes/${campagneId}/run-relances`)
    .set(authHeader(fx.gestionnaire))
    .send({ run_date: '2026-03-16' });
  assert.equal(runRelancesSuccess.status, 200);
  assert.equal(runRelancesSuccess.body.ok, true);

  const runRelancesMismatch = await request(app)
    .post(`/api/campagnes/${campagneId}/run-relances`)
    .set(authHeader(fx.gestionnaire))
    .send({ run_date: '2026-04-02' });
  assert.equal(runRelancesMismatch.status, 409);

  const closeRes = await request(app).post(`/api/campagnes/${campagneId}/close`).set(authHeader(fx.gestionnaire));
  assert.equal(closeRes.status, 200);
  assert.equal(closeRes.body.ok, true);

  const missingClose = await request(app).post('/api/campagnes/999999/close').set(authHeader(fx.gestionnaire));
  assert.equal(missingClose.status, 404);

  const reopenClosedCampaign = await request(app).post(`/api/campagnes/${campagneId}/open`).set(authHeader(fx.gestionnaire));
  assert.equal(reopenClosedCampaign.status, 409);

  const missingSendInvitations = await request(app)
    .post('/api/campagnes/999999/envoyer-invitations')
    .set(authHeader(fx.gestionnaire))
    .send({ assujetti_id: fx.contribuableAssujettiId });
  assert.equal(missingSendInvitations.status, 404);

  const sendInvitationsClosed = await request(app)
    .post(`/api/campagnes/${campagneId}/envoyer-invitations`)
    .set(authHeader(fx.gestionnaire))
    .send({ assujetti_id: fx.contribuableAssujettiId });
  assert.equal(sendInvitationsClosed.status, 409);

  const missingRunRelances = await request(app)
    .post('/api/campagnes/999999/run-relances')
    .set(authHeader(fx.gestionnaire))
    .send({ run_date: '2026-03-16' });
  assert.equal(missingRunRelances.status, 404);

  const runRelancesClosed = await request(app)
    .post(`/api/campagnes/${campagneId}/run-relances`)
    .set(authHeader(fx.gestionnaire))
    .send({ run_date: '2026-03-16' });
  assert.equal(runRelancesClosed.status, 409);
});