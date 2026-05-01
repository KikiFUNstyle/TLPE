import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { db, initSchema } from './db';
import { hashPassword, signToken, type AuthUser } from './auth';
import { titresRouter } from './routes/titres';
import { paiementsRouter } from './routes/paiements';

const PAYFIP_SECRET = 'payfip-secret-test';
const PAYFIP_BASE_URL = 'https://payfip.example.test/payer';
const PAYFIP_COLLECTIVITE = '33063';
const PAYFIP_RETURN_URL = 'http://localhost:5173/paiement/confirmation';
const PAYFIP_CALLBACK_URL = 'http://localhost:4000/api/paiements/callback/payfip';

function createApp() {
  process.env.TLPE_PAYFIP_SECRET = PAYFIP_SECRET;
  process.env.TLPE_PAYFIP_BASE_URL = PAYFIP_BASE_URL;
  process.env.TLPE_PAYFIP_COLLECTIVITE = PAYFIP_COLLECTIVITE;
  process.env.TLPE_PAYFIP_RETURN_URL = PAYFIP_RETURN_URL;
  process.env.TLPE_PAYFIP_CALLBACK_URL = PAYFIP_CALLBACK_URL;

  const app = express();
  app.use(express.json());
  app.use('/api/titres', titresRouter);
  app.use('/api/paiements', paiementsRouter);
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
  skipJsonContentType?: boolean;
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
        ...(!params.skipJsonContentType && params.body ? { 'Content-Type': 'application/json' } : {}),
        ...(params.headers || {}),
      },
      body: params.body ? JSON.stringify(params.body) : undefined,
    });
    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    return {
      status: res.status,
      contentType,
      json: contentType.includes('application/json') && text ? JSON.parse(text) : null,
      text,
    };
  } finally {
    server.close();
  }
}

function buildCallbackMac(params: {
  numeroTitre: string;
  reference: string;
  montant: number;
  statut: 'success' | 'cancel' | 'failed';
  transactionId: string;
}) {
  return crypto
    .createHmac('sha256', PAYFIP_SECRET)
    .update(`${params.numeroTitre}|${params.reference}|${params.montant.toFixed(2)}|${params.statut}|${params.transactionId}`)
    .digest('hex');
}

function resetFixtures() {
  initSchema();
  db.exec('DELETE FROM pesv2_export_titres');
  db.exec('DELETE FROM pesv2_exports');
  db.exec('DELETE FROM declaration_receipts');
  db.exec('DELETE FROM notifications_email');
  db.exec('DELETE FROM invitation_magic_links');
  db.exec('DELETE FROM campagne_jobs');
  db.exec('DELETE FROM mises_en_demeure');
  db.exec('DELETE FROM recouvrement_actions');
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
    db.prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('ENS-PAYFIP', 'Enseigne PayFip', 'enseigne')`).run()
      .lastInsertRowid,
  );
  const assujettiA = Number(
    db.prepare(
      `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, portail_actif, statut)
       VALUES ('TLPE-PAY-001', 'Alpha Publicite', 'alpha@example.test', 1, 'actif')`,
    ).run().lastInsertRowid,
  );
  const assujettiB = Number(
    db.prepare(
      `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, portail_actif, statut)
       VALUES ('TLPE-PAY-002', 'Beta Enseignes', 'beta@example.test', 1, 'actif')`,
    ).run().lastInsertRowid,
  );

  const contribuableId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, assujetti_id, actif)
       VALUES ('contribuable-payfip@tlpe.local', ?, 'Contrib', 'Alpha', 'contribuable', ?, 1)`,
    ).run(hashPassword('x'), assujettiA).lastInsertRowid,
  );
  const autreContribuableId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, assujetti_id, actif)
       VALUES ('contribuable-beta@tlpe.local', ?, 'Contrib', 'Beta', 'contribuable', ?, 1)`,
    ).run(hashPassword('x'), assujettiB).lastInsertRowid,
  );
  const financierId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES ('financier-payfip@tlpe.local', ?, 'Fin', 'Ancier', 'financier', 1)`,
    ).run(hashPassword('x')).lastInsertRowid,
  );

  const declarationId = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-PAYFIP-2026-001', ?, 2026, 'validee', 275.4)`,
    ).run(assujettiA).lastInsertRowid,
  );

  const dispositifId = Number(
    db.prepare(
      `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, statut)
       VALUES ('DSP-PAYFIP-001', ?, ?, 12, 1, 'declare')`,
    ).run(assujettiA, typeId).lastInsertRowid,
  );

  db.prepare(
    `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne)
     VALUES (?, ?, 12, 1, '2026-01-01', 275.4)`,
  ).run(declarationId, dispositifId);

  const titreId = Number(
    db.prepare(
      `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut, montant_paye)
       VALUES ('TIT-2026-000777', ?, ?, 2026, 275.4, '2026-04-01', '2026-08-31', 'emis', 0)`,
    ).run(declarationId, assujettiA).lastInsertRowid,
  );

  return {
    titreId,
    titreNumero: 'TIT-2026-000777',
    contribuable: {
      id: contribuableId,
      email: 'contribuable-payfip@tlpe.local',
      role: 'contribuable' as const,
      nom: 'Contrib',
      prenom: 'Alpha',
      assujetti_id: assujettiA,
    },
    autreContribuable: {
      id: autreContribuableId,
      email: 'contribuable-beta@tlpe.local',
      role: 'contribuable' as const,
      nom: 'Contrib',
      prenom: 'Beta',
      assujetti_id: assujettiB,
    },
    financier: {
      id: financierId,
      email: 'financier-payfip@tlpe.local',
      role: 'financier' as const,
      nom: 'Fin',
      prenom: 'Ancier',
      assujetti_id: null,
    },
  };
}

