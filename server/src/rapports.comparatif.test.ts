import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import XLSX from 'xlsx';
import type { AuthUser } from './auth';

type ComparatifTestContext = {
  db: typeof import('./db').db;
  initSchema: typeof import('./db').initSchema;
  hashPassword: typeof import('./auth').hashPassword;
  signToken: typeof import('./auth').signToken;
  rapportsRouter: typeof import('./routes/rapports').rapportsRouter;
  resolveUploadAbsolutePath: typeof import('./routes/piecesJointes').resolveUploadAbsolutePath;
  cleanup: () => void;
};

const COMPARATIF_TEST_MODULES = ['./db', './auth', './routes/piecesJointes', './routes/rapports'] as const;

function clearComparatifTestModuleCache() {
  for (const modulePath of COMPARATIF_TEST_MODULES) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // ignore cache misses during cleanup
    }
  }
}

function createComparatifTestContext(): ComparatifTestContext {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlpe-rapports-comparatif-test-'));
  const dbPath = path.join(tempDir, 'tlpe.db');
  const previousDbPath = process.env.TLPE_DB_PATH;
  process.env.TLPE_DB_PATH = dbPath;
  clearComparatifTestModuleCache();

  const dbModule = require('./db') as typeof import('./db');
  const authModule = require('./auth') as typeof import('./auth');
  const piecesJointesModule = require('./routes/piecesJointes') as typeof import('./routes/piecesJointes');
  const rapportsModule = require('./routes/rapports') as typeof import('./routes/rapports');

  return {
    db: dbModule.db,
    initSchema: dbModule.initSchema,
    hashPassword: authModule.hashPassword,
    signToken: authModule.signToken,
    rapportsRouter: rapportsModule.rapportsRouter,
    resolveUploadAbsolutePath: piecesJointesModule.resolveUploadAbsolutePath,
    cleanup: () => {
      try {
        dbModule.db.close();
      } catch {
        // ignore close errors during teardown
      }
      clearComparatifTestModuleCache();
      if (previousDbPath === undefined) {
        delete process.env.TLPE_DB_PATH;
      } else {
        process.env.TLPE_DB_PATH = previousDbPath;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function withComparatifTestContext(run: (ctx: ComparatifTestContext) => Promise<void> | void) {
  const ctx = createComparatifTestContext();
  try {
    await run(ctx);
  } finally {
    ctx.cleanup();
  }
}

function createApp(ctx: ComparatifTestContext) {
  const app = express();
  app.use(express.json());
  app.use('/api/rapports', ctx.rapportsRouter);
  return app;
}

function makeAuthHeader(ctx: ComparatifTestContext, user: AuthUser): Record<string, string> {
  return { Authorization: `Bearer ${ctx.signToken(user)}` };
}

async function requestReport(
  ctx: ComparatifTestContext,
  params: {
    path: string;
    headers?: Record<string, string>;
  },
) {
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
      headers: params.headers,
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || '';
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

function insertDeclarationWithTitre(params: {
  ctx: ComparatifTestContext;
  assujettiId: number;
  declarationNumero: string;
  titreNumero: string;
  annee: number;
  montant: number;
  montantPaye: number;
  statutTitre: 'emis' | 'paye_partiel' | 'paye';
  dateEmission: string;
  dateEcheance: string;
  lines: Array<{
    identifiant: string;
    typeId: number;
    zoneId: number;
    surface: number;
    montantLigne: number;
  }>;
}) {
  const declarationId = Number(
    params.ctx.db
      .prepare(`INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total) VALUES (?, ?, ?, 'validee', ?)`)
      .run(params.declarationNumero, params.assujettiId, params.annee, params.montant).lastInsertRowid,
  );

  for (const line of params.lines) {
    const dispositifId = Number(
      params.ctx.db
        .prepare(
          `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, zone_id, surface, nombre_faces, statut)
           VALUES (?, ?, ?, ?, ?, 1, 'declare')`,
        )
        .run(line.identifiant, params.assujettiId, line.typeId, line.zoneId, line.surface).lastInsertRowid,
    );
    params.ctx.db
      .prepare(
        `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .run(declarationId, dispositifId, line.surface, `${params.annee}-01-15`, line.montantLigne);
  }

  const titreId = Number(
    params.ctx.db
      .prepare(
        `INSERT INTO titres (
          numero, declaration_id, assujetti_id, annee, montant, montant_paye, date_emission, date_echeance, statut
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.titreNumero,
        declarationId,
        params.assujettiId,
        params.annee,
        params.montant,
        params.montantPaye,
        params.dateEmission,
        params.dateEcheance,
        params.statutTitre,
      ).lastInsertRowid,
  );

  if (params.montantPaye > 0) {
    params.ctx.db
      .prepare(
        `INSERT INTO paiements (titre_id, montant, date_paiement, modalite, provider, statut, reference)
         VALUES (?, ?, ?, 'virement', 'manuel', 'confirme', ?)`,
      )
      .run(titreId, params.montantPaye, `${params.annee}-07-01`, `PAY-COMP-${params.titreNumero}`);
  }
}

function resetFixtures(ctx: ComparatifTestContext) {
  ctx.initSchema();
  ctx.db.pragma('foreign_keys = OFF');
  try {
    ctx.db.exec('DELETE FROM rapports_exports');
    ctx.db.exec('DELETE FROM recouvrement_actions');
    ctx.db.exec('DELETE FROM paiements');
    ctx.db.exec('DELETE FROM titres');
    ctx.db.exec('DELETE FROM pieces_jointes');
    ctx.db.exec('DELETE FROM contentieux');
    ctx.db.exec('DELETE FROM lignes_declaration');
    ctx.db.exec('DELETE FROM declaration_receipts');
    ctx.db.exec('DELETE FROM declarations');
    ctx.db.exec('DELETE FROM notifications_email');
    ctx.db.exec('DELETE FROM invitation_magic_links');
    ctx.db.exec('DELETE FROM campagne_jobs');
    ctx.db.exec('DELETE FROM mises_en_demeure');
    ctx.db.exec('DELETE FROM controles');
    ctx.db.exec('DELETE FROM campagnes');
    ctx.db.exec('DELETE FROM dispositifs');
    ctx.db.exec('DELETE FROM audit_log');
    ctx.db.exec('DELETE FROM users');
    ctx.db.exec('DELETE FROM assujettis');
    ctx.db.exec('DELETE FROM types_dispositifs');
    ctx.db.exec('DELETE FROM zones');
  } finally {
    ctx.db.pragma('foreign_keys = ON');
  }

  const zoneCentreId = Number(ctx.db.prepare(`INSERT INTO zones (code, libelle, coefficient) VALUES ('ZC', 'Zone Centre', 1.5)`).run().lastInsertRowid);
  const zonePeriId = Number(ctx.db.prepare(`INSERT INTO zones (code, libelle, coefficient) VALUES ('ZP', 'Zone Périphérie', 1.0)`).run().lastInsertRowid);
  const enseigneId = Number(
    ctx.db.prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('ENS-COMP', 'Enseigne comparatif', 'enseigne')`).run().lastInsertRowid,
  );
  const publiciteId = Number(
    ctx.db.prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('PUB-COMP', 'Publicité comparatif', 'publicitaire')`).run().lastInsertRowid,
  );

  const financierId = Number(
    ctx.db
      .prepare(`INSERT INTO users (email, password_hash, nom, prenom, role, actif) VALUES ('financier-comparatif@tlpe.local', ?, 'Fin', 'Ancier', 'financier', 1)`)
      .run(ctx.hashPassword('x')).lastInsertRowid,
  );
  const gestionnaireId = Number(
    ctx.db
      .prepare(`INSERT INTO users (email, password_hash, nom, prenom, role, actif) VALUES ('gestionnaire-comparatif@tlpe.local', ?, 'Gest', 'Ionnaire', 'gestionnaire', 1)`)
      .run(ctx.hashPassword('x')).lastInsertRowid,
  );

  const alphaId = Number(
    ctx.db.prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES ('TLPE-COMP-001', 'Alpha Médias', 'actif')`).run().lastInsertRowid,
  );
  const betaId = Number(
    ctx.db.prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES ('TLPE-COMP-002', 'Beta Affichage', 'actif')`).run().lastInsertRowid,
  );
  const gammaId = Number(
    ctx.db.prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES ('TLPE-COMP-003', 'Gamma Stores', 'actif')`).run().lastInsertRowid,
  );
  const deltaId = Number(
    ctx.db.prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES ('TLPE-COMP-004', 'Delta Retail', 'actif')`).run().lastInsertRowid,
  );

  insertDeclarationWithTitre({
    ctx,
    assujettiId: alphaId,
    declarationNumero: 'DEC-COMP-2026-001',
    titreNumero: 'TIT-COMP-2026-001',
    annee: 2026,
    montant: 1000,
    montantPaye: 800,
    statutTitre: 'paye_partiel',
    dateEmission: '2026-04-01',
    dateEcheance: '2026-06-30',
    lines: [
      { identifiant: 'DSP-COMP-2026-001', typeId: enseigneId, zoneId: zoneCentreId, surface: 12, montantLigne: 600 },
      { identifiant: 'DSP-COMP-2026-002', typeId: publiciteId, zoneId: zonePeriId, surface: 8, montantLigne: 400 },
    ],
  });
  insertDeclarationWithTitre({
    ctx,
    assujettiId: betaId,
    declarationNumero: 'DEC-COMP-2026-002',
    titreNumero: 'TIT-COMP-2026-002',
    annee: 2026,
    montant: 500,
    montantPaye: 100,
    statutTitre: 'paye_partiel',
    dateEmission: '2026-04-05',
    dateEcheance: '2026-06-30',
    lines: [
      { identifiant: 'DSP-COMP-2026-003', typeId: publiciteId, zoneId: zoneCentreId, surface: 6, montantLigne: 500 },
    ],
  });

  insertDeclarationWithTitre({
    ctx,
    assujettiId: alphaId,
    declarationNumero: 'DEC-COMP-2025-001',
    titreNumero: 'TIT-COMP-2025-001',
    annee: 2025,
    montant: 800,
    montantPaye: 800,
    statutTitre: 'paye',
    dateEmission: '2025-04-01',
    dateEcheance: '2025-06-30',
    lines: [{ identifiant: 'DSP-COMP-2025-001', typeId: enseigneId, zoneId: zoneCentreId, surface: 10, montantLigne: 800 }],
  });
  insertDeclarationWithTitre({
    ctx,
    assujettiId: gammaId,
    declarationNumero: 'DEC-COMP-2025-002',
    titreNumero: 'TIT-COMP-2025-002',
    annee: 2025,
    montant: 400,
    montantPaye: 0,
    statutTitre: 'emis',
    dateEmission: '2025-04-03',
    dateEcheance: '2025-06-30',
    lines: [{ identifiant: 'DSP-COMP-2025-002', typeId: publiciteId, zoneId: zonePeriId, surface: 4, montantLigne: 400 }],
  });

  insertDeclarationWithTitre({
    ctx,
    assujettiId: deltaId,
    declarationNumero: 'DEC-COMP-2024-001',
    titreNumero: 'TIT-COMP-2024-001',
    annee: 2024,
    montant: 600,
    montantPaye: 300,
    statutTitre: 'paye_partiel',
    dateEmission: '2024-04-01',
    dateEcheance: '2024-06-30',
    lines: [
      { identifiant: 'DSP-COMP-2024-001', typeId: enseigneId, zoneId: zoneCentreId, surface: 3, montantLigne: 200 },
      { identifiant: 'DSP-COMP-2024-002', typeId: publiciteId, zoneId: zonePeriId, surface: 5, montantLigne: 400 },
    ],
  });
  insertDeclarationWithTitre({
    ctx,
    assujettiId: gammaId,
    declarationNumero: 'DEC-COMP-2024-002',
    titreNumero: 'TIT-COMP-2024-002',
    annee: 2024,
    montant: 200,
    montantPaye: 50,
    statutTitre: 'paye_partiel',
    dateEmission: '2024-04-10',
    dateEcheance: '2024-06-30',
    lines: [{ identifiant: 'DSP-COMP-2024-003', typeId: publiciteId, zoneId: zonePeriId, surface: 2, montantLigne: 200 }],
  });

  return {
    financier: {
      id: financierId,
      email: 'financier-comparatif@tlpe.local',
      role: 'financier' as const,
      nom: 'Fin',
      prenom: 'Ancier',
      assujetti_id: null,
    },
    gestionnaire: {
      id: gestionnaireId,
      email: 'gestionnaire-comparatif@tlpe.local',
      role: 'gestionnaire' as const,
      nom: 'Gest',
      prenom: 'Ionnaire',
      assujetti_id: null,
    },
  };
}

test('GET /api/rapports/comparatif retourne le comparatif N, N-1, N-2 avec ventilations et évolutions', async () => {
  await withComparatifTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const res = await requestReport(ctx, {
      path: '/api/rapports/comparatif?annee=2026',
      headers: makeAuthHeader(ctx, fx.financier),
    });

    assert.equal(res.status, 200);
    assert.match(res.contentType, /application\/json/);
    assert.equal(res.json?.filters.annee, 2026);
    assert.deepEqual(res.json?.filters.years, [2026, 2025, 2024]);

    assert.deepEqual(
      res.json?.summary.map((row: { annee: number; montant_emis: number; montant_recouvre: number; nombre_assujettis: number; nombre_dispositifs: number }) => [
        row.annee,
        row.montant_emis,
        row.montant_recouvre,
        row.nombre_assujettis,
        row.nombre_dispositifs,
      ]),
      [
        [2026, 1500, 900, 2, 3],
        [2025, 1200, 800, 2, 2],
        [2024, 800, 350, 2, 3],
      ],
    );

    assert.equal(res.json?.evolutions.vs_n1.montant_emis, 0.25);
    assert.equal(res.json?.evolutions.vs_n1.montant_recouvre, 0.125);
    assert.equal(res.json?.evolutions.vs_n1.nombre_assujettis, 0);
    assert.equal(res.json?.evolutions.vs_n1.nombre_dispositifs, 0.5);
    assert.equal(res.json?.evolutions.vs_n2.montant_emis, 0.875);
    assert.equal(res.json?.evolutions.vs_n2.montant_recouvre, 1.5714);

    assert.deepEqual(
      res.json?.breakdowns.zone.map((row: { label: string; values: Array<{ annee: number; montant_emis: number; montant_recouvre: number }> }) => [
        row.label,
        row.values.map((value) => [value.annee, value.montant_emis, value.montant_recouvre]),
      ]),
      [
        ['Zone Centre', [[2026, 1100, 580], [2025, 800, 800], [2024, 200, 100]]],
        ['Zone Périphérie', [[2026, 400, 320], [2025, 400, 0], [2024, 600, 250]]],
      ],
    );

    assert.deepEqual(
      res.json?.breakdowns.categorie.map((row: { label: string; values: Array<{ annee: number; montant_emis: number; montant_recouvre: number }> }) => [
        row.label,
        row.values.map((value) => [value.annee, value.montant_emis, value.montant_recouvre]),
      ]),
      [
        ['Publicitaire', [[2026, 900, 420], [2025, 400, 0], [2024, 600, 250]]],
        ['Enseigne', [[2026, 600, 480], [2025, 800, 800], [2024, 200, 100]]],
      ],
    );
  });
});

test('GET /api/rapports/comparatif exporte en XLSX/PDF, archive et trace l’audit', async () => {
  await withComparatifTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const xlsx = await requestReport(ctx, {
      path: '/api/rapports/comparatif?annee=2026&format=xlsx',
      headers: makeAuthHeader(ctx, fx.financier),
    });
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.contentType, /application\/vnd.openxmlformats-officedocument.spreadsheetml.sheet/);
    assert.match(xlsx.disposition, /comparatif-pluriannuel-2026\.xlsx/);

    const workbook = XLSX.read(xlsx.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: false }) as Array<Array<string | number>>;
    assert.equal(String(rows[0][0]), 'Comparatif pluriannuel TLPE');
    assert.equal(String(rows[1][1]), '2026');
    assert.equal(String(rows[4][0]), 'Année');
    assert.equal(String(rows[5][0]), '2026');

    const pdf = await requestReport(ctx, {
      path: '/api/rapports/comparatif?annee=2026&format=pdf',
      headers: makeAuthHeader(ctx, fx.financier),
    });
    assert.equal(pdf.status, 200);
    assert.match(pdf.contentType, /application\/pdf/);
    assert.match(pdf.disposition, /comparatif-pluriannuel-2026\.pdf/);
    assert.equal(pdf.buffer.subarray(0, 4).toString('utf8'), '%PDF');

    const audits = ctx.db
      .prepare(`SELECT action, entite, details FROM audit_log WHERE action = 'export-comparatif-pluriannuel' ORDER BY id`)
      .all() as Array<{ action: string; entite: string; details: string }>;
    assert.equal(audits.length, 2);
    assert.equal(audits[0].entite, 'rapport');
    assert.match(audits[0].details, /"format":"xlsx"/);
    assert.match(audits[1].details, /"annee":2026/);

    const archives = ctx.db
      .prepare(
        `SELECT type_rapport, format, annee, filename, storage_path, content_hash, titres_count, total_montant
         FROM rapports_exports
         WHERE type_rapport = 'comparatif_pluriannuel'
         ORDER BY id`,
      )
      .all() as Array<{
      type_rapport: string;
      format: string;
      annee: number;
      filename: string;
      storage_path: string;
      content_hash: string;
      titres_count: number;
      total_montant: number;
    }>;
    assert.equal(archives.length, 2);
    assert.equal(archives[0].type_rapport, 'comparatif_pluriannuel');
    assert.equal(archives[0].annee, 2026);
    assert.match(archives[0].filename, /^comparatif-pluriannuel-2026\.xlsx$/);
    assert.match(archives[0].storage_path, /rapports\/comparatif_pluriannuel\/2026\//);
    assert.match(archives[0].content_hash, /^[a-f0-9]{64}$/);
    assert.equal(archives[0].titres_count, 6);
    assert.equal(archives[0].total_montant, 1500);
  });
});

