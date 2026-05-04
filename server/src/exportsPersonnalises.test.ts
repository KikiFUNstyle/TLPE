import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import XLSX from 'xlsx';
import type { AuthUser } from './auth';

type ExportsTestContext = {
  db: typeof import('./db').db;
  initSchema: typeof import('./db').initSchema;
  hashPassword: typeof import('./auth').hashPassword;
  signToken: typeof import('./auth').signToken;
  exportsPersonnalisesRouter: typeof import('./routes/exportsPersonnalises').exportsPersonnalisesRouter;
  cleanup: () => void;
};

const TEST_MODULES = ['./db', './auth', './routes/exportsPersonnalises'] as const;

function clearModuleCache() {
  for (const modulePath of TEST_MODULES) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // ignore
    }
  }
}

function createContext(): ExportsTestContext {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlpe-exports-personnalises-test-'));
  const dbPath = path.join(tempDir, 'tlpe.db');
  const previousDbPath = process.env.TLPE_DB_PATH;
  process.env.TLPE_DB_PATH = dbPath;
  clearModuleCache();

  const dbModule = require('./db') as typeof import('./db');
  const authModule = require('./auth') as typeof import('./auth');
  const exportsModule = require('./routes/exportsPersonnalises') as typeof import('./routes/exportsPersonnalises');

  return {
    db: dbModule.db,
    initSchema: dbModule.initSchema,
    hashPassword: authModule.hashPassword,
    signToken: authModule.signToken,
    exportsPersonnalisesRouter: exportsModule.exportsPersonnalisesRouter,
    cleanup: () => {
      try {
        dbModule.db.close();
      } catch {
        // ignore close errors
      }
      clearModuleCache();
      if (previousDbPath === undefined) {
        delete process.env.TLPE_DB_PATH;
      } else {
        process.env.TLPE_DB_PATH = previousDbPath;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function withContext(run: (ctx: ExportsTestContext) => Promise<void> | void) {
  const ctx = createContext();
  try {
    await run(ctx);
  } finally {
    ctx.cleanup();
  }
}

function createApp(ctx: ExportsTestContext) {
  const app = express();
  app.use(express.json());
  app.use('/api/exports-personnalises', ctx.exportsPersonnalisesRouter);
  return app;
}

function makeAuthHeader(ctx: ExportsTestContext, user: AuthUser): Record<string, string> {
  return { Authorization: `Bearer ${ctx.signToken(user)}` };
}

async function requestJson(ctx: ExportsTestContext, params: {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}) {
  const app = createApp(ctx);
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
      headers: params.body
        ? { 'Content-Type': 'application/json', ...params.headers }
        : params.headers,
      body: params.body ? JSON.stringify(params.body) : undefined,
    });
    const contentType = res.headers.get('content-type') || '';
    const buffer = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      contentType,
      disposition: res.headers.get('content-disposition') || '',
      json: contentType.includes('application/json') ? JSON.parse(buffer.toString('utf8')) : null,
      buffer,
    };
  } finally {
    server.close();
  }
}