test('POST /api/titres/:id/payfip/initiate expose une redirection PayFip signée pour le contribuable propriétaire', async () => {
  const fx = resetFixtures();

  const res = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreId}/payfip/initiate`,
    headers: makeAuthHeader(fx.contribuable),
  });

  assert.equal(res.status, 200);
  assert.equal(typeof res.json?.redirect_url, 'string');
  assert.match(res.json!.redirect_url, /^https:\/\/payfip\.example\.test\/payer\?/);
  assert.equal(res.json?.numero_titre, fx.titreNumero);
  assert.equal(res.json?.montant, 275.4);
  assert.match(String(res.json?.reference), /^TLPE-PAYFIP-/);
  assert.equal(res.json?.return_url, PAYFIP_RETURN_URL);
  assert.equal(res.json?.callback_url, PAYFIP_CALLBACK_URL);

  const redirectUrl = new URL(String(res.json?.redirect_url));
  const redirectMac = redirectUrl.searchParams.get('mac');
  assert.ok(redirectMac);
  const expectedRedirectMac = crypto
    .createHmac('sha256', PAYFIP_SECRET)
    .update(
      `${PAYFIP_COLLECTIVITE}|${fx.titreNumero}|275.40|${String(res.json?.reference)}|${PAYFIP_RETURN_URL}|${PAYFIP_CALLBACK_URL}`,
    )
    .digest('hex');
  assert.equal(redirectMac, expectedRedirectMac);

  const forbidden = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreId}/payfip/initiate`,
    headers: makeAuthHeader(fx.autreContribuable),
  });
  assert.equal(forbidden.status, 403);
});

test('POST /api/titres/:id/payfip/initiate utilise le solde restant pour un titre partiellement payé', async () => {
  const fx = resetFixtures();

  db.prepare(`UPDATE titres SET montant_paye = ?, statut = 'paye_partiel' WHERE id = ?`).run(100, fx.titreId);
  db.prepare(
    `INSERT INTO paiements (titre_id, montant, date_paiement, modalite, reference, provider, statut)
     VALUES (?, 100, '2026-04-15', 'virement', 'VR-100', 'manuel', 'confirme')`,
  ).run(fx.titreId);

  const res = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreId}/payfip/initiate`,
    headers: makeAuthHeader(fx.contribuable),
  });

  assert.equal(res.status, 200);
  assert.equal(res.json?.montant, 175.4);

  const redirectUrl = new URL(String(res.json?.redirect_url));
  const redirectMac = redirectUrl.searchParams.get('mac');
  assert.ok(redirectMac);
  const expectedRedirectMac = crypto
    .createHmac('sha256', PAYFIP_SECRET)
    .update(
      `${PAYFIP_COLLECTIVITE}|${fx.titreNumero}|175.40|${String(res.json?.reference)}|${PAYFIP_RETURN_URL}|${PAYFIP_CALLBACK_URL}`,
    )
    .digest('hex');
  assert.equal(redirectMac, expectedRedirectMac);
});

test('POST /api/titres/:id/payfip/initiate retourne 409 si le titre est déjà soldé', async () => {
  const fx = resetFixtures();

  db.prepare(`UPDATE titres SET montant_paye = montant, statut = 'paye_partiel' WHERE id = ?`).run(fx.titreId);

  const res = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreId}/payfip/initiate`,
    headers: makeAuthHeader(fx.contribuable),
  });

  assert.equal(res.status, 409);
  assert.match(String(res.json?.error), /soldé|payé/i);
});

