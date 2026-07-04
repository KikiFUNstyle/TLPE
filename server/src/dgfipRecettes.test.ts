import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import express from 'express';
import { db, initSchema } from './db';
import { hashPassword, signToken, type AuthUser } from './auth';
import { dgfipRecettesRouter } from './routes/dgfipRecettes';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/dgfip-recettes', dgfipRecettesRouter);
  return app;
}

function makeAuthHeader(user: AuthUser): Record<string, string> {
  return { Authorization: `Bearer ${signToken(user)}` };
}

async function request(params: {
  method: 'POST' | 'GET';
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
        'Content-Type': 'application/json',
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
    };
  } finally {
    server.close();
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
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

  // Nettoyer nos tables DGFiP
  const hasDgfipTables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dgfip_recettes_exports'").get() as
      | { name: string }
      | undefined
  )?.name === 'dgfip_recettes_exports';
  if (hasDgfipTables) {
    db.exec('DELETE FROM dgfip_recettes_export_titres');
    db.exec('DELETE FROM dgfip_recettes_exports');
  }

  const hasPesv2Exports = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pesv2_exports'").get() as
      | { name: string }
      | undefined
  )?.name === 'pesv2_exports';
  if (hasPesv2Exports) {
    db.exec('DELETE FROM pesv2_export_titres');
    db.exec('DELETE FROM pesv2_exports');
  }
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
    db.prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('ENS-DGF', 'Enseigne DGF', 'enseigne')`).run()
      .lastInsertRowid,
  );

  const financierId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES ('financier-dgf@tlpe.local', ?, 'Fin', 'Dgf', 'financier', 1)`,
    ).run(hashPassword('x')).lastInsertRowid,
  );

  // Assujettis avec SIRET pour l'export DGFiP
  const assujettiA = Number(
    db.prepare(
      `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, siret, adresse_rue, adresse_cp, adresse_ville, statut)
       VALUES ('TLPE-DGF-001', 'Alpha Publicite DGF', '12345678901234', '1 rue de la TLPE', '75001', 'Paris', 'actif')`,
    ).run().lastInsertRowid,
  );
  const assujettiB = Number(
    db.prepare(
      `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, siret, adresse_rue, adresse_cp, adresse_ville, statut)
       VALUES ('TLPE-DGF-002', 'Beta Enseignes DGF', '22345678901234', '2 avenue des Recettes', '69002', 'Lyon', 'actif')`,
    ).run().lastInsertRowid,
  );

  // Créer des déclarations pour 2026
  const declarationA = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-DGF-2026-001', ?, 2026, 'validee', 2400)`,
    ).run(assujettiA).lastInsertRowid,
  );
  const declarationB = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-DGF-2026-002', ?, 2026, 'validee', 800)`,
    ).run(assujettiB).lastInsertRowid,
  );
  const declaration2025 = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-DGF-2025-001', ?, 2025, 'validee', 999)`,
    ).run(assujettiA).lastInsertRowid,
  );

  // Dispositifs
  const dispositifA = Number(
    db.prepare(
      `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, statut)
       VALUES ('DSP-DGF-001', ?, ?, 24, 1, 'declare')`,
    ).run(assujettiA, typeId).lastInsertRowid,
  );
  const dispositifB = Number(
    db.prepare(
      `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, statut)
       VALUES ('DSP-DGF-002', ?, ?, 8, 2, 'declare')`,
    ).run(assujettiB, typeId).lastInsertRowid,
  );

  // Lignes de déclaration
  db.prepare(
    `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne)
     VALUES (?, ?, 24, 1, '2026-01-15', 2400)`,
  ).run(declarationA, dispositifA);
  db.prepare(
    `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne)
     VALUES (?, ?, 8, 2, '2026-02-20', 800)`,
  ).run(declarationB, dispositifB);

  // Titres émis (2026)
  const titreA = Number(
    db.prepare(
      `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut)
       VALUES ('TIT-DGF-2026-001', ?, ?, 2026, 2400, '2026-04-01', '2026-08-31', 'paye')`,
    ).run(declarationA, assujettiA).lastInsertRowid,
  );
  const titreB = Number(
    db.prepare(
      `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut, montant_paye)
       VALUES ('TIT-DGF-2026-002', ?, ?, 2026, 800, '2026-05-10', '2026-08-31', 'paye_partiel', 500)`,
    ).run(declarationB, assujettiB).lastInsertRowid,
  );
  const titre2025 = Number(
    db.prepare(
      `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut)
       VALUES ('TIT-DGF-2025-001', ?, ?, 2025, 999, '2025-03-01', '2025-08-31', 'paye')`,
    ).run(declaration2025, assujettiA).lastInsertRowid,
  );

  // Paiements
  db.prepare(
    `INSERT INTO paiements (titre_id, montant, date_paiement, modalite, reference, statut)
     VALUES (?, 2400, '2026-05-15', 'virement', 'VIRE-2026-001', 'confirme')`,
  ).run(titreA);
  db.prepare(
    `INSERT INTO paiements (titre_id, montant, date_paiement, modalite, reference, statut)
     VALUES (?, 300, '2026-06-01', 'cheque', 'CHQ-2026-002', 'confirme')`,
  ).run(titreB);
  db.prepare(
    `INSERT INTO paiements (titre_id, montant, date_paiement, modalite, reference, statut)
     VALUES (?, 200, '2026-06-15', 'virement', 'VIRE-2026-003', 'confirme')`,
  ).run(titreB);
  db.prepare(
    `INSERT INTO paiements (titre_id, montant, date_paiement, modalite, reference, statut)
     VALUES (?, 999, '2025-06-01', 'virement', 'VIRE-2025-001', 'confirme')`,
  ).run(titre2025);

  return {
    financier: {
      id: financierId,
      email: 'financier-dgf@tlpe.local',
      role: 'financier' as const,
      nom: 'Fin',
      prenom: 'Dgf',
      assujetti_id: null,
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

test('POST /api/dgfip-recettes/export exporte un XML DGFiP recettes pour une année avec contrôle de cohérence', async () => {
  const fx = resetFixtures();

  const res = await request({
    method: 'POST',
    path: '/api/dgfip-recettes/export',
    headers: makeAuthHeader(fx.financier),
    body: { annee: 2026 },
  });

  assert.equal(res.status, 201, `Statut attendu 201, reçu ${res.status}: ${res.text}`);
  assert.ok(res.contentType?.includes('application/json'), 'Content-Type doit être JSON');

  const data = parseJson(res.text) as Record<string, unknown>;
  assert.ok(data, 'La réponse doit être un JSON valide');
  assert.ok(typeof data.export_id === 'number', 'Doit retourner un export_id');
  assert.ok(typeof data.numero_bordereau === 'number', 'Doit retourner un numero_bordereau');
  assert.ok(typeof data.filename === 'string', 'Doit retourner un filename');
  assert.ok(data.filename?.toString().endsWith('.xml'), 'Le fichier doit être un XML');
  assert.equal(data.coherence_ok, true, 'La cohérence des montants doit être vérifiée');

  const recap = data.recapitulatif as Record<string, unknown>;
  assert.equal(recap.titres_count, 2, 'Doit inclure 2 titres pour 2026');
  assert.equal(recap.total_montant_brut, 3200, 'Montant brut = 2400 + 800 = 3200');
  assert.equal(recap.total_montant_recouvre, 2900, 'Montant recouvré = 2400 + 500 = 2900');
  assert.equal(recap.total_montant_impaye, 300, 'Montant impayé = 800 - 500 = 300');
});

test('POST /api/dgfip-recettes/export retourne 400 pour une année invalide', async () => {
  const fx = resetFixtures();

  const res = await request({
    method: 'POST',
    path: '/api/dgfip-recettes/export',
    headers: makeAuthHeader(fx.financier),
    body: { annee: 1999 },
  });

  assert.equal(res.status, 400, 'Doit retourner 400 pour année < 2020');
});

test('POST /api/dgfip-recettes/export retourne 400 pour un corps vide', async () => {
  const fx = resetFixtures();

  const res = await request({
    method: 'POST',
    path: '/api/dgfip-recettes/export',
    headers: makeAuthHeader(fx.financier),
    body: {},
  });

  assert.equal(res.status, 400, 'Doit retourner 400 pour corps vide');
});

test('POST /api/dgfip-recettes/export rejette un utilisateur non autorisé', async () => {
  const fx = resetFixtures();

  const contribuable = {
    id: 999,
    email: 'contrib@tlpe.local',
    role: 'contribuable' as const,
    nom: 'Contrib',
    prenom: 'Test',
    assujetti_id: 1,
  };

  const res = await request({
    method: 'POST',
    path: '/api/dgfip-recettes/export',
    headers: makeAuthHeader(contribuable),
    body: { annee: 2026 },
  });

  assert.equal(res.status, 403, 'Un contribuable ne doit pas pouvoir exporter');
});

test('POST /api/dgfip-recettes/export retourne 401 sans authentification', async () => {
  const res = await request({
    method: 'POST',
    path: '/api/dgfip-recettes/export',
    body: { annee: 2026 },
  });

  assert.equal(res.status, 401, 'Doit retourner 401 sans token');
});

test('POST /api/dgfip-recettes/export supporte un export trimestriel avec signature optionnelle', async () => {
  const fx = resetFixtures();

  const res = await request({
    method: 'POST',
    path: '/api/dgfip-recettes/export',
    headers: makeAuthHeader(fx.financier),
    body: {
      annee: 2026,
      trimestre: 1,
      signature: {
        signataire: 'Marie Ordonnateur',
        fonction: 'Ordonnateur TLPE',
      },
    },
  });

  assert.equal(res.status, 201, `Statut attendu 201, reçu ${res.status}: ${res.text}`);
  const data = parseJson(res.text) as Record<string, unknown>;
  assert.ok(data, 'La réponse doit être un JSON valide');
  assert.equal(data.coherence_ok, true);
});

test('GET /api/dgfip-recettes/exports liste les exports existants', async () => {
  const fx = resetFixtures();

  // Créer un export d'abord
  const createRes = await request({
    method: 'POST',
    path: '/api/dgfip-recettes/export',
    headers: makeAuthHeader(fx.financier),
    body: { annee: 2026 },
  });
  assert.equal(createRes.status, 201, 'Création de l\'export pour le test');

  // Lister
  const res = await request({
    method: 'GET',
    path: '/api/dgfip-recettes/exports',
    headers: makeAuthHeader(fx.financier),
  });

  assert.equal(res.status, 200, 'Doit retourner 200');
  assert.ok(res.contentType?.includes('application/json'), 'Content-Type doit être JSON');
  const data = parseJson(res.text) as { exports?: unknown[] };
  assert.ok(Array.isArray(data?.exports), 'Doit retourner un tableau exports');
  assert.ok(data.exports!.length >= 1, 'Doit contenir au moins l\'export créé');
});

test('GET /api/dgfip-recettes/exports/:id/download télécharge le XML', async () => {
  const fx = resetFixtures();

  const createRes = await request({
    method: 'POST',
    path: '/api/dgfip-recettes/export',
    headers: makeAuthHeader(fx.financier),
    body: { annee: 2025 },
  });
  assert.equal(createRes.status, 201);
  const created = parseJson(createRes.text) as { export_id?: number };
  const exportId = created.export_id;

  const res = await request({
    method: 'GET',
    path: `/api/dgfip-recettes/exports/${exportId}/download`,
    headers: makeAuthHeader(fx.financier),
  });

  assert.equal(res.status, 200, 'Doit retourner 200');
  assert.ok(res.contentType?.includes('application/xml'), 'Content-Type doit être XML');
  assert.ok(res.disposition?.includes('.xml'), 'Doit proposer un download XML');
  assert.ok(res.text.includes('DGFiPRecettesFiscales'), 'Le XML doit contenir la balise racine');
  assert.ok(res.text.includes('<Annee>2025</Annee>'), 'Le XML doit contenir l\'année 2025');
});

test('GET /api/dgfip-recettes/exports/99999/download retourne 404', async () => {
  const fx = resetFixtures();

  const res = await request({
    method: 'GET',
    path: '/api/dgfip-recettes/exports/99999/download',
    headers: makeAuthHeader(fx.financier),
  });

  assert.equal(res.status, 404, 'Doit retourner 404 pour un export inexistant');
});

test('Le XML généré est valide et parseable', async () => {
  const fx = resetFixtures();

  const res = await request({
    method: 'POST',
    path: '/api/dgfip-recettes/export',
    headers: makeAuthHeader(fx.financier),
    body: { annee: 2026 },
  });
  assert.equal(res.status, 201);

  // Récupérer le XML via download
  const created = parseJson(res.text) as { export_id?: number };
  const downloadRes = await request({
    method: 'GET',
    path: `/api/dgfip-recettes/exports/${created.export_id}/download`,
    headers: makeAuthHeader(fx.financier),
  });

  assert.equal(downloadRes.status, 200);
  const xml = downloadRes.text;

  // Vérifications structurelles de base du XML
  assert.ok(xml.includes('<?xml version="1.0"'), 'Doit commencer par une déclaration XML');
  assert.ok(xml.includes('<DGFiPRecettesFiscales>'), 'Doit contenir la racine');
  assert.ok(xml.includes('</DGFiPRecettesFiscales>'), 'Doit fermer la racine');
  assert.ok(xml.includes('<Entete>'), 'Doit contenir une en-tête');
  assert.ok(xml.includes('<Recapitulatif>'), 'Doit contenir un récapitulatif');
  assert.ok(xml.includes('<Titres>'), 'Doit contenir la section titres');
  assert.ok(xml.includes('<Titre>'), 'Doit contenir au moins un titre');
  assert.ok(xml.includes('<NumeroTitre>TIT-DGF-2026-001</NumeroTitre>'), 'Doit contenir le titre A');
  assert.ok(xml.includes('<MontantTitre>2400.00</MontantTitre>'), 'Doit contenir le montant du titre A');
  assert.ok(xml.includes('<ModalitesPaiement>'), 'Doit contenir les modalités de paiement');
  assert.ok(xml.includes('<ValeurSignature>') === false, 'Ne doit pas contenir de signature sans demande');

  // Vérifier la cohérence des montants
  assert.ok(xml.includes('<TotalMontantBrut>3200.00</TotalMontantBrut>'));
  assert.ok(xml.includes('<TotalMontantRecouvre>2900.00</TotalMontantRecouvre>'));
  assert.ok(xml.includes('<CoherenceVerifiee>true</CoherenceVerifiee>'));
});

test('Les exports annuels et trimestriels sont isolés', async () => {
  const fx = resetFixtures();

  const resAnnuel = await request({
    method: 'POST',
    path: '/api/dgfip-recettes/export',
    headers: makeAuthHeader(fx.financier),
    body: { annee: 2026 },
  });
  assert.equal(resAnnuel.status, 201);
  const annuel = parseJson(resAnnuel.text) as { numero_bordereau?: number };
  assert.equal(annuel.numero_bordereau, 1, 'Premier export = bordereau 1');

  const resTrim = await request({
    method: 'POST',
    path: '/api/dgfip-recettes/export',
    headers: makeAuthHeader(fx.financier),
    body: { annee: 2026, trimestre: 1 },
  });
  assert.equal(resTrim.status, 201);
  const trim = parseJson(resTrim.text) as { numero_bordereau?: number };
  assert.equal(trim.numero_bordereau, 2, 'Deuxième export = bordereau 2');
});

test('L\'export 2025 ne contient que les titres de 2025', async () => {
  const fx = resetFixtures();

  const res = await request({
    method: 'POST',
    path: '/api/dgfip-recettes/export',
    headers: makeAuthHeader(fx.financier),
    body: { annee: 2025 },
  });

  assert.equal(res.status, 201);
  const data = parseJson(res.text) as { recapitulatif?: { titres_count?: number; total_montant_brut?: number } };
  assert.equal(data.recapitulatif?.titres_count, 1, '2025 ne doit avoir qu\'1 titre');
  assert.equal(data.recapitulatif?.total_montant_brut, 999, 'Montant 2025 = 999');
});

test('L\'export est tracé dans audit_log', async () => {
  const fx = resetFixtures();

  await request({
    method: 'POST',
    path: '/api/dgfip-recettes/export',
    headers: makeAuthHeader(fx.financier),
    body: { annee: 2026 },
  });

  const auditEntry = db
    .prepare("SELECT action, entite, details FROM audit_log WHERE action = 'export-dgfip-recettes' ORDER BY id DESC LIMIT 1")
    .get() as { action: string; entite: string; details: string } | undefined;

  assert.ok(auditEntry, 'Une entrée audit_log doit exister');
  assert.equal(auditEntry.action, 'export-dgfip-recettes');
  assert.equal(auditEntry.entite, 'dgfip_recettes_exports');
  assert.ok(auditEntry.details?.includes('"annee":2026'), 'Les détails doivent contenir l\'année');
});