function resetFixtures(ctx: ExportsTestContext) {
  ctx.initSchema();
  ctx.db.pragma('foreign_keys = OFF');
  try {
    ctx.db.exec('DELETE FROM exports_sauvegardes');
    ctx.db.exec('DELETE FROM rapports_exports');
    ctx.db.exec('DELETE FROM recouvrement_actions');
    ctx.db.exec('DELETE FROM rapprochements_log');
    ctx.db.exec('DELETE FROM lignes_releve');
    ctx.db.exec('DELETE FROM releves_bancaires');
    ctx.db.exec('DELETE FROM paiements');
    ctx.db.exec('DELETE FROM titres');
    ctx.db.exec('DELETE FROM pieces_jointes');
    ctx.db.exec('DELETE FROM evenements_contentieux');
    ctx.db.exec('DELETE FROM contentieux_alerts');
    ctx.db.exec('DELETE FROM contentieux');
    ctx.db.exec('DELETE FROM lignes_declaration');
    ctx.db.exec('DELETE FROM declaration_receipts');
    ctx.db.exec('DELETE FROM declarations');
    ctx.db.exec('DELETE FROM notifications_email');
    ctx.db.exec('DELETE FROM invitation_magic_links');
    ctx.db.exec('DELETE FROM campagne_jobs');
    ctx.db.exec('DELETE FROM mises_en_demeure');
    ctx.db.exec('DELETE FROM controles');
    ctx.db.exec('DELETE FROM dispositifs');
    ctx.db.exec('DELETE FROM campagnes');
    ctx.db.exec('DELETE FROM audit_log');
    ctx.db.exec('DELETE FROM users');
    ctx.db.exec('DELETE FROM assujettis');
    ctx.db.exec('DELETE FROM types_dispositifs');
    ctx.db.exec('DELETE FROM zones');
  } finally {
    ctx.db.pragma('foreign_keys = ON');
  }

  const zoneCentre = Number(ctx.db.prepare(`INSERT INTO zones (code, libelle, coefficient) VALUES ('ZC', 'Zone Centre', 1.5)`).run().lastInsertRowid);
  const zonePeri = Number(ctx.db.prepare(`INSERT INTO zones (code, libelle, coefficient) VALUES ('ZP', 'Zone Périphérie', 1.0)`).run().lastInsertRowid);
  const enseigneType = Number(ctx.db.prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('ENS-EXP', 'Enseigne export', 'enseigne')`).run().lastInsertRowid);
  const pubType = Number(ctx.db.prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('PUB-EXP', 'Publicité export', 'publicitaire')`).run().lastInsertRowid);

  const gestionnaireId = Number(
    ctx.db.prepare(`INSERT INTO users (email, password_hash, nom, prenom, role, actif) VALUES ('gestionnaire-export@tlpe.local', ?, 'Gest', 'Ionnaire', 'gestionnaire', 1)`).run(ctx.hashPassword('x')).lastInsertRowid,
  );
  const financierId = Number(
    ctx.db.prepare(`INSERT INTO users (email, password_hash, nom, prenom, role, actif) VALUES ('financier-export@tlpe.local', ?, 'Fin', 'Ancier', 'financier', 1)`).run(ctx.hashPassword('x')).lastInsertRowid,
  );
  const controleurId = Number(
    ctx.db.prepare(`INSERT INTO users (email, password_hash, nom, prenom, role, actif) VALUES ('controleur-export@tlpe.local', ?, 'Con', 'Troleur', 'controleur', 1)`).run(ctx.hashPassword('x')).lastInsertRowid,
  );

  const alphaId = Number(ctx.db.prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, siret, adresse_ville, email, statut, portail_actif) VALUES ('TLPE-EXP-001', 'Alpha Média', '11111111111111', 'Bordeaux', 'alpha@example.test', 'actif', 1)`).run().lastInsertRowid);
  const betaId = Number(ctx.db.prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, siret, adresse_ville, email, statut, portail_actif) VALUES ('TLPE-EXP-002', 'Beta Affichage', '22222222222222', 'Mérignac', 'beta@example.test', 'contentieux', 0)`).run().lastInsertRowid);

  const dispositifA = Number(ctx.db.prepare(`INSERT INTO dispositifs (identifiant, assujetti_id, type_id, zone_id, adresse_ville, surface, nombre_faces, statut) VALUES ('DSP-EXP-001', ?, ?, ?, 'Bordeaux', 12.5, 2, 'declare')`).run(alphaId, enseigneType, zoneCentre).lastInsertRowid);
  const dispositifB = Number(ctx.db.prepare(`INSERT INTO dispositifs (identifiant, assujetti_id, type_id, zone_id, adresse_ville, surface, nombre_faces, statut) VALUES ('DSP-EXP-002', ?, ?, ?, 'Mérignac', 8, 1, 'controle')`).run(betaId, pubType, zonePeri).lastInsertRowid);

  const declarationA = Number(ctx.db.prepare(`INSERT INTO declarations (numero, assujetti_id, annee, statut, date_soumission, date_validation, montant_total, alerte_gestionnaire) VALUES ('DEC-EXP-2026-001', ?, 2026, 'validee', '2026-03-01', '2026-03-10', 1200, 0)`).run(alphaId).lastInsertRowid);
  const declarationB = Number(ctx.db.prepare(`INSERT INTO declarations (numero, assujetti_id, annee, statut, date_soumission, montant_total, alerte_gestionnaire) VALUES ('DEC-EXP-2026-002', ?, 2026, 'soumise', '2026-03-05', 450, 1)`).run(betaId).lastInsertRowid);

  ctx.db.prepare(`INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne) VALUES (?, ?, 12.5, 2, '2026-01-01', 1200)`).run(declarationA, dispositifA);
  ctx.db.prepare(`INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne) VALUES (?, ?, 8, 1, '2026-01-15', 450)`).run(declarationB, dispositifB);

  const titreA = Number(ctx.db.prepare(`INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, montant_paye, date_emission, date_echeance, statut) VALUES ('TIT-EXP-2026-001', ?, ?, 2026, 1200, 1200, '2026-04-01', '2026-06-30', 'paye')`).run(declarationA, alphaId).lastInsertRowid);
  const titreB = Number(ctx.db.prepare(`INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, montant_paye, date_emission, date_echeance, statut) VALUES ('TIT-EXP-2026-002', ?, ?, 2026, 450, 100, '2026-04-03', '2026-06-30', 'paye_partiel')`).run(declarationB, betaId).lastInsertRowid);

  ctx.db.prepare(`INSERT INTO paiements (titre_id, montant, date_paiement, modalite, provider, statut, reference, transaction_id) VALUES (?, 1200, '2026-04-10', 'virement', 'manuel', 'confirme', 'PAY-EXP-001', 'PAYMENT-EXP-001')`).run(titreA);
  ctx.db.prepare(`INSERT INTO paiements (titre_id, montant, date_paiement, modalite, provider, statut, reference, transaction_id) VALUES (?, 100, '2026-04-12', 'cheque', 'manuel', 'confirme', 'PAY-EXP-002', 'PAYMENT-EXP-002')`).run(titreB);

  ctx.db.prepare(`INSERT INTO contentieux (numero, assujetti_id, titre_id, type, montant_litige, montant_degreve, date_ouverture, date_limite_reponse, statut, description) VALUES ('CTX-EXP-2026-001', ?, ?, 'contentieux', 300, NULL, '2026-05-01', '2026-11-01', 'instruction', 'Réclamation en cours')`).run(betaId, titreB);

  return {
    gestionnaire: { id: gestionnaireId, email: 'gestionnaire-export@tlpe.local', role: 'gestionnaire' as const, nom: 'Gest', prenom: 'Ionnaire', assujetti_id: null },
    financier: { id: financierId, email: 'financier-export@tlpe.local', role: 'financier' as const, nom: 'Fin', prenom: 'Ancier', assujetti_id: null },
    controleur: { id: controleurId, email: 'controleur-export@tlpe.local', role: 'controleur' as const, nom: 'Con', prenom: 'Troleur', assujetti_id: null },
  };
}