test('POST /api/titres/:id/payfip/initiate retourne 404 pour un titre inexistant', async () => {
  const fx = resetFixtures();

  const res = await request({
    method: 'POST',
    path: '/api/titres/999999/payfip/initiate',
    headers: makeAuthHeader(fx.contribuable),
  });

  assert.equal(res.status, 404);
  assert.equal(res.json?.error, 'Titre introuvable');
});

test('POST /api/titres/:id/payfip/initiate refuse un rôle non contribuable', async () => {
  const fx = resetFixtures();

  const res = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreId}/payfip/initiate`,
    headers: makeAuthHeader(fx.financier),
  });

  assert.equal(res.status, 403);
  assert.match(String(res.json?.error), /droits insuffisants/i);
});

test('POST /api/paiements/callback/payfip rejette une signature invalide', async () => {
  const fx = resetFixtures();
  const initiation = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreId}/payfip/initiate`,
    headers: makeAuthHeader(fx.contribuable),
  });

  const callback = await request({
    method: 'POST',
    path: '/api/paiements/callback/payfip',
    body: {
      numero_titre: fx.titreNumero,
      reference: String(initiation.json?.reference),
      montant: 275.4,
      statut: 'success',
      transaction_id: 'PAYFIP-TX-BAD-MAC',
      mac: '0'.repeat(64),
    },
    skipJsonContentType: true,
  });

  assert.equal(callback.status, 400);
  assert.equal(callback.json?.error, 'Signature PayFip invalide');
  const paiementsCount = db.prepare('SELECT COUNT(*) AS count FROM paiements').get() as { count: number };
  assert.equal(paiementsCount.count, 0);
});

test('POST /api/paiements/callback/payfip retourne 404 si le titre est introuvable', async () => {
  resetFixtures();

  const callback = await request({
    method: 'POST',
    path: '/api/paiements/callback/payfip',
    body: {
      numero_titre: 'TIT-INCONNU',
      reference: 'TLPE-PAYFIP-404',
      montant: 275.4,
      statut: 'success',
      transaction_id: 'PAYFIP-TX-404',
      mac: buildCallbackMac({
        numeroTitre: 'TIT-INCONNU',
        reference: 'TLPE-PAYFIP-404',
        montant: 275.4,
        statut: 'success',
        transactionId: 'PAYFIP-TX-404',
      }),
    },
    skipJsonContentType: true,
  });

  assert.equal(callback.status, 404);
  assert.equal(callback.json?.error, 'Titre introuvable');
});

test('POST /api/paiements/callback/payfip ignore un doublon de transaction déjà rapproché', async () => {
  const fx = resetFixtures();
  const initiation = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreId}/payfip/initiate`,
    headers: makeAuthHeader(fx.contribuable),
  });

  const reference = String(initiation.json?.reference);
  const transactionId = 'PAYFIP-TX-DUPLICATE';
  const payload = {
    numero_titre: fx.titreNumero,
    reference,
    montant: 275.4,
    statut: 'success' as const,
    transaction_id: transactionId,
    mac: buildCallbackMac({
      numeroTitre: fx.titreNumero,
      reference,
      montant: 275.4,
      statut: 'success',
      transactionId,
    }),
  };

  const first = await request({
    method: 'POST',
    path: '/api/paiements/callback/payfip',
    body: payload,
    skipJsonContentType: true,
  });
  assert.equal(first.status, 200);
  assert.equal(first.json?.statut, 'paye');

  const duplicate = await request({
    method: 'POST',
    path: '/api/paiements/callback/payfip',
    body: payload,
    skipJsonContentType: true,
  });

  assert.equal(duplicate.status, 200);
  assert.deepEqual(duplicate.json, { ok: true, duplicated: true });
  const paiementsCount = db.prepare('SELECT COUNT(*) AS count FROM paiements WHERE transaction_id = ?').get(transactionId) as { count: number };
  assert.equal(paiementsCount.count, 1);
});

test('POST /api/paiements/callback/payfip trace une annulation sans solder le titre', async () => {
  const fx = resetFixtures();
  const initiation = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreId}/payfip/initiate`,
    headers: makeAuthHeader(fx.contribuable),
  });

  const reference = String(initiation.json?.reference);
  const transactionId = 'PAYFIP-TX-CANCEL';
  const mac = buildCallbackMac({
    numeroTitre: fx.titreNumero,
    reference,
    montant: 275.4,
    statut: 'cancel',
    transactionId,
  });

  const callback = await request({
    method: 'POST',
    path: '/api/paiements/callback/payfip',
    body: {
      numero_titre: fx.titreNumero,
      reference,
      montant: 275.4,
      statut: 'cancel',
      transaction_id: transactionId,
      mac,
    },
    skipJsonContentType: true,
  });

  assert.equal(callback.status, 200);
  assert.equal(callback.json?.ok, true);
  assert.equal(callback.json?.statut, 'annule');
  assert.equal(callback.json?.montant_paye, 0);

  const paiement = db.prepare('SELECT statut, provider, transaction_id FROM paiements WHERE titre_id = ?').get(fx.titreId) as
    | { statut: string; provider: string | null; transaction_id: string | null }
    | undefined;
  assert.ok(paiement);
  assert.equal(paiement!.statut, 'annule');
  assert.equal(paiement!.provider, 'payfip');
  assert.equal(paiement!.transaction_id, transactionId);

  const titre = db.prepare('SELECT montant_paye, statut FROM titres WHERE id = ?').get(fx.titreId) as
    | { montant_paye: number; statut: string }
    | undefined;
  assert.ok(titre);
  assert.equal(titre!.montant_paye, 0);
  assert.equal(titre!.statut, 'emis');
});

