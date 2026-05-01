import test from 'node:test';
import assert from 'node:assert/strict';
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
      disposition: res.headers.get('content-disposition') || '',
      text,
      json: contentType.includes('application/json') ? JSON.parse(text) : null,
    };
  } finally {
    server.close();
  }
}

function resetFixtures() {
  initSchema();
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('DELETE FROM declaration_receipts');
    db.exec('DELETE FROM notifications_email');
    db.exec('DELETE FROM invitation_magic_links');
    db.exec('DELETE FROM campagne_jobs');
    db.exec('DELETE FROM mises_en_demeure');
    db.exec('DELETE FROM paiements');
    db.exec('DELETE FROM pesv2_export_titres');
    db.exec('DELETE FROM pesv2_exports');
    db.exec('DELETE FROM recouvrement_actions');
    db.exec('DELETE FROM titres_executoires');
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
  } finally {
    db.pragma('foreign_keys = ON');
  }

  const typeId = Number(
    db.prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('ENS-EXEC', 'Enseigne Exec', 'enseigne')`).run()
      .lastInsertRowid,
  );
  const assujettiId = Number(
    db.prepare(
      `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, siret, email, statut)
       VALUES ('TLPE-EXEC-001', 'Alpha Exec', '12345678901234', 'alpha.exec@example.fr', 'actif')`,
    ).run().lastInsertRowid,
  );
  const financierId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES ('financier-exec@tlpe.local', ?, 'Fin', 'Exec', 'financier', 1)`,
    ).run(hashPassword('x')).lastInsertRowid,
  );
  const contribuableId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, assujetti_id, actif)
       VALUES ('contribuable-exec@tlpe.local', ?, 'Contrib', 'Exec', 'contribuable', ?, 1)`,
    ).run(hashPassword('x'), assujettiId).lastInsertRowid,
  );

  const declarationTransmiseId = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-EXEC-2026-001', ?, 2026, 'validee', 500)`,
    ).run(assujettiId).lastInsertRowid,
  );
  const declarationNonEligibleId = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-EXEC-2025-002', ?, 2025, 'validee', 300)`,
    ).run(assujettiId).lastInsertRowid,
  );

  const dispositifId = Number(
    db.prepare(
      `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, adresse_rue, adresse_cp, adresse_ville, statut)
       VALUES ('DSP-EXEC-001', ?, ?, 8.5, 2, '1 rue Exec', '33000', 'Bordeaux', 'declare')`,
    ).run(assujettiId, typeId).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, quote_part, date_pose, montant_ligne)
     VALUES (?, ?, 8.5, 2, 1.0, '2026-01-01', 500)`,
  ).run(declarationTransmiseId, dispositifId);
  db.prepare(
    `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, quote_part, date_pose, montant_ligne)
     VALUES (?, ?, 4.2, 1, 1.0, '2026-01-01', 300)`,
  ).run(declarationNonEligibleId, dispositifId);

  const titreMiseEnDemeureId = Number(
    db.prepare(
      `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut, montant_paye)
       VALUES ('TIT-2026-009901', ?, ?, 2026, 500, '2026-04-01', '2026-08-31', 'mise_en_demeure', 0)`,
    ).run(declarationTransmiseId, assujettiId).lastInsertRowid,
  );
  const titreImpayeId = Number(
    db.prepare(
      `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut, montant_paye)
       VALUES ('TIT-2026-009902', ?, ?, 2026, 300, '2026-04-01', '2026-08-31', 'impaye', 0)`,
    ).run(declarationNonEligibleId, assujettiId).lastInsertRowid,
  );

  return {
    financier: {
      id: financierId,
      email: 'financier-exec@tlpe.local',
      role: 'financier' as const,
      nom: 'Fin',
      prenom: 'Exec',
      assujetti_id: null,
    },
    contribuable: {
      id: contribuableId,
      email: 'contribuable-exec@tlpe.local',
      role: 'contribuable' as const,
      nom: 'Contrib',
      prenom: 'Exec',
      assujetti_id: assujettiId,
    },
    titreMiseEnDemeureId,
    titreImpayeId,
  };
}

test('POST /api/titres/:id/rendre-executoire transmet un titre au comptable public, persiste le flux XML et journalise l action', async () => {
  const fx = resetFixtures();

  const res = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreMiseEnDemeureId}/rendre-executoire`,
    headers: makeAuthHeader(fx.financier),
  });

  assert.equal(res.status, 200);
  assert.match(res.contentType, /application\/xml/);
  assert.match(res.disposition, /titre-executoire-000001\.xml/);
  assert.match(res.text, /TitreExecutoireComplement/);
  assert.match(res.text, /TIT-2026-009901/);
  assert.match(res.text, /Visa pour transmission au comptable public/);

  const titre = db.prepare('SELECT statut FROM titres WHERE id = ?').get(fx.titreMiseEnDemeureId) as { statut: string };
  assert.equal(titre.statut, 'transmis_comptable');

  const exportRow = db.prepare(
    `SELECT numero_flux, xml_filename, xsd_validation_ok, xml_hash
     FROM titres_executoires
     WHERE titre_id = ?`,
  ).get(fx.titreMiseEnDemeureId) as
    | { numero_flux: number; xml_filename: string; xsd_validation_ok: number; xml_hash: string }
    | undefined;
  assert.ok(exportRow);
  assert.equal(exportRow!.numero_flux, 1);
  assert.equal(exportRow!.xml_filename, 'titre-executoire-000001.xml');
  assert.equal(exportRow!.xsd_validation_ok, 1);
  assert.match(exportRow!.xml_hash, /^[a-f0-9]{64}$/);

  const history = await request({
    method: 'GET',
    path: `/api/titres/${fx.titreMiseEnDemeureId}/historique`,
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(history.status, 200);
  assert.equal(history.json.actions[0].action_type, 'transmission_comptable');
  assert.equal(history.json.actions[0].statut, 'transmis');
  assert.match(history.json.actions[0].details, /executoire\/xml/);

  const audit = db.prepare(
    `SELECT action, details
     FROM audit_log
     WHERE action = 'rendre-executoire' AND entite = 'titre' AND entite_id = ?`,
  ).get(fx.titreMiseEnDemeureId) as { action: string; details: string } | undefined;
  assert.ok(audit);
  assert.match(audit!.details, /transmis_comptable/);
});

