import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import XLSX from 'xlsx';
import type { AuthUser } from './auth';

type ContentieuxReportTestContext = {
  db: typeof import('./db').db;
  initSchema: typeof import('./db').initSchema;
  hashPassword: typeof import('./auth').hashPassword;
  signToken: typeof import('./auth').signToken;
  rapportsRouter: typeof import('./routes/rapports').rapportsRouter;
  cleanup: () => void;
};

const CONTENTIEUX_REPORT_TEST_MODULES = ['./db', './auth', './routes/rapports'] as const;

function clearContentieuxReportTestModuleCache() {
  for (const modulePath of CONTENTIEUX_REPORT_TEST_MODULES) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // ignore cache misses during cleanup
    }
  }
}

function createContentieuxReportTestContext(): ContentieuxReportTestContext {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlpe-rapports-contentieux-test-'));
  const dbPath = path.join(tempDir, 'tlpe.db');
  const previousDbPath = process.env.TLPE_DB_PATH;
  process.env.TLPE_DB_PATH = dbPath;
  clearContentieuxReportTestModuleCache();

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
      clearContentieuxReportTestModuleCache();
      if (previousDbPath === undefined) {
        delete process.env.TLPE_DB_PATH;
      } else {
        process.env.TLPE_DB_PATH = previousDbPath;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function withContentieuxReportTestContext(run: (ctx: ContentieuxReportTestContext) => Promise<void> | void) {
  const ctx = createContentieuxReportTestContext();
  try {
    await run(ctx);
  } finally {
    ctx.cleanup();
  }
}

function createApp(ctx: ContentieuxReportTestContext) {
  const app = express();
  app.use(express.json());
  app.use('/api/rapports', ctx.rapportsRouter);
  return app;
}

function makeAuthHeader(ctx: ContentieuxReportTestContext, user: AuthUser): Record<string, string> {
  return { Authorization: `Bearer ${ctx.signToken(user)}` };
}

async function requestReport(
  ctx: ContentieuxReportTestContext,
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

function resetFixtures(ctx: ContentieuxReportTestContext) {
  ctx.initSchema();
  ctx.db.pragma('foreign_keys = OFF');
  try {
    ctx.db.exec('DELETE FROM rapports_exports');
    ctx.db.exec('DELETE FROM evenements_contentieux');
    ctx.db.exec('DELETE FROM contentieux_alerts');
    ctx.db.exec('DELETE FROM contentieux');
    ctx.db.exec('DELETE FROM audit_log');
    ctx.db.exec('DELETE FROM users');
    ctx.db.exec('DELETE FROM assujettis');
  } finally {
    ctx.db.pragma('foreign_keys = ON');
  }

  const financierId = Number(
    ctx.db
      .prepare(
        `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
         VALUES ('financier-contentieux@tlpe.local', ?, 'Fin', 'Ancier', 'financier', 1)`,
      )
      .run(ctx.hashPassword('x')).lastInsertRowid,
  );
  const gestionnaireId = Number(
    ctx.db
      .prepare(
        `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
         VALUES ('gestionnaire-contentieux@tlpe.local', ?, 'Gest', 'Ionnaire', 'gestionnaire', 1)`,
      )
      .run(ctx.hashPassword('x')).lastInsertRowid,
  );

  const alphaId = Number(
    ctx.db
      .prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES ('TLPE-CTX-001', 'Alpha Média', 'actif')`)
      .run().lastInsertRowid,
  );
  const betaId = Number(
    ctx.db
      .prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES ('TLPE-CTX-002', 'Beta Enseignes', 'actif')`)
      .run().lastInsertRowid,
  );
  const gammaId = Number(
    ctx.db
      .prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES ('TLPE-CTX-003', 'Gamma Stores', 'actif')`)
      .run().lastInsertRowid,
  );
  const deltaId = Number(
    ctx.db
      .prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES ('TLPE-CTX-004', 'Delta Publicité', 'actif')`)
      .run().lastInsertRowid,
  );

  ctx.db.prepare(
    `INSERT INTO contentieux (
      numero, assujetti_id, type, montant_litige, montant_degreve, date_ouverture, date_limite_reponse, statut, description
    ) VALUES ('CTX-2026-00001', ?, 'contentieux', 1000, NULL, '2026-01-01', '2026-07-30', 'ouvert', 'Recours principal')`,
  ).run(alphaId);
  ctx.db.prepare(
    `INSERT INTO contentieux (
      numero, assujetti_id, type, montant_litige, montant_degreve, date_ouverture, date_cloture, statut, description, decision
    ) VALUES ('CTX-2026-00002', ?, 'contentieux', 600, 600, '2026-02-01', '2026-03-15', 'degrevement_total', 'Réclamation soldée', 'Dégrèvement total accordé')`,
  ).run(betaId);
  ctx.db.prepare(
    `INSERT INTO contentieux (
      numero, assujetti_id, type, montant_litige, montant_degreve, date_ouverture, date_cloture, statut, description, decision
    ) VALUES ('CTX-2026-00003', ?, 'gracieux', 300, 120, '2026-04-01', '2026-05-10', 'degrevement_partiel', 'Demande de remise partielle', 'Remise partielle accordée')`,
  ).run(gammaId);
  ctx.db.prepare(
    `INSERT INTO contentieux (
      numero, assujetti_id, type, montant_litige, montant_degreve, date_ouverture, date_limite_reponse, statut, description
    ) VALUES ('CTX-2026-00004', ?, 'moratoire', 500, NULL, '2026-05-15', '2026-06-20', 'ouvert', 'Moratoire en attente')`,
  ).run(deltaId);

  return {
    financier: {
      id: financierId,
      email: 'financier-contentieux@tlpe.local',
      role: 'financier' as const,
      nom: 'Fin',
      prenom: 'Ancier',
      assujetti_id: null,
    },
    gestionnaire: {
      id: gestionnaireId,
      email: 'gestionnaire-contentieux@tlpe.local',
      role: 'gestionnaire' as const,
      nom: 'Gest',
      prenom: 'Ionnaire',
      assujetti_id: null,
    },
  };
}

test('GET /api/rapports/contentieux retourne la synthèse par type, les statuts et les alertes d échéance', async () => {
  await withContentieuxReportTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const res = await requestReport(ctx, {
      path: '/api/rapports/contentieux?date_reference=2026-06-30',
      headers: makeAuthHeader(ctx, fx.financier),
    });

    assert.equal(res.status, 200);
    assert.match(res.contentType, /application\/json/);
    assert.equal(res.json?.date_reference, '2026-06-30');
    assert.equal(res.json?.indicators.total_dossiers, 2);
    assert.equal(res.json?.indicators.montant_litige_total, 1500);
    assert.equal(res.json?.indicators.montant_degreve_total, 0);
    assert.equal(res.json?.alerts.total, 2);
    assert.equal(res.json?.alerts.overdue, 1);

    assert.deepEqual(
      res.json?.rows.map((row: { type: string; nombre_dossiers: number; montant_litige: number; montant_degreve: number; anciennete_moyenne_jours: number; statut_resume: string }) => [
        row.type,
        row.nombre_dossiers,
        row.montant_litige,
        row.montant_degreve,
        row.anciennete_moyenne_jours,
        row.statut_resume,
      ]),
      [
        ['contentieux', 1, 1000, 0, 180, '1 ouvert'],
        ['moratoire', 1, 500, 0, 46, '1 ouvert'],
      ],
    );

    assert.deepEqual(
      res.json?.alerts.rows.map((row: { numero: string; niveau_alerte: string; days_remaining: number }) => [row.numero, row.niveau_alerte, row.days_remaining]),
      [
        ['CTX-2026-00004', 'depasse', -10],
        ['CTX-2026-00001', 'J-30', 30],
      ],
    );
  });
});

