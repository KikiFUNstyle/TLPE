import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import PDFDocument from 'pdfkit';
import type { AuthUser } from './auth';

type RecettesGeoTestContext = {
  db: typeof import('./db').db;
  initSchema: typeof import('./db').initSchema;
  hashPassword: typeof import('./auth').hashPassword;
  signToken: typeof import('./auth').signToken;
  rapportsRouter: typeof import('./routes/rapports').rapportsRouter;
  resolveUploadAbsolutePath: typeof import('./routes/piecesJointes').resolveUploadAbsolutePath;
  measureRecettesGeographiquesPdfLineHeight: typeof import('./routes/rapports').measureRecettesGeographiquesPdfLineHeight;
  cleanup: () => void;
};

const TEST_MODULES = ['./db', './auth', './routes/piecesJointes', './routes/rapports', './recouvrementReport'] as const;

function clearTestModuleCache() {
  for (const modulePath of TEST_MODULES) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // ignore cache misses during cleanup
    }
  }
}

function createTestContext(): RecettesGeoTestContext {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlpe-recettes-geo-test-'));
  const dbPath = path.join(tempDir, 'tlpe.db');
  const previousDbPath = process.env.TLPE_DB_PATH;
  const previousUploadStorage = process.env.TLPE_UPLOAD_STORAGE;
  process.env.TLPE_DB_PATH = dbPath;
  process.env.TLPE_UPLOAD_STORAGE = 'local';
  clearTestModuleCache();

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
    measureRecettesGeographiquesPdfLineHeight: rapportsModule.measureRecettesGeographiquesPdfLineHeight,
    cleanup: () => {
      try {
        dbModule.db.close();
      } catch {
        // ignore close errors during teardown
      }
      clearTestModuleCache();
      if (previousDbPath === undefined) {
        delete process.env.TLPE_DB_PATH;
      } else {
        process.env.TLPE_DB_PATH = previousDbPath;
      }
      if (previousUploadStorage === undefined) {
        delete process.env.TLPE_UPLOAD_STORAGE;
      } else {
        process.env.TLPE_UPLOAD_STORAGE = previousUploadStorage;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function withTestContext(run: (ctx: RecettesGeoTestContext) => Promise<void> | void) {
  const ctx = createTestContext();
  try {
    await run(ctx);
  } finally {
    ctx.cleanup();
  }
}

function createApp(ctx: RecettesGeoTestContext) {
  const app = express();
  app.use(express.json());
  app.use('/api/rapports', ctx.rapportsRouter);
  return app;
}

function makeAuthHeader(ctx: RecettesGeoTestContext, user: AuthUser): Record<string, string> {
  return { Authorization: `Bearer ${ctx.signToken(user)}` };
}

async function requestGeoReport(
  ctx: RecettesGeoTestContext,
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
      buffer,
      json: contentType.includes('application/json') ? JSON.parse(buffer.toString('utf8')) : null,
    };
  } finally {
    server.close();
  }
}

function resetFixtures(ctx: RecettesGeoTestContext) {
  ctx.initSchema();
  ctx.db.pragma('foreign_keys = OFF');
  try {
    ctx.db.exec('DELETE FROM rapports_exports');
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
  } finally {
    ctx.db.pragma('foreign_keys = ON');
  }

  const zoneCentreId = Number(
    ctx.db
      .prepare(`INSERT INTO zones (code, libelle, coefficient, geometry) VALUES ('ZC', 'Zone Centre', 1.5, ?)`)
      .run(JSON.stringify({
        type: 'Polygon',
        coordinates: [[[2, 48], [3, 48], [3, 49], [2, 49], [2, 48]]],
      })).lastInsertRowid,
  );
  const zonePeriId = Number(
    ctx.db
      .prepare(`INSERT INTO zones (code, libelle, coefficient, geometry) VALUES ('ZP', 'Zone Périphérie', 1.0, ?)`)
      .run(JSON.stringify({
        type: 'Polygon',
        coordinates: [[[3, 48], [4, 48], [4, 49], [3, 49], [3, 48]]],
      })).lastInsertRowid,
  );

  const enseigneId = Number(
    ctx.db.prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('ENS-1', 'Enseigne murale', 'enseigne')`).run().lastInsertRowid,
  );
  const publiciteId = Number(
    ctx.db.prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('PUB-1', 'Panneau publicitaire', 'publicitaire')`).run().lastInsertRowid,
  );

  const alphaId = Number(
    ctx.db.prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES ('TLPE-GEO-001', 'Alpha Médias', 'actif')`).run().lastInsertRowid,
  );
  const betaId = Number(
    ctx.db.prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES ('TLPE-GEO-002', 'Beta Affichage', 'actif')`).run().lastInsertRowid,
  );
  const gammaId = Number(
    ctx.db.prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES ('TLPE-GEO-003', 'Gamma Stores', 'actif')`).run().lastInsertRowid,
  );

  const financierId = Number(
    ctx.db
      .prepare(`INSERT INTO users (email, password_hash, nom, prenom, role, actif) VALUES ('financier-geo@tlpe.local', ?, 'Geo', 'Finance', 'financier', 1)`)
      .run(ctx.hashPassword('x')).lastInsertRowid,
  );
  const contribuableId = Number(
    ctx.db
      .prepare(`INSERT INTO users (email, password_hash, nom, prenom, role, assujetti_id, actif) VALUES ('contrib-geo@tlpe.local', ?, 'Geo', 'Contrib', 'contribuable', ?, 1)`)
      .run(ctx.hashPassword('x'), alphaId).lastInsertRowid,
  );

  const alphaDeclId = Number(
    ctx.db.prepare(`INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total) VALUES ('DEC-GEO-001', ?, 2026, 'validee', 700)`).run(alphaId).lastInsertRowid,
  );
  const betaDeclId = Number(
    ctx.db.prepare(`INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total) VALUES ('DEC-GEO-002', ?, 2026, 'validee', 300)`).run(betaId).lastInsertRowid,
  );
  const gammaDeclId = Number(
    ctx.db.prepare(`INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total) VALUES ('DEC-GEO-003', ?, 2026, 'validee', 100)`).run(gammaId).lastInsertRowid,
  );

  const alphaEnsId = Number(
    ctx.db
      .prepare(`INSERT INTO dispositifs (identifiant, assujetti_id, type_id, zone_id, surface, nombre_faces, statut) VALUES ('DSP-GEO-001', ?, ?, ?, 10, 1, 'declare')`)
      .run(alphaId, enseigneId, zoneCentreId).lastInsertRowid,
  );
  const alphaPubId = Number(
    ctx.db
      .prepare(`INSERT INTO dispositifs (identifiant, assujetti_id, type_id, zone_id, surface, nombre_faces, statut) VALUES ('DSP-GEO-002', ?, ?, ?, 4, 1, 'declare')`)
      .run(alphaId, publiciteId, zonePeriId).lastInsertRowid,
  );
  const betaEnsId = Number(
    ctx.db
      .prepare(`INSERT INTO dispositifs (identifiant, assujetti_id, type_id, zone_id, surface, nombre_faces, statut) VALUES ('DSP-GEO-003', ?, ?, ?, 8, 1, 'declare')`)
      .run(betaId, enseigneId, zoneCentreId).lastInsertRowid,
  );
  const gammaPubId = Number(
    ctx.db
      .prepare(`INSERT INTO dispositifs (identifiant, assujetti_id, type_id, zone_id, surface, nombre_faces, statut) VALUES ('DSP-GEO-004', ?, ?, ?, 2, 1, 'declare')`)
      .run(gammaId, publiciteId, zonePeriId).lastInsertRowid,
  );

  ctx.db.prepare(`INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne) VALUES (?, ?, 10, 1, '2026-01-01', 500)`).run(alphaDeclId, alphaEnsId);
  ctx.db.prepare(`INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne) VALUES (?, ?, 4, 1, '2026-01-01', 200)`).run(alphaDeclId, alphaPubId);
  ctx.db.prepare(`INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne) VALUES (?, ?, 8, 1, '2026-01-01', 300)`).run(betaDeclId, betaEnsId);
  ctx.db.prepare(`INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne) VALUES (?, ?, 2, 1, '2026-01-01', 100)`).run(gammaDeclId, gammaPubId);

  ctx.db
    .prepare(`INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, montant_paye, date_emission, date_echeance, statut) VALUES ('TIT-GEO-001', ?, ?, 2026, 700, 350, '2026-04-01', '2026-06-01', 'paye_partiel')`)
    .run(alphaDeclId, alphaId);
  ctx.db
    .prepare(`INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, montant_paye, date_emission, date_echeance, statut) VALUES ('TIT-GEO-002', ?, ?, 2026, 300, 300, '2026-04-01', '2026-06-01', 'paye')`)
    .run(betaDeclId, betaId);
  ctx.db
    .prepare(`INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, montant_paye, date_emission, date_echeance, statut) VALUES ('TIT-GEO-003', ?, ?, 2026, 100, 0, '2026-04-01', '2026-06-01', 'emis')`)
    .run(gammaDeclId, gammaId);

  return {
    financier: {
      id: financierId,
      email: 'financier-geo@tlpe.local',
      role: 'financier' as const,
      nom: 'Geo',
      prenom: 'Finance',
      assujetti_id: null,
    },
    contribuable: {
      id: contribuableId,
      email: 'contrib-geo@tlpe.local',
      role: 'contribuable' as const,
      nom: 'Geo',
      prenom: 'Contrib',
      assujetti_id: alphaId,
    },
  };
}

test('GET /api/rapports/recettes-geographiques retourne la ventilation choroplèthe par zone avec détails', async () => {
  await withTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const res = await requestGeoReport(ctx, {
      path: '/api/rapports/recettes-geographiques?annee=2026',
      headers: makeAuthHeader(ctx, fx.financier),
    });

    assert.equal(res.status, 200);
    assert.equal(res.json?.annee, 2026);
    assert.equal(res.json?.totals.montant_emis, 1100);
    assert.equal(res.json?.totals.montant_recouvre, 650);
    assert.equal(res.json?.totals.reste_a_recouvrer, 450);
    assert.equal(res.json?.zones.length, 2);

    const centre = res.json?.zones.find((zone: { zone_code: string }) => zone.zone_code === 'ZC');
    assert.ok(centre);
    assert.equal(centre.zone_label, 'Zone Centre');
    assert.equal(centre.montant_emis, 800);
    assert.equal(centre.montant_recouvre, 550);
    assert.equal(centre.reste_a_recouvrer, 250);
    assert.equal(centre.titres_count, 2);
    assert.equal(centre.assujettis_count, 2);
    assert.deepEqual(
      centre.assujettis.map((row: { label: string; montant_recouvre: number; titres_count: number }) => [row.label, row.montant_recouvre, row.titres_count]),
      [
        ['Beta Affichage', 300, 1],
        ['Alpha Médias', 250, 1],
      ],
    );
    assert.deepEqual(
      centre.titres.map((row: { numero_titre: string; assujetti_label: string; montant_recouvre: number; montant_emis: number }) => [row.numero_titre, row.assujetti_label, row.montant_recouvre, row.montant_emis]),
      [
        ['TIT-GEO-002', 'Beta Affichage', 300, 300],
        ['TIT-GEO-001', 'Alpha Médias', 250, 500],
      ],
    );

    const peripherie = res.json?.zones.find((zone: { zone_code: string }) => zone.zone_code === 'ZP');
    assert.ok(peripherie);
    assert.equal(peripherie.montant_emis, 300);
    assert.equal(peripherie.montant_recouvre, 100);
    assert.equal(peripherie.reste_a_recouvrer, 200);
    assert.equal(peripherie.titres_count, 2);
    assert.deepEqual(
      peripherie.assujettis.map((row: { label: string; montant_emis: number; montant_recouvre: number }) => [row.label, row.montant_emis, row.montant_recouvre]),
      [
        ['Alpha Médias', 200, 100],
        ['Gamma Stores', 100, 0],
      ],
    );
  });
});

test('GET /api/rapports/recettes-geographiques exporte en PDF, archive et trace l’audit dédié', async () => {
  await withTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const pdf = await requestGeoReport(ctx, {
      path: '/api/rapports/recettes-geographiques?annee=2026&color_scale=taux_recouvrement&format=pdf',
      headers: makeAuthHeader(ctx, fx.financier),
    });

    assert.equal(pdf.status, 200);
    assert.match(pdf.contentType, /application\/pdf/);
    assert.match(pdf.disposition, /recettes-geographiques-2026\.pdf/);
    assert.equal(pdf.buffer.subarray(0, 4).toString('utf8'), '%PDF');

    const audit = ctx.db.prepare("SELECT action, entite, details FROM audit_log WHERE action = 'export-recettes-geographiques' ORDER BY id DESC LIMIT 1").get() as {
      action: string;
      entite: string;
      details: string;
    } | undefined;
    assert.ok(audit);
    assert.equal(audit?.entite, 'rapport');
    assert.match(audit?.details ?? '', /"color_scale":"taux_recouvrement"/);
    assert.match(audit?.details ?? '', /"format":"pdf"/);
    assert.match(audit?.details ?? '', /"archive_path":"rapports\/recettes_geographiques\/2026\//);

    const archive = ctx.db.prepare(
      `SELECT type_rapport, format, annee, filename, storage_path, content_hash, total_montant
       FROM rapports_exports
       WHERE type_rapport = 'recettes_geographiques'
       ORDER BY id DESC LIMIT 1`,
    ).get() as {
      type_rapport: string;
      format: string;
      annee: number;
      filename: string;
      storage_path: string;
      content_hash: string;
      total_montant: number;
    } | undefined;

    assert.ok(archive);
    assert.equal(archive?.type_rapport, 'recettes_geographiques');
    assert.equal(archive?.format, 'pdf');
    assert.equal(archive?.annee, 2026);
    assert.equal(archive?.filename, 'recettes-geographiques-2026.pdf');
    assert.match(archive?.storage_path ?? '', /rapports\/recettes_geographiques\/2026\//);
    assert.match(archive?.content_hash ?? '', /^[a-f0-9]{64}$/);
    assert.equal(archive?.total_montant, 1100);

    const storedAbsolutePath = ctx.resolveUploadAbsolutePath(archive!.storage_path);
    assert.equal(fs.existsSync(storedAbsolutePath), true);
  });
});

test('measureRecettesGeographiquesPdfLineHeight utilise la cellule la plus haute du contenu détaillé', async () => {
  await withTestContext(async (ctx) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    doc.fontSize(10);

    const compactHeight = ctx.measureRecettesGeographiquesPdfLineHeight(doc, 'Zone Centre', 180);
    const wrappedHeight = ctx.measureRecettesGeographiquesPdfLineHeight(
      doc,
      'Alpha Médias et Publicité Urbaine Grand Format — ventilation détaillée par assujetti, titre, montant émis, montant recouvré et reste à recouvrer pour forcer un retour à la ligne en PDF.',
      180,
    );

    assert.ok(wrappedHeight > compactHeight);
    doc.end();
  });
});

test('GET /api/rapports/recettes-geographiques nettoie l’archive si la persistance SQL échoue', async () => {
  await withTestContext(async (ctx) => {
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

    const archiveDir = path.join(process.cwd(), 'data', 'uploads', 'rapports', 'recettes_geographiques', '2026');
    fs.rmSync(archiveDir, { recursive: true, force: true });

    try {
      const res = await requestGeoReport(ctx, {
        path: '/api/rapports/recettes-geographiques?annee=2026&format=pdf',
        headers: makeAuthHeader(ctx, fx.financier),
      });

      assert.equal(res.status, 500);
      const archives = ctx.db.prepare(`SELECT storage_path FROM rapports_exports WHERE type_rapport = 'recettes_geographiques'`).all() as Array<{
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

test('GET /api/rapports/recettes-geographiques filtre l’accès aux rôles admin/financier', async () => {
  await withTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);
    const res = await requestGeoReport(ctx, {
      path: '/api/rapports/recettes-geographiques?annee=2026',
      headers: makeAuthHeader(ctx, fx.contribuable),
    });

    assert.equal(res.status, 403);
    assert.equal(res.json?.error, 'Droits insuffisants');
  });
});

test('GET /api/rapports/recettes-geographiques refuse une géométrie de zone invalide au lieu de tronquer les totaux', async () => {
  await withTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);
    ctx.db.prepare(`UPDATE zones SET geometry = ? WHERE code = 'ZC'`).run('{"type":"Point","coordinates":[2,48]}');

    const res = await requestGeoReport(ctx, {
      path: '/api/rapports/recettes-geographiques?annee=2026',
      headers: makeAuthHeader(ctx, fx.financier),
    });

    assert.equal(res.status, 500);
    assert.equal(res.json?.error, 'Erreur interne generation carte des recettes');
  });
});