test('GET /api/exports-personnalises/meta expose les entités et refuse un rôle non autorisé', async () => {
  await withContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const forbidden = await requestJson(ctx, {
      method: 'GET',
      path: '/api/exports-personnalises/meta',
      headers: makeAuthHeader(ctx, fx.controleur),
    });
    assert.equal(forbidden.status, 403);

    const res = await requestJson(ctx, {
      method: 'GET',
      path: '/api/exports-personnalises/meta',
      headers: makeAuthHeader(ctx, fx.gestionnaire),
    });

    assert.equal(res.status, 200);
    assert.equal(res.json?.entities.length, 6);
    assert.equal(res.json?.entities[0].key, 'assujettis');
    assert.equal(res.json?.entities[0].columns.some((column: { key: string }) => column.key === 'raison_sociale'), true);
  });
});

test('POST /api/exports-personnalises/preview retourne un aperçu filtré, trié et limité aux colonnes demandées', async () => {
  await withContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const res = await requestJson(ctx, {
      method: 'POST',
      path: '/api/exports-personnalises/preview',
      headers: makeAuthHeader(ctx, fx.financier),
      body: {
        entite: 'titres',
        colonnes: ['numero', 'assujetti', 'montant', 'statut'],
        filtres: [{ colonne: 'statut', operateur: 'eq', valeur: 'paye_partiel' }],
        ordre: { colonne: 'montant', direction: 'desc' },
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.json?.total, 1);
    assert.deepEqual(res.json?.columns.map((column: { key: string }) => column.key), ['numero', 'assujetti', 'montant', 'statut']);
    assert.deepEqual(res.json?.rows, [{ numero: 'TIT-EXP-2026-002', assujetti: 'Beta Affichage', montant: 450, statut: 'paye_partiel' }]);
  });
});