test('GET /api/rapports/contentieux exporte en XLSX et PDF avec archive et audit dédiés', async () => {
  await withContentieuxReportTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const xlsx = await requestReport(ctx, {
      path: '/api/rapports/contentieux?date_reference=2026-06-30&format=xlsx',
      headers: makeAuthHeader(ctx, fx.financier),
    });
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.contentType, /application\/vnd.openxmlformats-officedocument.spreadsheetml.sheet/);
    assert.match(xlsx.disposition, /synthese-contentieux-2026-06-30\.xlsx/);

    const workbook = XLSX.read(xlsx.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: false }) as Array<Array<string | number>>;
    assert.equal(String(rows[0][0]), 'Synthèse des contentieux');
    assert.equal(String(rows[1][1]), '2026-06-30');
    assert.equal(String(rows[8][0]), 'Type');
    assert.equal(String(rows[9][0]), 'Contentieux');

    const pdf = await requestReport(ctx, {
      path: '/api/rapports/contentieux?date_reference=2026-06-30&format=pdf',
      headers: makeAuthHeader(ctx, fx.financier),
    });
    assert.equal(pdf.status, 200);
    assert.match(pdf.contentType, /application\/pdf/);
    assert.match(pdf.disposition, /synthese-contentieux-2026-06-30\.pdf/);
    assert.equal(pdf.buffer.subarray(0, 4).toString('utf8'), '%PDF');

    const audits = ctx.db
      .prepare(`SELECT action, entite, details FROM audit_log WHERE action = 'export-synthese-contentieux' ORDER BY id`)
      .all() as Array<{ action: string; entite: string; details: string }>;
    assert.equal(audits.length, 2);
    assert.equal(audits[0].entite, 'rapport');
    assert.match(audits[0].details, /"format":"xlsx"/);
    assert.match(audits[1].details, /"format":"pdf"/);

    const archives = ctx.db
      .prepare(
        `SELECT type_rapport, format, annee, filename, storage_path, content_hash, titres_count, total_montant
         FROM rapports_exports
         WHERE type_rapport = 'synthese_contentieux'
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
    assert.equal(archives[0].type_rapport, 'synthese_contentieux');
    assert.equal(archives[0].annee, 2026);
    assert.match(archives[0].filename, /^synthese-contentieux-2026-06-30\.xlsx$/);
    assert.match(archives[0].storage_path, /rapports\/synthese_contentieux\/2026\//);
    assert.match(archives[0].content_hash, /^[a-f0-9]{64}$/);
    assert.equal(archives[0].titres_count, 2);
    assert.equal(archives[0].total_montant, 1500);
  });
});

test('GET /api/rapports/contentieux exporte aussi les libellés gracieux/contrôle et le statut instruction', async () => {
  await withContentieuxReportTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const assujettiGracieuxId = Number(
      ctx.db.prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES ('TLPE-CTX-005', 'Epsilon Gracieux', 'actif')`).run().lastInsertRowid,
    );
    const assujettiControleId = Number(
      ctx.db.prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES ('TLPE-CTX-006', 'Zeta Contrôle', 'actif')`).run().lastInsertRowid,
    );

    ctx.db.prepare(
      `INSERT INTO contentieux (
        numero, assujetti_id, type, montant_litige, montant_degreve, date_ouverture, date_limite_reponse, statut, description
      ) VALUES ('CTX-2026-00005', ?, 'gracieux', 250, NULL, '2026-03-01', '2026-12-15', 'ouvert', 'Demande gracieuse encore ouverte')`,
    ).run(assujettiGracieuxId);
    ctx.db.prepare(
      `INSERT INTO contentieux (
        numero, assujetti_id, type, montant_litige, montant_degreve, date_ouverture, date_limite_reponse, statut, description
      ) VALUES ('CTX-2026-00006', ?, 'controle', 410, NULL, '2026-03-10', '2026-12-20', 'instruction', 'Contrôle en cours d instruction')`,
    ).run(assujettiControleId);

    const xlsx = await requestReport(ctx, {
      path: '/api/rapports/contentieux?date_reference=2026-06-30&format=xlsx',
      headers: makeAuthHeader(ctx, fx.financier),
    });
    assert.equal(xlsx.status, 200);

    const workbook = XLSX.read(xlsx.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: false }) as Array<Array<string | number>>;
    const summaryRows = rows.slice(9, 13).map((row) => [String(row[0]), String(row[5])]);
    assert.ok(summaryRows.some((row) => row[0] === 'Gracieux' && row[1] === '1 ouvert'));
    assert.ok(summaryRows.some((row) => row[0] === 'Contrôle' && row[1] === '1 instruction'));
  });
});

test('GET /api/rapports/contentieux exporte un PDF sans alerte quand aucune échéance n est à J-30', async () => {
  await withContentieuxReportTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const res = await requestReport(ctx, {
      path: '/api/rapports/contentieux?date_reference=2026-01-01&format=pdf',
      headers: makeAuthHeader(ctx, fx.financier),
    });

    assert.equal(res.status, 200);
    assert.match(res.contentType, /application\/pdf/);
    assert.match(res.disposition, /synthese-contentieux-2026-01-01\.pdf/);
    assert.equal(res.buffer.subarray(0, 4).toString('utf8'), '%PDF');

    const archive = ctx.db.prepare(
      `SELECT titres_count, total_montant FROM rapports_exports WHERE type_rapport = 'synthese_contentieux' AND annee = 2026 ORDER BY id DESC LIMIT 1`,
    ).get() as { titres_count: number; total_montant: number } | undefined;
    assert.ok(archive);
    assert.equal(archive?.titres_count, 2);
    assert.equal(archive?.total_montant, 1500);
  });
});

test('GET /api/rapports/contentieux nettoie l archive si la persistance SQL échoue', async () => {
  await withContentieuxReportTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const previousPrepare = ctx.db.prepare.bind(ctx.db);
    let forcedOnce = false;
    // @ts-ignore fault injection for test
    ctx.db.prepare = ((sql: string) => {
      if (!forcedOnce && sql.includes('INSERT INTO rapports_exports')) {
        forcedOnce = true;
        throw new Error('disk I/O error');
      }
      return previousPrepare(sql);
    }) as typeof ctx.db.prepare;

    const archiveDir = path.join(process.cwd(), 'data', 'uploads', 'rapports', 'synthese_contentieux', '2026');
    fs.rmSync(archiveDir, { recursive: true, force: true });

    try {
      const res = await requestReport(ctx, {
        path: '/api/rapports/contentieux?date_reference=2026-06-30&format=pdf',
        headers: makeAuthHeader(ctx, fx.financier),
      });
      assert.equal(res.status, 500);

      const archives = ctx.db.prepare(`SELECT storage_path FROM rapports_exports WHERE type_rapport = 'synthese_contentieux'`).all() as Array<{ storage_path: string }>;
      assert.equal(archives.length, 0);

      const remainingFiles = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : [];
      assert.equal(remainingFiles.length, 0);
    } finally {
      // @ts-ignore restore monkey patch after fault injection
      ctx.db.prepare = previousPrepare;
    }
  });
});

test('GET /api/rapports/contentieux refuse les rôles non autorisés et valide les paramètres', async () => {
  await withContentieuxReportTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const forbidden = await requestReport(ctx, {
      path: '/api/rapports/contentieux?date_reference=2026-06-30',
      headers: makeAuthHeader(ctx, fx.gestionnaire),
    });
    assert.equal(forbidden.status, 403);

    const invalid = await requestReport(ctx, {
      path: '/api/rapports/contentieux?date_reference=2026-02-30',
      headers: makeAuthHeader(ctx, fx.financier),
    });
    assert.equal(invalid.status, 400);
  });
});