test('POST /api/paiements/callback/payfip rapproche automatiquement un paiement confirmé et journalise la transaction', async () => {
  const fx = resetFixtures();
  const initiation = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreId}/payfip/initiate`,
    headers: makeAuthHeader(fx.contribuable),
  });

  const reference = String(initiation.json?.reference);
  const transactionId = 'PAYFIP-TX-0001';
  const mac = buildCallbackMac({
    numeroTitre: fx.titreNumero,
    reference,
    montant: 275.4,
    statut: 'success',
    transactionId,
  });

  const callback = await request({
    method: 'POST',
    path: '/api/paiements/callback/payfip',
    body: {
      numero_titre: fx.titreNumero,
      reference,
      montant: 275.4,
      statut: 'success',
      transaction_id: transactionId,
      mac,
    },
    skipJsonContentType: true,
  });

  assert.equal(callback.status, 200);
  assert.equal(callback.json?.ok, true);
  assert.equal(callback.json?.statut, 'paye');

  const paiement = db.prepare('SELECT modalite, montant, statut, provider, reference, commentaire FROM paiements WHERE titre_id = ?').get(fx.titreId) as
    | { modalite: string; montant: number; statut: string; provider: string | null; reference: string | null; commentaire: string | null }
    | undefined;
  assert.ok(paiement);
  assert.equal(paiement!.modalite, 'tipi');
  assert.equal(paiement!.montant, 275.4);
  assert.equal(paiement!.statut, 'confirme');
  assert.equal(paiement!.provider, 'payfip');
  assert.equal(paiement!.reference, reference);
  assert.match(paiement!.commentaire ?? '', /PAYFIP-TX-0001/);

  const titre = db.prepare('SELECT montant_paye, statut FROM titres WHERE id = ?').get(fx.titreId) as
    | { montant_paye: number; statut: string }
    | undefined;
  assert.ok(titre);
  assert.equal(titre!.montant_paye, 275.4);
  assert.equal(titre!.statut, 'paye');
});

test('POST /api/paiements/callback/payfip trace les échecs sans rapprocher le titre', async () => {
  const fx = resetFixtures();
  const initiation = await request({
    method: 'POST',
    path: `/api/titres/${fx.titreId}/payfip/initiate`,
    headers: makeAuthHeader(fx.contribuable),
  });

  const reference = String(initiation.json?.reference);
  const transactionId = 'PAYFIP-TX-0002';
  const mac = buildCallbackMac({
    numeroTitre: fx.titreNumero,
    reference,
    montant: 275.4,
    statut: 'failed',
    transactionId,
  });

  const callback = await request({
    method: 'POST',
    path: '/api/paiements/callback/payfip',
    body: {
      numero_titre: fx.titreNumero,
      reference,
      montant: 275.4,
      statut: 'failed',
      transaction_id: transactionId,
      mac,
    },
    skipJsonContentType: true,
  });

  assert.equal(callback.status, 200);
  assert.equal(callback.json?.ok, true);
  assert.equal(callback.json?.statut, 'refuse');

  const paiement = db.prepare('SELECT montant, statut, provider FROM paiements WHERE titre_id = ?').get(fx.titreId) as
    | { montant: number; statut: string; provider: string | null }
    | undefined;
  assert.ok(paiement);
  assert.equal(paiement!.montant, 275.4);
  assert.equal(paiement!.statut, 'refuse');
  assert.equal(paiement!.provider, 'payfip');

  const titre = db.prepare('SELECT montant_paye, statut FROM titres WHERE id = ?').get(fx.titreId) as
    | { montant_paye: number; statut: string }
    | undefined;
  assert.ok(titre);
  assert.equal(titre!.montant_paye, 0);
  assert.equal(titre!.statut, 'emis');
});
