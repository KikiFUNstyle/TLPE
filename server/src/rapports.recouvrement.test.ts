import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import XLSX from 'xlsx';
import type { AuthUser } from './auth';

type RecouvrementTestContext = {
  db: typeof import('./db').db;
  initSchema: typeof import('./db').initSchema;
  hashPassword: typeof import('./auth').hashPassword;
  signToken: typeof import('./auth').signToken;
  rapportsRouter: typeof import('./routes/rapports').rapportsRouter;
  cleanup: () => void;
};

const RECOUVREMENT_TEST_MODULES = ['./db', './auth', './routes/rapports', './recouvrementReport'] as const;

function clearRecouvrementTestModuleCache() {
  for (const modulePath of RECOUVREMENT_TEST_MODULES) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // ignore cache misses during cleanup
    }
  }
}

function createRecouvrementTestContext(): RecouvrementTestContext {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlpe-rapports-recouvrement-test-'));
  const dbPath = path.join(tempDir, 'tlpe.db');
  const previousDbPath = process.env.TLPE_DB_PATH;
  process.env.TLPE_DB_PATH = dbPath;
  clearRecouvrementTestModuleCache();

  const dbModule = require('./db') as typeof import('./db');
  const authModule = require('./auth') as typeof import('./auth');
  const rapportsModule = require('./routes/rapports') as typeof import('./routes/rapports');

  return {
    db: dbModule.db,
    initSchema: dbModule.initSchema,
    hashPassword: authModule.hashPassword,
    signToken: authModule.signToken,
    rapportsRouter: rapportsModule.rapportsRouter,
    cleanup: () => {
      try {
        dbModule.db.close();
      } catch {
        // ignore close errors during teardown
      }
      clearRecouvrementTestModuleCache();
      if (previousDbPath === undefined) {
        delete process.env.TLPE_DB_PATH;
      } else {
        process.env.TLPE_DB_PATH = previousDbPath;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function withRecouvrementTestContext(run: (ctx: RecouvrementTestContext) => Promise<void> | void) {
  const ctx = createRecouvrementTestContext();
  try {
    await run(ctx);
  } finally {
    ctx.cleanup();
  }
}

function createApp(ctx: RecouvrementTestContext) {
  const app = express();
  app.use(express.json());
  app.use('/api/rapports', ctx.rapportsRouter);
  return app;
}

function makeAuthHeader(ctx: RecouvrementTestContext, user: AuthUser): Record<string, string> {
  return { Authorization: `Bearer ${ctx.signToken(user)}` };
}

async function requestReport(
  ctx: RecouvrementTestContext,
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

function resetFixtures(ctx: RecouvrementTestContext) {
  ctx.initSchema();
  ctx.db.exec('DELETE FROM paiements');
  ctx.db.exec('DELETE FROM titres');
  ctx.db.exec('DELETE FROM lignes_declaration');
  ctx.db.exec('DELETE FROM declarations');
  ctx.db.exec('DELETE FROM dispositifs');
  ctx.db.exec('DELETE FROM audit_log');
  ctx.db.exec('DELETE FROM users');
  ctx.db.exec('DELETE FROM assujettis');
  ctx.db.exec('DELETE FROM types_dispositifs');
  ctx.db.exec('DELETE FROM zones');

  const zoneCentreId = Number(ctx.db.prepare(`INSERT INTO zones (code, libelle, coefficient) VALUES ('ZC', 'Zone Centre', 1.5)`).run().lastInsertRowid);
  const zonePeriId = Number(ctx.db.prepare(`INSERT INTO zones (code, libelle, coefficient) VALUES ('ZP', 'Zone Périphérie', 1.0)`).run().lastInsertRowid);

  const enseigneId = Number(
    ctx.db.prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('ENS-1', 'Enseigne murale', 'enseigne')`).run().lastInsertRowid,
  );
  const publiciteId = Number(
    ctx.db.prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('PUB-1', 'Panneau publicitaire', 'publicitaire')`).run().lastInsertRowid,
  );

  const alphaId = Number(
    ctx.db
      .prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES ('TLPE-REC-001', 'Alpha Médias', 'actif')`)
      .run().lastInsertRowid,
  );
  const betaId = Number(
    ctx.db
      .prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES ('TLPE-REC-002', 'Beta Affichage', 'actif')`)
      .run().lastInsertRowid,
  );
  const gammaId = Number(
    ctx.db
      .prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES ('TLPE-REC-003', 'Gamma Stores', 'actif')`)
      .run().lastInsertRowid,
  );

  const financierId = Number(
    ctx.db
      .prepare(`INSERT INTO users (email, password_hash, nom, prenom, role, actif) VALUES ('financier-rec@tlpe.local', ?, 'Fin', 'Ancier', 'financier', 1)`)
      .run(ctx.hashPassword('x')).lastInsertRowid,
  );
  const contribuableId = Number(
    ctx.db
      .prepare(`INSERT INTO users (email, password_hash, nom, prenom, role, assujetti_id, actif) VALUES ('contrib-rec@tlpe.local', ?, 'Contrib', 'Uable', 'contribuable', ?, 1)`)
      .run(ctx.hashPassword('x'), alphaId).lastInsertRowid,
  );

  const alphaDeclId = Number(
    ctx.db.prepare(`INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total) VALUES ('DEC-REC-001', ?, 2026, 'validee', 700)`).run(alphaId).lastInsertRowid,
  );
  const betaDeclId = Number(
    ctx.db.prepare(`INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total) VALUES ('DEC-REC-002', ?, 2026, 'validee', 300)`).run(betaId).lastInsertRowid,
  );
  const gammaDeclId = Number(
    ctx.db.prepare(`INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total) VALUES ('DEC-REC-003', ?, 2026, 'validee', 100)`).run(gammaId).lastInsertRowid,
  );

  const alphaEnsId = Number(
    ctx.db
      .prepare(`INSERT INTO dispositifs (identifiant, assujetti_id, type_id, zone_id, surface, nombre_faces, statut) VALUES ('DSP-REC-001', ?, ?, ?, 10, 1, 'declare')`)
      .run(alphaId, enseigneId, zoneCentreId).lastInsertRowid,
  );
  const alphaPubId = Number(
    ctx.db
      .prepare(`INSERT INTO dispositifs (identifiant, assujetti_id, type_id, zone_id, surface, nombre_faces, statut) VALUES ('DSP-REC-002', ?, ?, ?, 4, 1, 'declare')`)
      .run(alphaId, publiciteId, zonePeriId).lastInsertRowid,
  );
  const betaEnsId = Number(
    ctx.db
      .prepare(`INSERT INTO dispositifs (identifiant, assujetti_id, type_id, zone_id, surface, nombre_faces, statut) VALUES ('DSP-REC-003', ?, ?, ?, 8, 1, 'declare')`)
      .run(betaId, enseigneId, zoneCentreId).lastInsertRowid,
  );
  const gammaPubId = Number(
    ctx.db
      .prepare(`INSERT INTO dispositifs (identifiant, assujetti_id, type_id, zone_id, surface, nombre_faces, statut) VALUES ('DSP-REC-004', ?, ?, ?, 2, 1, 'declare')`)
      .run(gammaId, publiciteId, zonePeriId).lastInsertRowid,
  );

  ctx.db.prepare(`INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne) VALUES (?, ?, 10, 1, '2026-01-01', 500)`).run(alphaDeclId, alphaEnsId);
  ctx.db.prepare(`INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne) VALUES (?, ?, 4, 1, '2026-01-01', 200)`).run(alphaDeclId, alphaPubId);
  ctx.db.prepare(`INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne) VALUES (?, ?, 8, 1, '2026-01-01', 300)`).run(betaDeclId, betaEnsId);
  ctx.db.prepare(`INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne) VALUES (?, ?, 2, 1, '2026-01-01', 100)`).run(gammaDeclId, gammaPubId);

  const alphaTitreId = Number(
    ctx.db
      .prepare(`INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, montant_paye, date_emission, date_echeance, statut) VALUES ('TIT-REC-001', ?, ?, 2026, 700, 350, '2026-04-01', '2026-06-01', 'paye_partiel')`)
      .run(alphaDeclId, alphaId).lastInsertRowid,
  );
  ctx.db.prepare(`INSERT INTO paiements (titre_id, montant, date_paiement, modalite, provider, statut, reference) VALUES (?, 350, '2026-05-01', 'virement', 'manuel', 'confirme', 'PAY-REC-001')`).run(alphaTitreId);
  const betaTitreId = Number(
    ctx.db
      .prepare(`INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, montant_paye, date_emission, date_echeance, statut) VALUES ('TIT-REC-002', ?, ?, 2026, 300, 300, '2026-04-01', '2026-06-01', 'paye')`)
      .run(betaDeclId, betaId).lastInsertRowid,
  );
  ctx.db.prepare(`INSERT INTO paiements (titre_id, montant, date_paiement, modalite, provider, statut, reference) VALUES (?, 300, '2026-05-02', 'virement', 'manuel', 'confirme', 'PAY-REC-002')`).run(betaTitreId);
  ctx.db
    .prepare(`INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, montant_paye, date_emission, date_echeance, statut) VALUES ('TIT-REC-003', ?, ?, 2026, 100, 0, '2026-04-01', '2026-06-01', 'emis')`)
    .run(gammaDeclId, gammaId);

  return {
    financier: {
      id: financierId,
      email: 'financier-rec@tlpe.local',
      role: 'financier' as const,
      nom: 'Fin',
      prenom: 'Ancier',
      assujetti_id: null,
    },
    contribuable: {
      id: contribuableId,
      email: 'contrib-rec@tlpe.local',
      role: 'contribuable' as const,
      nom: 'Contrib',
      prenom: 'Uable',
      assujetti_id: alphaId,
    },
    zoneCentreId,
  };
}

test('GET /api/rapports/recouvrement retourne les totaux et ventilations filtrables', async () => {
  await withRecouvrementTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const res = await requestReport(ctx, {
      path: '/api/rapports/recouvrement?annee=2026',
      headers: makeAuthHeader(ctx, fx.financier),
    });

    assert.equal(res.status, 200);
    assert.match(res.contentType, /application\/json/);
    assert.equal(res.json?.filters.annee, 2026);
    assert.equal(res.json?.totals.montant_emis, 1100);
    assert.equal(res.json?.totals.montant_recouvre, 650);
    assert.equal(res.json?.totals.reste_a_recouvrer, 450);
    assert.equal(res.json?.totals.taux_recouvrement, 0.5909);

    assert.deepEqual(
      res.json?.breakdowns.assujetti.map((row: { label: string; montant_emis: number; montant_recouvre: number; reste_a_recouvrer: number }) => [row.label, row.montant_emis, row.montant_recouvre, row.reste_a_recouvrer]),
      [
        ['Alpha Médias', 700, 350, 350],
        ['Beta Affichage', 300, 300, 0],
        ['Gamma Stores', 100, 0, 100],
      ],
    );

    const zoneFilter = await requestReport(ctx, {
      path: `/api/rapports/recouvrement?annee=2026&zone=${fx.zoneCentreId}`,
      headers: makeAuthHeader(ctx, fx.financier),
    });
    assert.equal(zoneFilter.status, 200);
    assert.equal(zoneFilter.json?.totals.montant_emis, 800);
    assert.equal(zoneFilter.json?.totals.montant_recouvre, 550);
    assert.equal(zoneFilter.json?.totals.reste_a_recouvrer, 250);

    const categoryFilter = await requestReport(ctx, {
      path: '/api/rapports/recouvrement?annee=2026&categorie=publicitaire&statut_paiement=emis',
      headers: makeAuthHeader(ctx, fx.financier),
    });
    assert.equal(categoryFilter.status, 200);
    assert.equal(categoryFilter.json?.totals.montant_emis, 100);
    assert.equal(categoryFilter.json?.totals.montant_recouvre, 0);
    assert.equal(categoryFilter.json?.totals.reste_a_recouvrer, 100);
  });
});

test('GET /api/rapports/recouvrement exporte en XLSX et PDF avec audit dédié', async () => {
  await withRecouvrementTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const xlsx = await requestReport(ctx, {
      path: '/api/rapports/recouvrement?annee=2026&ventilation=zone&format=xlsx',
      headers: makeAuthHeader(ctx, fx.financier),
    });

    assert.equal(xlsx.status, 200);
    assert.match(xlsx.contentType, /application\/vnd.openxmlformats-officedocument.spreadsheetml.sheet/);
    assert.match(xlsx.disposition, /etat-recouvrement-zone-2026\.xlsx/);

    const workbook = XLSX.read(xlsx.buffer, { type: 'buffer' });
    const summaryRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: false }) as Array<Array<string | number>>;
    assert.equal(String(summaryRows[0][0]), 'État de recouvrement TLPE');
    assert.equal(String(summaryRows[1][1]), '2026');
    assert.equal(String(summaryRows[7][0]), 'Zone Centre');

    const pdf = await requestReport(ctx, {
      path: '/api/rapports/recouvrement?annee=2026&ventilation=assujetti&format=pdf',
      headers: makeAuthHeader(ctx, fx.financier),
    });

    assert.equal(pdf.status, 200);
    assert.match(pdf.contentType, /application\/pdf/);
    assert.match(pdf.disposition, /etat-recouvrement-assujetti-2026\.pdf/);
    assert.equal(pdf.buffer.subarray(0, 4).toString('utf8'), '%PDF');

    const audits = ctx.db
      .prepare(`SELECT action, entite, details FROM audit_log WHERE action = 'export-etat-recouvrement' ORDER BY id`)
      .all() as Array<{ action: string; entite: string; details: string }>;
    assert.equal(audits.length, 2);
    assert.equal(audits[0].entite, 'rapport');
    assert.match(audits[0].details, /"format":"xlsx"/);
    assert.match(audits[1].details, /"format":"pdf"/);
    assert.match(audits[1].details, /"ventilation":"assujetti"/);

    const archives = ctx.db
      .prepare(
        `SELECT type_rapport, format, annee, filename, storage_path, content_hash, titres_count, total_montant
         FROM rapports_exports
         WHERE type_rapport = 'etat_recouvrement'
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
    assert.equal(archives[0].type_rapport, 'etat_recouvrement');
    assert.equal(archives[0].annee, 2026);
    assert.equal(archives[0].format, 'xlsx');
    assert.match(archives[0].filename, /^etat-recouvrement-zone-2026\.xlsx$/);
    assert.match(archives[0].storage_path, /rapports\/etat_recouvrement\/2026\//);
    assert.match(archives[0].content_hash, /^[a-f0-9]{64}$/);
    assert.equal(archives[0].titres_count, 3);
    assert.equal(archives[0].total_montant, 1100);
  });
});