test('POST /api/titres/:id/rendre-executoire rejette les titres hors statut mise_en_demeure et refuse le rôle contribuable', async () => {
  const fx = resetFixtures();

  const forbidden = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreMiseEnDemeureId}/rendre-executoire`,
    headers: makeAuthHeader(fx.contribuable),
  });
  assert.equal(forbidden.status, 403);

  const invalid = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreImpayeId}/rendre-executoire`,
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(invalid.status, 409);
  assert.match(invalid.text, /mise en demeure/i);
});

test('GET /api/titres/:id/executoire/xml télécharge le flux persistant après transmission', async () => {
  const fx = resetFixtures();
  const created = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreMiseEnDemeureId}/rendre-executoire`,
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(created.status, 200);

  const res = await request({
    method: 'GET',
    path: `/api/titres/${fx.titreMiseEnDemeureId}/executoire/xml`,
    headers: makeAuthHeader(fx.financier),
  });

  assert.equal(res.status, 200);
  assert.match(res.contentType, /application\/xml/);
  assert.match(res.text, /TIT-2026-009901/);
});

test('GET /api/titres/:id/executoire/xml et POST /api/titres/:id/rendre-executoire gèrent les erreurs d’accès et d’état', async () => {
  const fx = resetFixtures();

  const missingTitle = await request({
    method: 'POST',
    path: '/api/titres/999999/rendre-executoire',
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(missingTitle.status, 404);

  const xmlBeforeTransmission = await request({
    method: 'GET',
    path: `/api/titres/${fx.titreMiseEnDemeureId}/executoire/xml`,
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(xmlBeforeTransmission.status, 404);

  const transmitted = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreMiseEnDemeureId}/rendre-executoire`,
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(transmitted.status, 200);

  const duplicateTransmission = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreMiseEnDemeureId}/rendre-executoire`,
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(duplicateTransmission.status, 409);

  const outsider = await request({
    method: 'GET',
    path: `/api/titres/${fx.titreMiseEnDemeureId}/executoire/xml`,
    headers: makeAuthHeader({
      ...fx.contribuable,
      assujetti_id: 999999,
      email: 'outsider-exec@tlpe.local',
    }),
  });
  assert.equal(outsider.status, 403);
});

test('POST /api/titres/:id/admettre-non-valeur valide le body et refuse un titre non transmis', async () => {
  const fx = resetFixtures();

  const invalidBody = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreMiseEnDemeureId}/admettre-non-valeur`,
    headers: makeAuthHeader(fx.financier),
    body: { commentaire: 'x' },
  });
  assert.equal(invalidBody.status, 400);

  const notTransmitted = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreMiseEnDemeureId}/admettre-non-valeur`,
    headers: makeAuthHeader(fx.financier),
    body: { commentaire: 'Trop tôt pour un retour comptable' },
  });
  assert.equal(notTransmitted.status, 409);
});

test('POST /api/titres émet un titre, applique une échéance par défaut et gère les conflits métier', async () => {
  const fx = resetFixtures();

  const declarationId = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-EXEC-2027-001', (SELECT assujetti_id FROM titres WHERE id = ?), 2027, 'validee', 420)`,
    ).run(fx.titreMiseEnDemeureId).lastInsertRowid,
  );

  const emitted = await request({
    method: 'POST',
    path: '/api/titres',
    headers: makeAuthHeader(fx.financier),
    body: { declaration_id: declarationId },
  });
  assert.equal(emitted.status, 201);
  assert.match(String(emitted.json.numero), /^TIT-2027-/);

  const emittedRow = db.prepare(
    `SELECT date_echeance, statut FROM titres WHERE id = ?`,
  ).get(Number(emitted.json.id)) as { date_echeance: string; statut: string };
  assert.equal(emittedRow.date_echeance, '2027-08-31');
  assert.equal(emittedRow.statut, 'emis');

  const duplicate = await request({
    method: 'POST',
    path: '/api/titres',
    headers: makeAuthHeader(fx.financier),
    body: { declaration_id: declarationId },
  });
  assert.equal(duplicate.status, 409);

  const draftDeclarationId = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-EXEC-2028-002', (SELECT assujetti_id FROM titres WHERE id = ?), 2028, 'brouillon', 100)`,
    ).run(fx.titreMiseEnDemeureId).lastInsertRowid,
  );
  const notValidated = await request({
    method: 'POST',
    path: '/api/titres',
    headers: makeAuthHeader(fx.financier),
    body: { declaration_id: draftDeclarationId },
  });
  assert.equal(notValidated.status, 409);

  const missingAmountDeclarationId = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-EXEC-2029-003', (SELECT assujetti_id FROM titres WHERE id = ?), 2029, 'validee', NULL)`,
    ).run(fx.titreMiseEnDemeureId).lastInsertRowid,
  );
  const missingAmount = await request({
    method: 'POST',
    path: '/api/titres',
    headers: makeAuthHeader(fx.financier),
    body: { declaration_id: missingAmountDeclarationId },
  });
  assert.equal(missingAmount.status, 409);

  const missingDeclaration = await request({
    method: 'POST',
    path: '/api/titres',
    headers: makeAuthHeader(fx.financier),
    body: { declaration_id: 999999 },
  });
  assert.equal(missingDeclaration.status, 404);
});