test('POST /api/exports-personnalises/preview rejette les colonnes, filtres, tris et booléens invalides', async () => {
  await withContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const unknownColumn = await requestJson(ctx, {
      method: 'POST',
      path: '/api/exports-personnalises/preview',
      headers: makeAuthHeader(ctx, fx.financier),
      body: {
        entite: 'assujettis',
        colonnes: ['raison_sociale', 'colonne_inconnue'],
        filtres: [],
        ordre: { colonne: 'raison_sociale', direction: 'asc' },
      },
    });
    assert.equal(unknownColumn.status, 400);
    assert.match(String(unknownColumn.json?.error ?? ''), /Colonne inconnue/i);

    const invalidFilterColumn = await requestJson(ctx, {
      method: 'POST',
      path: '/api/exports-personnalises/preview',
      headers: makeAuthHeader(ctx, fx.financier),
      body: {
        entite: 'assujettis',
        colonnes: ['raison_sociale'],
        filtres: [{ colonne: 'inconnue', operateur: 'eq', valeur: 'Alpha Média' }],
        ordre: { colonne: 'raison_sociale', direction: 'asc' },
      },
    });
    assert.equal(invalidFilterColumn.status, 400);
    assert.match(String(invalidFilterColumn.json?.error ?? ''), /Filtre invalide/i);

    const invalidOperator = await requestJson(ctx, {
      method: 'POST',
      path: '/api/exports-personnalises/preview',
      headers: makeAuthHeader(ctx, fx.financier),
      body: {
        entite: 'assujettis',
        colonnes: ['raison_sociale', 'portail_actif'],
        filtres: [{ colonne: 'portail_actif', operateur: 'contains', valeur: 'oui' }],
        ordre: { colonne: 'raison_sociale', direction: 'asc' },
      },
    });
    assert.equal(invalidOperator.status, 400);
    assert.match(String(invalidOperator.json?.error ?? ''), /Opérateur contains non autorisé/i);

    const invalidBoolean = await requestJson(ctx, {
      method: 'POST',
      path: '/api/exports-personnalises/preview',
      headers: makeAuthHeader(ctx, fx.financier),
      body: {
        entite: 'assujettis',
        colonnes: ['raison_sociale', 'portail_actif'],
        filtres: [{ colonne: 'portail_actif', operateur: 'eq', valeur: 'peut-être' }],
        ordre: { colonne: 'raison_sociale', direction: 'asc' },
      },
    });
    assert.equal(invalidBoolean.status, 400);
    assert.match(String(invalidBoolean.json?.error ?? ''), /Valeur booléenne invalide/i);

    const invalidOrder = await requestJson(ctx, {
      method: 'POST',
      path: '/api/exports-personnalises/preview',
      headers: makeAuthHeader(ctx, fx.financier),
      body: {
        entite: 'assujettis',
        colonnes: ['raison_sociale'],
        filtres: [],
        ordre: { colonne: 'ordre_inconnu', direction: 'asc' },
      },
    });
    assert.equal(invalidOrder.status, 400);
    assert.match(String(invalidOrder.json?.error ?? ''), /Tri invalide/i);
  });
});

test('POST /api/exports-personnalises/export?format=csv exporte un fichier CSV et journalise l’audit', async () => {
  await withContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const res = await requestJson(ctx, {
      method: 'POST',
      path: '/api/exports-personnalises/export?format=csv',
      headers: makeAuthHeader(ctx, fx.gestionnaire),
      body: {
        entite: 'assujettis',
        colonnes: ['raison_sociale', 'adresse_ville', 'statut'],
        filtres: [{ colonne: 'adresse_ville', operateur: 'contains', valeur: 'Bord' }],
        ordre: { colonne: 'raison_sociale', direction: 'asc' },
      },
    });

    assert.equal(res.status, 200);
    assert.match(res.contentType, /text\/csv/);
    assert.match(res.disposition, /export-assujettis-.*\.csv/);
    const csv = res.buffer.toString('utf8');
    assert.match(csv, /Raison sociale;Ville;Statut/);
    assert.match(csv, /Alpha Média;Bordeaux;actif/);

    const audit = ctx.db.prepare(`SELECT action, entite, details FROM audit_log WHERE action = 'export-personnalise'`).get() as
      | { action: string; entite: string; details: string }
      | undefined;
    assert.ok(audit);
    assert.equal(audit?.entite, 'export_personnalise');
    assert.match(audit?.details ?? '', /"entite":"assujettis"/);
    assert.match(audit?.details ?? '', /"format":"csv"/);
  });
});

