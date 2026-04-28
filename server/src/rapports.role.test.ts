import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import PDFDocument from 'pdfkit';
import XLSX from 'xlsx';
import type { AuthUser } from './auth';

type RoleTestContext = {
  db: typeof import('./db').db;
  initSchema: typeof import('./db').initSchema;
  hashPassword: typeof import('./auth').hashPassword;
  signToken: typeof import('./auth').signToken;
  rapportsRouter: typeof import('./routes/rapports').rapportsRouter;
  resolveUploadAbsolutePath: typeof import('./routes/piecesJointes').resolveUploadAbsolutePath;
  measureRoleReportRowHeight: typeof import('./routes/rapports').measureRoleReportRowHeight;
  cleanup: () => void;
};

const ROLE_TEST_MODULES = ['./db', './auth', './routes/piecesJointes', './routes/rapports'] as const;

function clearRoleTestModuleCache() {
  for (const modulePath of ROLE_TEST_MODULES) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // ignore cache misses during cleanup
    }
  }
}

function createRoleTestContext(): RoleTestContext {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlpe-rapports-role-test-'));
  const dbPath = path.join(tempDir, 'tlpe.db');
  const previousDbPath = process.env.TLPE_DB_PATH;
  process.env.TLPE_DB_PATH = dbPath;
  clearRoleTestModuleCache();

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
    measureRoleReportRowHeight: rapportsModule.measureRoleReportRowHeight,
    cleanup: () => {
      try {
        dbModule.db.close();
      } catch {
        // ignore close errors during teardown
      }
      clearRoleTestModuleCache();
      if (previousDbPath === undefined) {
        delete process.env.TLPE_DB_PATH;
      } else {
        process.env.TLPE_DB_PATH = previousDbPath;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function withRoleTestContext(run: (ctx: RoleTestContext) => Promise<void> | void) {
  const ctx = createRoleTestContext();
  try {
    await run(ctx);
  } finally {
    ctx.cleanup();
  }
}

function createApp(ctx: RoleTestContext) {
  const app = express();
  app.use(express.json());
  app.use('/api/rapports', ctx.rapportsRouter);
  return app;
}

function makeAuthHeader(ctx: RoleTestContext, user: AuthUser): Record<string, string> {
  return { Authorization: `Bearer ${ctx.signToken(user)}` };
}

async function requestBinary(
  ctx: RoleTestContext,
  params: {
    method: 'GET';
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
      method: params.method,
      headers: params.headers,
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      headers: {
        contentType: res.headers.get('content-type') || '',
        disposition: res.headers.get('content-disposition') || '',
      },
      buffer,
    };
  } finally {
    server.close();
  }
}

function resetFixtures(ctx: RoleTestContext) {
  ctx.initSchema();
  ctx.db.exec('DELETE FROM rapports_exports');
  ctx.db.exec('DELETE FROM declaration_receipts');
  ctx.db.exec('DELETE FROM notifications_email');
  ctx.db.exec('DELETE FROM invitation_magic_links');
  ctx.db.exec('DELETE FROM campagne_jobs');
  ctx.db.exec('DELETE FROM mises_en_demeure');
  ctx.db.exec('DELETE FROM paiements');
  ctx.db.exec('DELETE FROM titres');
  ctx.db.exec('DELETE FROM pieces_jointes');
  ctx.db.exec('DELETE FROM contentieux');
  ctx.db.exec('DELETE FROM lignes_declaration');
  ctx.db.exec('DELETE FROM declarations');
  ctx.db.exec('DELETE FROM controles');
  ctx.db.exec('DELETE FROM dispositifs');
  ctx.db.exec('DELETE FROM campagnes');
  ctx.db.exec('DELETE FROM audit_log');
  ctx.db.exec('DELETE FROM users');
  ctx.db.exec('DELETE FROM assujettis');
  ctx.db.exec('DELETE FROM types_dispositifs');

  const typeId = Number(
    ctx.db
      .prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('ENS-ROLE', 'Enseigne Role', 'enseigne')`)
      .run().lastInsertRowid,
  );
  const assujettiA = Number(
    ctx.db
      .prepare(
        `INSERT INTO assujettis (
          identifiant_tlpe, raison_sociale, siret, adresse_rue, adresse_cp, adresse_ville, statut
        ) VALUES ('TLPE-R-001', 'Alpha Publicite', '12345678901234', '1 rue Alpha', '33000', 'Bordeaux', 'actif')`,
      )
      .run().lastInsertRowid,
  );
  const assujettiB = Number(
    ctx.db
      .prepare(
        `INSERT INTO assujettis (
          identifiant_tlpe, raison_sociale, siret, adresse_rue, adresse_cp, adresse_ville, statut
        ) VALUES ('TLPE-R-002', 'Beta Enseignes', '10987654321098', '2 avenue Beta', '33100', 'Bordeaux', 'actif')`,
      )
      .run().lastInsertRowid,
  );
  const financierId = Number(
    ctx.db
      .prepare(
        `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
         VALUES ('financier-role@tlpe.local', ?, 'Fin', 'Ancier', 'financier', 1)`,
      )
      .run(ctx.hashPassword('x')).lastInsertRowid,
  );
  const contribuableId = Number(
    ctx.db
      .prepare(
        `INSERT INTO users (email, password_hash, nom, prenom, role, assujetti_id, actif)
         VALUES ('contrib-role@tlpe.local', ?, 'Contrib', 'Uable', 'contribuable', ?, 1)`,
      )
      .run(ctx.hashPassword('x'), assujettiA).lastInsertRowid,
  );

  const declarationA = Number(
    ctx.db
      .prepare(
        `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
         VALUES ('DEC-ROLE-2026-001', ?, 2026, 'validee', 1200)`,
      )
      .run(assujettiA).lastInsertRowid,
  );
  const declarationB = Number(
    ctx.db
      .prepare(
        `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
         VALUES ('DEC-ROLE-2026-002', ?, 2026, 'validee', 450.5)`,
      )
      .run(assujettiB).lastInsertRowid,
  );

  const dispositifA1 = Number(
    ctx.db
      .prepare(
        `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, adresse_rue, adresse_cp, adresse_ville, statut)
         VALUES ('DSP-ROLE-001', ?, ?, 12, 1, '1 rue Alpha', '33000', 'Bordeaux', 'declare')`,
      )
      .run(assujettiA, typeId).lastInsertRowid,
  );
  const dispositifA2 = Number(
    ctx.db
      .prepare(
        `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, adresse_rue, adresse_cp, adresse_ville, statut)
         VALUES ('DSP-ROLE-002', ?, ?, 6, 1, '1 rue Alpha', '33000', 'Bordeaux', 'controle')`,
      )
      .run(assujettiA, typeId).lastInsertRowid,
  );
  const dispositifB1 = Number(
    ctx.db
      .prepare(
        `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, adresse_rue, adresse_cp, adresse_ville, statut)
         VALUES ('DSP-ROLE-003', ?, ?, 4.5, 2, '2 avenue Beta', '33100', 'Bordeaux', 'declare')`,
      )
      .run(assujettiB, typeId).lastInsertRowid,
  );

  ctx.db
    .prepare(
      `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne)
       VALUES (?, ?, 12, 1, '2026-01-01', 800)`,
    )
    .run(declarationA, dispositifA1);
  ctx.db
    .prepare(
      `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne)
       VALUES (?, ?, 6, 1, '2026-01-15', 400)`,
    )
    .run(declarationA, dispositifA2);
  ctx.db
    .prepare(
      `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne)
       VALUES (?, ?, 4.5, 2, '2026-02-01', 450.5)`,
    )
    .run(declarationB, dispositifB1);

  const titreA = Number(
    ctx.db
      .prepare(
        `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, montant_paye, date_emission, date_echeance, statut)
         VALUES ('TIT-2026-000010', ?, ?, 2026, 1200, 300, '2026-04-01', '2026-08-31', 'paye_partiel')`,
      )
      .run(declarationA, assujettiA).lastInsertRowid,
  );
  ctx.db
    .prepare(
      `INSERT INTO paiements (titre_id, montant, date_paiement, modalite, provider, statut, reference)
       VALUES (?, 300, '2026-05-10', 'virement', 'manuel', 'confirme', 'PAY-ROLE-1')`,
    )
    .run(titreA);
  ctx.db
    .prepare(
      `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, montant_paye, date_emission, date_echeance, statut)
       VALUES ('TIT-2026-000011', ?, ?, 2026, 450.5, 0, '2026-04-05', '2026-08-31', 'emis')`,
    )
    .run(declarationB, assujettiB);

  return {
    financier: {
      id: financierId,
      email: 'financier-role@tlpe.local',
      role: 'financier' as const,
      nom: 'Fin',
      prenom: 'Ancier',
      assujetti_id: null,
    },
    contribuable: {
      id: contribuableId,
      email: 'contrib-role@tlpe.local',
      role: 'contribuable' as const,
      nom: 'Contrib',
      prenom: 'Uable',
      assujetti_id: assujettiA,
    },
  };
}

test('measureRoleReportRowHeight utilise la cellule la plus haute quand une colonne retourne à la ligne', async () => {
  await withRoleTestContext((ctx) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    doc.fontSize(8);

    const compactHeight = ctx.measureRoleReportRowHeight(doc, {
      titre_id: 1,
      numero_titre: 'TIT-2026-1',
      assujetti_id: 1,
      debiteur: 'Alpha',
      siret: '12345678901234',
      adresse: '1 rue Alpha',
      dispositifs: 'DSP-1',
      montant: 10,
      statut_titre: 'Emis',
    });
    const wrappedHeight = ctx.measureRoleReportRowHeight(doc, {
      titre_id: 2,
      numero_titre: 'TIT-2026-2',
      assujetti_id: 2,
      debiteur: 'Beta Enseignes et Publicite Urbaine',
      siret: '10987654321098',
      adresse: '2 avenue Beta, 33100 Bordeaux, Batiment A, Escalier Nord',
      dispositifs:
        'DSP-ROLE-001 (enseigne murale grand format) | DSP-ROLE-002 (mobilier urbain lumineux double face) | DSP-ROLE-003 (preenseigne numerique partagee)',
      montant: 450.5,
      statut_titre: 'Paye partiel',
    });

    assert.ok(wrappedHeight > compactHeight);
    doc.end();
  });
});

test('GET /api/rapports/role?annee=2026&format=xlsx exporte le role TLPE detaille et archive chaque generation', async () => {
  await withRoleTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const first = await requestBinary(ctx, {
      method: 'GET',
      path: '/api/rapports/role?annee=2026&format=xlsx',
      headers: makeAuthHeader(ctx, fx.financier),
    });
    const second = await requestBinary(ctx, {
      method: 'GET',
      path: '/api/rapports/role?annee=2026&format=xlsx',
      headers: makeAuthHeader(ctx, fx.financier),
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.match(first.headers.contentType, /application\/vnd.openxmlformats-officedocument.spreadsheetml.sheet/);
    assert.match(first.headers.disposition, /role-tlpe-2026\.xlsx/);

    const workbook = XLSX.read(first.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }) as Array<Array<string | number>>;

    assert.equal(String(rows[0][0]), 'Rôle de la TLPE');
    assert.equal(String(rows[1][1]), '2026');
    assert.equal(String(rows[5][0]), 'N° titre');
    assert.equal(String(rows[5][1]), 'Débiteur');
    assert.equal(String(rows[5][2]), 'SIRET');
    assert.equal(String(rows[5][3]), 'Adresse');
    assert.equal(String(rows[5][4]), 'Dispositifs');
    assert.equal(String(rows[5][5]), 'Montant');
    assert.equal(String(rows[5][6]), 'Statut paiement');
    assert.equal(String(rows[6][0]), 'TIT-2026-000010');
    assert.match(String(rows[6][4]), /DSP-ROLE-001/);
    assert.match(String(rows[6][4]), /DSP-ROLE-002/);
    assert.equal(Number(rows[8][5]), 1650.5);
    assert.equal(String(rows[11][0]), 'Signature ordonnateur');

    const audit = ctx.db.prepare("SELECT action, entite, details FROM audit_log WHERE action = 'export-role-tlpe' ORDER BY id DESC LIMIT 1").get() as
      | { action: string; entite: string; details: string }
      | undefined;
    assert.ok(audit);
    assert.equal(audit!.entite, 'rapport');
    assert.match(audit!.details, /\"annee\":2026/);
    assert.match(audit!.details, /\"format\":\"xlsx\"/);

    const archives = ctx.db.prepare(
      `SELECT format, annee, filename, storage_path, content_hash, titres_count, total_montant
       FROM rapports_exports
       WHERE type_rapport = 'role_tlpe'
       ORDER BY id`,
    ).all() as Array<{
      format: string;
      annee: number;
      filename: string;
      storage_path: string;
      content_hash: string;
      titres_count: number;
      total_montant: number;
    }>;
    assert.equal(archives.length, 2);
    assert.equal(archives[0].annee, 2026);
    assert.equal(archives[0].format, 'xlsx');
    assert.match(archives[0].filename, /^role-tlpe-2026\.xlsx$/);
    assert.match(archives[0].storage_path, /rapports\/role_tlpe\/2026\//);
    assert.match(archives[0].content_hash, /^[a-f0-9]{64}$/);
    assert.equal(archives[0].titres_count, 2);
    assert.equal(archives[0].total_montant, 1650.5);
  });
});

test('GET /api/rapports/role?annee=2026&format=pdf retourne un PDF et refuse le role contribuable', async () => {
  await withRoleTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const forbidden = await requestBinary(ctx, {
      method: 'GET',
      path: '/api/rapports/role?annee=2026&format=pdf',
      headers: makeAuthHeader(ctx, fx.contribuable),
    });
    assert.equal(forbidden.status, 403);

    const res = await requestBinary(ctx, {
      method: 'GET',
      path: '/api/rapports/role?annee=2026&format=pdf',
      headers: makeAuthHeader(ctx, fx.financier),
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.contentType, /application\/pdf/);
    assert.match(res.headers.disposition, /role-tlpe-2026\.pdf/);
    assert.equal(res.buffer.subarray(0, 4).toString('utf8'), '%PDF');
  });
});

test('GET /api/rapports/role nettoie le fichier archivé si la persistance SQL échoue', async () => {
  await withRoleTestContext(async (ctx) => {
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

    const roleDir = ctx.resolveUploadAbsolutePath('rapports/role_tlpe/2026');
    fs.rmSync(roleDir, { recursive: true, force: true });

    try {
      const res = await requestBinary(ctx, {
        method: 'GET',
        path: '/api/rapports/role?annee=2026&format=pdf',
        headers: makeAuthHeader(ctx, fx.financier),
      });

      assert.equal(res.status, 500);
      const archives = ctx.db.prepare(`SELECT storage_path FROM rapports_exports WHERE type_rapport = 'role_tlpe'`).all() as Array<{
        storage_path: string;
      }>;
      assert.equal(archives.length, 0);

      const remainingFiles = fs.existsSync(roleDir) ? fs.readdirSync(roleDir) : [];
      assert.equal(remainingFiles.length, 0);
    } finally {
      // @ts-ignore restore monkey patch after fault injection
      ctx.db.prepare = previousPrepare;
    }
  });
});

test('GET /api/rapports/role valide les paramètres requis', async () => {
  await withRoleTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const missingYear = await requestBinary(ctx, {
      method: 'GET',
      path: '/api/rapports/role?format=pdf',
      headers: makeAuthHeader(ctx, fx.financier),
    });
    assert.equal(missingYear.status, 400);

    const invalidFormat = await requestBinary(ctx, {
      method: 'GET',
      path: '/api/rapports/role?annee=2026&format=csv',
      headers: makeAuthHeader(ctx, fx.financier),
    });
    assert.equal(invalidFormat.status, 400);
  });
});