test('GET /api/rapports/recouvrement nettoie l’archive si la persistance SQL échoue', async () => {
  await withRecouvrementTestContext(async (ctx) => {
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

    const archiveDir = path.join(process.cwd(), 'data', 'uploads', 'rapports', 'etat_recouvrement', '2026');
    fs.rmSync(archiveDir, { recursive: true, force: true });

    try {
      const res = await requestReport(ctx, {
        path: '/api/rapports/recouvrement?annee=2026&ventilation=zone&format=pdf',
        headers: makeAuthHeader(ctx, fx.financier),
      });

      assert.equal(res.status, 500);
      const archives = ctx.db.prepare(`SELECT storage_path FROM rapports_exports WHERE type_rapport = 'etat_recouvrement'`).all() as Array<{
        storage_path: string;
      }>;
      assert.equal(archives.length, 0);

      const remainingFiles = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : [];
      assert.equal(remainingFiles.length, 0);
    } finally {
      // @ts-ignore restore monkey patch after fault injection
      ctx.db.prepare = previousPrepare;
    }
  });
});

test('GET /api/rapports/recouvrement refuse les rôles non autorisés et valide les paramètres', async () => {
  await withRecouvrementTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const forbidden = await requestReport(ctx, {
      path: '/api/rapports/recouvrement?annee=2026',
      headers: makeAuthHeader(ctx, fx.contribuable),
    });
    assert.equal(forbidden.status, 403);

    const invalid = await requestReport(ctx, {
      path: '/api/rapports/recouvrement?annee=1999&ventilation=foo',
      headers: makeAuthHeader(ctx, fx.financier),
    });
    assert.equal(invalid.status, 400);
  });
});