test('GET /api/rapports/comparatif réutilise le jeu de données agrégé pour éviter une double requête brute à l’export', async () => {
  await withComparatifTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const previousPrepare = ctx.db.prepare.bind(ctx.db);
    let rawComparatifSelectCount = 0;
    // @ts-ignore test monkey patch for query counting
    ctx.db.prepare = ((sql: string) => {
      if (sql.includes('FROM titres t') && sql.includes('JOIN lignes_declaration ld')) {
        rawComparatifSelectCount += 1;
      }
      return previousPrepare(sql);
    }) as typeof ctx.db.prepare;

    try {
      const res = await requestReport(ctx, {
        path: '/api/rapports/comparatif?annee=2026&format=xlsx',
        headers: makeAuthHeader(ctx, fx.financier),
      });

      assert.equal(res.status, 200);
      assert.equal(rawComparatifSelectCount, 1);
    } finally {
      // @ts-ignore restore monkey patch after query counting
      ctx.db.prepare = previousPrepare;
    }
  });
});

test('GET /api/rapports/comparatif nettoie l’archive si la persistance SQL échoue', async () => {
  await withComparatifTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const previousPrepare = ctx.db.prepare.bind(ctx.db);
    let forcedOnce = false;
    // @ts-ignore test monkey patch for fault injection
    ctx.db.prepare = ((sql: string) => {
      if (!forcedOnce && sql.includes('INSERT INTO rapports_exports')) {
        forcedOnce = true;
        throw new Error('disk I/O error');
      }
      return previousPrepare(sql);
    }) as typeof ctx.db.prepare;

    const archiveDir = ctx.resolveUploadAbsolutePath('rapports/comparatif_pluriannuel/2026');
    fs.rmSync(archiveDir, { recursive: true, force: true });

    try {
      const res = await requestReport(ctx, {
        path: '/api/rapports/comparatif?annee=2026&format=pdf',
        headers: makeAuthHeader(ctx, fx.financier),
      });

      assert.equal(res.status, 500);
      const archives = ctx.db.prepare(`SELECT storage_path FROM rapports_exports WHERE type_rapport = 'comparatif_pluriannuel'`).all() as Array<{ storage_path: string }>;
      assert.equal(archives.length, 0);
      const remainingFiles = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : [];
      assert.equal(remainingFiles.length, 0);
    } finally {
      // @ts-ignore restore monkey patch after fault injection
      ctx.db.prepare = previousPrepare;
    }
  });
});

test('GET /api/rapports/comparatif refuse les rôles non autorisés et valide les paramètres', async () => {
  await withComparatifTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const forbidden = await requestReport(ctx, {
      path: '/api/rapports/comparatif?annee=2026',
      headers: makeAuthHeader(ctx, fx.gestionnaire),
    });
    assert.equal(forbidden.status, 403);

    const invalid = await requestReport(ctx, {
      path: '/api/rapports/comparatif?annee=1999&format=csv',
      headers: makeAuthHeader(ctx, fx.financier),
    });
    assert.equal(invalid.status, 400);
  });
});