test('POST /api/titres/:id/paiements enregistre des paiements partiels puis complets et rejette les cas invalides', async () => {
  const fx = resetFixtures();

  const missingTitle = await request({
    method: 'POST',
    path: '/api/titres/999999/paiements',
    headers: makeAuthHeader(fx.financier),
    body: { montant: 50, date_paiement: '2026-04-15', modalite: 'virement' },
  });
  assert.equal(missingTitle.status, 404);

  const invalidPayload = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreImpayeId}/paiements`,
    headers: makeAuthHeader(fx.financier),
    body: { montant: -5, date_paiement: '2026-04-15', modalite: 'virement' },
  });
  assert.equal(invalidPayload.status, 400);

  const partial = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreImpayeId}/paiements`,
    headers: makeAuthHeader(fx.financier),
    body: { montant: 100, date_paiement: '2026-04-15', modalite: 'virement', reference: 'PAY-PARTIAL' },
  });
  assert.equal(partial.status, 201);
  assert.equal(partial.json.montant_paye, 100);
  assert.equal(partial.json.statut, 'paye_partiel');

  const complete = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreImpayeId}/paiements`,
    headers: makeAuthHeader(fx.financier),
    body: { montant: 200, date_paiement: '2026-04-16', modalite: 'cheque', reference: 'PAY-COMPLETE' },
  });
  assert.equal(complete.status, 201);
  assert.equal(complete.json.montant_paye, 300);
  assert.equal(complete.json.statut, 'paye');

  const paymentsList = await request({
    method: 'GET',
    path: `/api/titres/${fx.titreImpayeId}/paiements`,
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(paymentsList.status, 200);
  assert.equal(paymentsList.json.length, 2);
});

test('POST /api/titres/:id/admettre-non-valeur bascule le titre et ajoute un événement de retour comptable', async () => {
  const fx = resetFixtures();
  const created = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreMiseEnDemeureId}/rendre-executoire`,
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(created.status, 200);

  const admitted = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreMiseEnDemeureId}/admettre-non-valeur`,
    headers: makeAuthHeader(fx.financier),
    body: { commentaire: 'Retour comptable negatif - creance irrecouvrable' },
  });

  assert.equal(admitted.status, 200);
  assert.equal(admitted.json.statut, 'admis_en_non_valeur');

  const titre = db.prepare('SELECT statut FROM titres WHERE id = ?').get(fx.titreMiseEnDemeureId) as { statut: string };
  assert.equal(titre.statut, 'admis_en_non_valeur');

  const history = await request({
    method: 'GET',
    path: `/api/titres/${fx.titreMiseEnDemeureId}/historique`,
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(history.status, 200);
  assert.equal(history.json.actions[0].action_type, 'admission_non_valeur');
  assert.equal(history.json.actions[0].niveau, 'retour_comptable');
  assert.equal(history.json.actions[0].statut, 'classe');
});