test('POST /api/exports-personnalises/export?format=csv neutralise les cellules commençant par un préfixe de formule', async () => {
  await withContext(async (ctx) => {
    const fx = resetFixtures(ctx);
    ctx.db.prepare(`UPDATE assujettis SET raison_sociale = ? WHERE identifiant_tlpe = 'TLPE-EXP-001'`).run('=cmd|\'/C calc\'!A0');

    const res = await requestJson(ctx, {
      method: 'POST',
      path: '/api/exports-personnalises/export?format=csv',
      headers: makeAuthHeader(ctx, fx.gestionnaire),
      body: {
        entite: 'assujettis',
        colonnes: ['raison_sociale', 'adresse_ville'],
        filtres: [{ colonne: 'adresse_ville', operateur: 'contains', valeur: 'Bord' }],
        ordre: { colonne: 'raison_sociale', direction: 'asc' },
      },
    });

    assert.equal(res.status, 200);
    const csv = res.buffer.toString('utf8');
    assert.match(csv, /'=cmd\|'\/C calc'!A0;Bordeaux/);
    assert.doesNotMatch(csv, /\n=cmd\|'\/C calc'!A0;Bordeaux/);
  });
});

test('POST /api/exports-personnalises/templates puis GET liste les modèles sauvegardés et restitue la configuration', async () => {
  await withContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const create = await requestJson(ctx, {
      method: 'POST',
      path: '/api/exports-personnalises/templates',
      headers: makeAuthHeader(ctx, fx.financier),
      body: {
        nom: 'Titres en retard',
        entite: 'titres',
        configuration: {
          colonnes: ['numero', 'assujetti', 'date_echeance', 'statut'],
          filtres: [{ colonne: 'statut', operateur: 'eq', valeur: 'paye_partiel' }],
          ordre: { colonne: 'date_echeance', direction: 'asc' },
        },
      },
    });

    assert.equal(create.status, 201);
    assert.equal(create.json?.nom, 'Titres en retard');
    assert.equal(create.json?.entite, 'titres');

    const list = await requestJson(ctx, {
      method: 'GET',
      path: '/api/exports-personnalises/templates',
      headers: makeAuthHeader(ctx, fx.financier),
    });

    assert.equal(list.status, 200);
    assert.equal(list.json?.length, 1);
    assert.equal(list.json?.[0].configuration.filtres[0].valeur, 'paye_partiel');
  });
});

test('POST /api/exports-personnalises/export?format=xlsx génère un classeur Excel avec les colonnes demandées', async () => {
  await withContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const res = await requestJson(ctx, {
      method: 'POST',
      path: '/api/exports-personnalises/export?format=xlsx',
      headers: makeAuthHeader(ctx, fx.gestionnaire),
      body: {
        entite: 'paiements',
        colonnes: ['reference', 'titre_numero', 'assujetti', 'montant'],
        filtres: [],
        ordre: { colonne: 'reference', direction: 'asc' },
      },
    });

    assert.equal(res.status, 200);
    assert.match(res.contentType, /application\/vnd.openxmlformats-officedocument.spreadsheetml.sheet/);
    const workbook = XLSX.read(res.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: false }) as Array<Array<string | number>>;
    assert.deepEqual(rows[0], ['Référence', 'Titre', 'Assujetti', 'Montant']);
    assert.equal(String(rows[1][0]), 'PAY-EXP-001');
    assert.equal(String(rows[2][1]), 'TIT-EXP-2026-002');
  });
});

test('POST /api/exports-personnalises/export classe les erreurs en 400 validation et 500 interne masquée', async () => {
  await withContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const validationError = await requestJson(ctx, {
      method: 'POST',
      path: '/api/exports-personnalises/export?format=csv',
      headers: makeAuthHeader(ctx, fx.gestionnaire),
      body: {
        entite: 'titres',
        colonnes: ['numero', 'montant'],
        filtres: [{ colonne: 'montant', operateur: 'gte', valeur: 'abc' }],
        ordre: { colonne: 'numero', direction: 'asc' },
      },
    });

    assert.equal(validationError.status, 400);
    assert.match(String(validationError.json?.error ?? ''), /valeur numérique/i);

    const previousPrepare = ctx.db.prepare.bind(ctx.db);
    let forcedOnce = false;
    // @ts-ignore test monkey patch for fault injection
    ctx.db.prepare = ((sql: string) => {
      if (!forcedOnce && sql.includes('SELECT COUNT(*) AS c')) {
        forcedOnce = true;
        throw new Error('disk I/O error');
      }
      return previousPrepare(sql);
    }) as typeof ctx.db.prepare;

    try {
      const internalError = await requestJson(ctx, {
        method: 'POST',
        path: '/api/exports-personnalises/export?format=csv',
        headers: makeAuthHeader(ctx, fx.gestionnaire),
        body: {
          entite: 'assujettis',
          colonnes: ['raison_sociale', 'statut'],
          filtres: [],
          ordre: { colonne: 'raison_sociale', direction: 'asc' },
        },
      });

      assert.equal(internalError.status, 500);
      assert.match(String(internalError.json?.error ?? ''), /Erreur interne export personnalisé/);
      assert.doesNotMatch(JSON.stringify(internalError.json), /disk I\/O error/);
    } finally {
      // @ts-ignore restore monkey patch after fault injection
      ctx.db.prepare = previousPrepare;
    }
  });
});
