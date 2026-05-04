import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import XLSX from 'xlsx';
import type { AuthUser } from './auth';

type RelancesTestContext = {
  db: typeof import('./db').db;
  initSchema: typeof import('./db').initSchema;
  hashPassword: typeof import('./auth').hashPassword;
  signToken: typeof import('./auth').signToken;
  rapportsRouter: typeof import('./routes/rapports').rapportsRouter;
  resolveUploadAbsolutePath: typeof import('./routes/piecesJointes').resolveUploadAbsolutePath;
  cleanup: () => void;
};

const RELANCES_TEST_MODULES = ['./db', './auth', './routes/piecesJointes', './routes/rapports'] as const;

function clearRelancesTestModuleCache() {
  for (const modulePath of RELANCES_TEST_MODULES) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // ignore cache misses during cleanup
    }
  }
}

function createRelancesTestContext(): RelancesTestContext {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlpe-rapports-relances-test-'));
  const dbPath = path.join(tempDir, 'tlpe.db');
  const previousDbPath = process.env.TLPE_DB_PATH;
  process.env.TLPE_DB_PATH = dbPath;
  clearRelancesTestModuleCache();

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
      clearRelancesTestModuleCache();
      if (previousDbPath === undefined) {
        delete process.env.TLPE_DB_PATH;
      } else {
        process.env.TLPE_DB_PATH = previousDbPath;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function withRelancesTestContext(run: (ctx: RelancesTestContext) => Promise<void> | void) {
  const ctx = createRelancesTestContext();
  try {
    await run(ctx);
  } finally {
    ctx.cleanup();
  }
}

function createApp(ctx: RelancesTestContext) {
  const app = express();
  app.use(express.json());
  app.use('/api/rapports', ctx.rapportsRouter);
  return app;
}

function makeAuthHeader(ctx: RelancesTestContext, user: AuthUser): Record<string, string> {
  return { Authorization: `Bearer ${ctx.signToken(user)}` };
}

async function requestReport(
  ctx: RelancesTestContext,
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

function resetFixtures(ctx: RelancesTestContext) {
  ctx.initSchema();
  ctx.db.pragma('foreign_keys = OFF');
  try {
    ctx.db.exec('DELETE FROM rapports_exports');
    ctx.db.exec('DELETE FROM recouvrement_actions');
    ctx.db.exec('DELETE FROM paiements');
    ctx.db.exec('DELETE FROM titres');
    ctx.db.exec('DELETE FROM declaration_receipts');
    ctx.db.exec('DELETE FROM notifications_email');
    ctx.db.exec('DELETE FROM invitation_magic_links');
    ctx.db.exec('DELETE FROM campagne_jobs');
    ctx.db.exec('DELETE FROM mises_en_demeure');
    ctx.db.exec('DELETE FROM lignes_declaration');
    ctx.db.exec('DELETE FROM declarations');
    ctx.db.exec('DELETE FROM contentieux');
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

  const gestionnaireId = Number(
    ctx.db
      .prepare(
        `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
         VALUES ('gestionnaire-relances@tlpe.local', ?, 'Gest', 'Ionnaire', 'gestionnaire', 1)`,
      )
      .run(ctx.hashPassword('x')).lastInsertRowid,
  );
  const financierId = Number(
    ctx.db
      .prepare(
        `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
         VALUES ('financier-relances@tlpe.local', ?, 'Fin', 'Ancier', 'financier', 1)`,
      )
      .run(ctx.hashPassword('x')).lastInsertRowid,
  );
  const contribuableId = Number(
    ctx.db
      .prepare(
        `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, statut)
         VALUES ('TLPE-REL-003', 'Gamma Stores', 'gamma@example.fr', 'actif')`,
      )
      .run().lastInsertRowid,
  );
  const contribuableUserId = Number(
    ctx.db
      .prepare(
        `INSERT INTO users (email, password_hash, nom, prenom, role, assujetti_id, actif)
         VALUES ('contrib-relances@tlpe.local', ?, 'Contrib', 'Uable', 'contribuable', ?, 1)`,
      )
      .run(ctx.hashPassword('x'), contribuableId).lastInsertRowid,
  );

  const alphaId = Number(
    ctx.db
      .prepare(
        `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, statut)
         VALUES ('TLPE-REL-001', 'Alpha Affichage', 'alpha@example.fr', 'actif')`,
      )
      .run().lastInsertRowid,
  );
  const betaId = Number(
    ctx.db
      .prepare(
        `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, statut)
         VALUES ('TLPE-REL-002', 'Beta Enseignes', 'beta@example.fr', 'actif')`,
      )
      .run().lastInsertRowid,
  );

  const typeId = Number(
    ctx.db
      .prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('ENS-REL', 'Enseigne relances', 'enseigne')`)
      .run().lastInsertRowid,
  );
  const alphaDispositifId = Number(
    ctx.db
      .prepare(
        `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, statut)
         VALUES ('DSP-REL-001', ?, ?, 10, 1, 'declare')`,
      )
      .run(alphaId, typeId).lastInsertRowid,
  );
  const betaDispositifId = Number(
    ctx.db
      .prepare(
        `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, statut)
         VALUES ('DSP-REL-002', ?, ?, 8, 1, 'declare')`,
      )
      .run(betaId, typeId).lastInsertRowid,
  );
  const gammaDispositifId = Number(
    ctx.db
      .prepare(
        `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, statut)
         VALUES ('DSP-REL-003', ?, ?, 6, 1, 'declare')`,
      )
      .run(contribuableId, typeId).lastInsertRowid,
  );

  const campagneId = Number(
    ctx.db
      .prepare(
        `INSERT INTO campagnes (annee, date_ouverture, date_limite_declaration, date_cloture, statut, relance_j7_courrier, created_by)
         VALUES (2026, '2026-01-01', '2026-03-31', '2026-04-01', 'cloturee', 1, ?)`,
      )
      .run(gestionnaireId).lastInsertRowid,
  );

  const alphaDeclarationId = Number(
    ctx.db
      .prepare(
        `INSERT INTO declarations (numero, assujetti_id, annee, statut, date_soumission, montant_total)
         VALUES ('DEC-REL-001', ?, 2026, 'soumise', '2026-03-12 10:00:00', 120)`,
      )
      .run(alphaId).lastInsertRowid,
  );
  ctx.db
    .prepare(
      `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne)
       VALUES (?, ?, 10, 1, '2026-01-10', 120)`,
    )
    .run(alphaDeclarationId, alphaDispositifId);

  const betaDeclarationId = Number(
    ctx.db
      .prepare(
        `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
         VALUES ('DEC-REL-002', ?, 2026, 'en_instruction', 220)`,
      )
      .run(betaId).lastInsertRowid,
  );
  ctx.db
    .prepare(
      `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne)
       VALUES (?, ?, 8, 1, '2026-01-15', 220)`,
    )
    .run(betaDeclarationId, betaDispositifId);

  const gammaDeclarationId = Number(
    ctx.db
      .prepare(
        `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
         VALUES ('DEC-REL-003', ?, 2026, 'validee', 400)`,
      )
      .run(contribuableId).lastInsertRowid,
  );
  ctx.db
    .prepare(
      `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, montant_ligne)
       VALUES (?, ?, 6, 1, '2026-01-20', 400)`,
    )
    .run(gammaDeclarationId, gammaDispositifId);

  ctx.db
    .prepare(
      `INSERT INTO notifications_email (
        campagne_id, assujetti_id, email_destinataire, objet, corps, template_code,
        relance_niveau, piece_jointe_path, mode, statut, erreur, sent_at, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, 'relance_declaration', 'J-15', NULL, 'auto', 'envoye', NULL, '2026-03-10 08:00:00', ?, '2026-03-10 08:00:00')`,
    )
    .run(campagneId, alphaId, 'alpha@example.fr', 'Relance TLPE 2026', 'Merci de déclarer.', gestionnaireId);
  ctx.db
    .prepare(
      `INSERT INTO notifications_email (
        campagne_id, assujetti_id, email_destinataire, objet, corps, template_code,
        relance_niveau, piece_jointe_path, mode, statut, erreur, sent_at, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, 'mise_en_demeure_auto', NULL, 'courriers/beta.pdf', 'auto', 'envoye', NULL, '2026-04-02 09:00:00', ?, '2026-04-02 09:00:00')`,
    )
    .run(campagneId, betaId, 'beta@example.fr', 'Mise en demeure TLPE 2026', 'Veuillez régulariser.', gestionnaireId);
  ctx.db
    .prepare(
      `INSERT INTO notifications_email (
        campagne_id, assujetti_id, email_destinataire, objet, corps, template_code,
        relance_niveau, piece_jointe_path, mode, statut, erreur, sent_at, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, 'relance_declaration', 'J-7', NULL, 'auto', 'echec', 'SMTP indisponible', NULL, ?, '2026-03-24 09:30:00')`,
    )
    .run(campagneId, betaId, 'beta@example.fr', 'Relance TLPE 2026', 'Dernière relance.', gestionnaireId);

  const gammaTitreId = Number(
    ctx.db
      .prepare(
        `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, montant_paye, date_emission, date_echeance, statut)
         VALUES ('TIT-REL-001', ?, ?, 2026, 400, 0, '2026-06-01', '2026-08-31', 'paye_partiel')`,
      )
      .run(gammaDeclarationId, contribuableId).lastInsertRowid,
  );
  ctx.db
    .prepare(
      `INSERT INTO recouvrement_actions (
        titre_id, niveau, action_type, statut, email_destinataire, piece_jointe_path, details, created_by, created_at
      ) VALUES (?, 'J+10', 'rappel_email', 'envoye', 'gamma@example.fr', NULL, '{"run_date":"2026-09-10"}', ?, '2026-09-10 07:45:00')`,
    )
    .run(gammaTitreId, financierId);
  ctx.db
    .prepare(
      `INSERT INTO paiements (titre_id, montant, date_paiement, modalite, provider, statut, reference)
       VALUES (?, 150, '2026-09-15', 'virement', 'manuel', 'confirme', 'PAY-REL-001')`,
    )
    .run(gammaTitreId);
  ctx.db.prepare(`UPDATE titres SET montant_paye = 150, statut = 'paye_partiel' WHERE id = ?`).run(gammaTitreId);

  const betaTitreId = Number(
    ctx.db
      .prepare(
        `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, montant_paye, date_emission, date_echeance, statut)
         VALUES ('TIT-REL-002', ?, ?, 2026, 220, 0, '2026-06-01', '2026-08-01', 'mise_en_demeure')`,
      )
      .run(betaDeclarationId, betaId).lastInsertRowid,
  );
  ctx.db
    .prepare(
      `INSERT INTO recouvrement_actions (
        titre_id, niveau, action_type, statut, email_destinataire, piece_jointe_path, details, created_by, created_at
      ) VALUES (?, 'J+30', 'mise_en_demeure', 'echec', NULL, 'mises_en_demeure/impayes/beta.pdf', '{"commentaire":"Mise en demeure automatique J+30"}', ?, '2026-09-30 11:00:00')`,
    )
    .run(betaTitreId, financierId);

  return {
    gestionnaire: {
      id: gestionnaireId,
      email: 'gestionnaire-relances@tlpe.local',
      role: 'gestionnaire' as const,
      nom: 'Gest',
      prenom: 'Ionnaire',
      assujetti_id: null,
    },
    financier: {
      id: financierId,
      email: 'financier-relances@tlpe.local',
      role: 'financier' as const,
      nom: 'Fin',
      prenom: 'Ancier',
      assujetti_id: null,
    },
    contribuable: {
      id: contribuableUserId,
      email: 'contrib-relances@tlpe.local',
      role: 'contribuable' as const,
      nom: 'Contrib',
      prenom: 'Uable',
      assujetti_id: contribuableId,
    },
  };
}

test('GET /api/rapports/relances retourne les indicateurs, la réponse métier et les filtres', async () => {
  await withRelancesTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const res = await requestReport(ctx, {
      path: '/api/rapports/relances?date_debut=2026-03-01&date_fin=2026-09-30',
      headers: makeAuthHeader(ctx, fx.gestionnaire),
    });

    assert.equal(res.status, 200);
    assert.match(res.contentType, /application\/json/);
    assert.equal(res.json?.filters.date_debut, '2026-03-01');
    assert.equal(res.json?.filters.date_fin, '2026-09-30');
    assert.equal(res.json?.indicators.total, 5);
    assert.equal(res.json?.indicators.envoyees, 3);
    assert.equal(res.json?.indicators.echecs, 2);
    assert.equal(res.json?.indicators.regularisees, 2);
    assert.equal(res.json?.indicators.taux_regularisation, 0.6667);
    assert.equal(res.json?.indicators.canal_email, 3);
    assert.equal(res.json?.indicators.canal_courrier, 2);

    assert.deepEqual(
      res.json?.rows.map((row: { type_code: string; destinataire: string; canal: string; statut: string; reponse_label: string }) => [
        row.type_code,
        row.destinataire,
        row.canal,
        row.statut,
        row.reponse_label,
      ]),
      [
        ['mise_en_demeure_impaye', 'Beta Enseignes', 'courrier', 'echec', 'Aucune réponse'],
        ['relance_impaye', 'Gamma Stores', 'email', 'envoye', 'Paiement partiel'],
        ['mise_en_demeure_declaration', 'Beta Enseignes', 'courrier', 'envoye', 'Aucune réponse'],
        ['relance_declaration', 'Beta Enseignes', 'email', 'echec', 'Aucune réponse'],
        ['relance_declaration', 'Alpha Affichage', 'email', 'envoye', 'Déclaration reçue'],
      ],
    );

    const filtered = await requestReport(ctx, {
      path: '/api/rapports/relances?date_debut=2026-09-01&date_fin=2026-09-30&type=mise_en_demeure_impaye&statut=echec',
      headers: makeAuthHeader(ctx, fx.gestionnaire),
    });

    assert.equal(filtered.status, 200);
    assert.equal(filtered.json?.rows.length, 1);
    assert.equal(filtered.json?.rows[0].type_code, 'mise_en_demeure_impaye');
    assert.equal(filtered.json?.rows[0].statut, 'echec');
  });
});

test('GET /api/rapports/relances exporte en XLSX et PDF, archive et trace l’audit', async () => {
  await withRelancesTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const xlsx = await requestReport(ctx, {
      path: '/api/rapports/relances?date_debut=2026-03-01&date_fin=2026-09-30&format=xlsx',
      headers: makeAuthHeader(ctx, fx.gestionnaire),
    });
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.contentType, /application\/vnd.openxmlformats-officedocument.spreadsheetml.sheet/);
    assert.match(xlsx.disposition, /suivi-relances-2026-03-01_2026-09-30\.xlsx/);

    const workbook = XLSX.read(xlsx.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: false }) as Array<Array<string | number>>;
    assert.equal(String(rows[0][0]), 'Suivi des relances et mises en demeure');
    assert.equal(String(rows[1][1]), '2026-03-01');
    assert.equal(String(rows[2][1]), '2026-09-30');
    assert.equal(String(rows[8][0]), 'Date');
    assert.equal(String(rows[9][2]), 'Mise en demeure impayé');

    const pdf = await requestReport(ctx, {
      path: '/api/rapports/relances?date_debut=2026-03-01&date_fin=2026-09-30&type=relance_declaration&format=pdf',
      headers: makeAuthHeader(ctx, fx.gestionnaire),
    });
    assert.equal(pdf.status, 200);
    assert.match(pdf.contentType, /application\/pdf/);
    assert.match(pdf.disposition, /suivi-relances-2026-03-01_2026-09-30\.pdf/);
    assert.equal(pdf.buffer.subarray(0, 4).toString('utf8'), '%PDF');

    const audits = ctx.db
      .prepare(`SELECT action, entite, details FROM audit_log WHERE action = 'export-suivi-relances' ORDER BY id`)
      .all() as Array<{ action: string; entite: string; details: string }>;
    assert.equal(audits.length, 2);
    assert.equal(audits[0].entite, 'rapport');
    assert.match(audits[0].details, /"format":"xlsx"/);
    assert.match(audits[1].details, /"type":"relance_declaration"/);

    const archives = ctx.db
      .prepare(
        `SELECT type_rapport, format, filename, storage_path, annee, titres_count, total_montant
         FROM rapports_exports
         WHERE type_rapport = 'suivi_relances'
         ORDER BY id`,
      )
      .all() as Array<{
      type_rapport: string;
      format: string;
      filename: string;
      storage_path: string;
      annee: number;
      titres_count: number;
      total_montant: number;
    }>;
    assert.equal(archives.length, 2);
    assert.equal(archives[0].type_rapport, 'suivi_relances');
    assert.equal(archives[0].annee, 2026);
    assert.equal(archives[0].titres_count, 5);
    assert.equal(archives[0].total_montant, 3);
    assert.match(archives[0].storage_path, /rapports\/suivi_relances\/2026\//);
  });
});

test('GET /api/rapports/relances exporte aussi un PDF vide quand aucun évènement ne correspond aux filtres', async () => {
  await withRelancesTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const res = await requestReport(ctx, {
      path: '/api/rapports/relances?date_debut=2025-01-01&date_fin=2025-01-31&format=pdf',
      headers: makeAuthHeader(ctx, fx.gestionnaire),
    });

    assert.equal(res.status, 200);
    assert.match(res.contentType, /application\/pdf/);
    assert.match(res.disposition, /suivi-relances-2025-01-01_2025-01-31\.pdf/);
    assert.equal(res.buffer.subarray(0, 4).toString('utf8'), '%PDF');

    const archive = ctx.db.prepare(
      `SELECT annee, titres_count, total_montant FROM rapports_exports WHERE type_rapport = 'suivi_relances' ORDER BY id DESC LIMIT 1`,
    ).get() as { annee: number; titres_count: number; total_montant: number } | undefined;
    assert.ok(archive);
    assert.equal(archive?.annee, 2025);
    assert.equal(archive?.titres_count, 0);
    assert.equal(archive?.total_montant, 0);
  });
});

test('GET /api/rapports/relances nettoie le fichier archivé si la persistance SQL échoue', async () => {
  await withRelancesTestContext(async (ctx) => {
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

    const archiveDir = ctx.resolveUploadAbsolutePath('rapports/suivi_relances/2026');
    fs.rmSync(archiveDir, { recursive: true, force: true });

    try {
      const res = await requestReport(ctx, {
        path: '/api/rapports/relances?date_debut=2026-03-01&date_fin=2026-09-30&format=pdf',
        headers: makeAuthHeader(ctx, fx.gestionnaire),
      });

      assert.equal(res.status, 500);
      const archives = ctx.db.prepare(`SELECT storage_path FROM rapports_exports WHERE type_rapport = 'suivi_relances'`).all() as Array<{
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

test('GET /api/rapports/relances refuse les rôles non autorisés et valide les paramètres', async () => {
  await withRelancesTestContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const forbidden = await requestReport(ctx, {
      path: '/api/rapports/relances?date_debut=2026-03-01&date_fin=2026-09-30',
      headers: makeAuthHeader(ctx, fx.contribuable),
    });
    assert.equal(forbidden.status, 403);

    const invalid = await requestReport(ctx, {
      path: '/api/rapports/relances?date_debut=2026-03-40&date_fin=foo&type=unknown',
      headers: makeAuthHeader(ctx, fx.gestionnaire),
    });
    assert.equal(invalid.status, 400);

    const financierForbidden = await requestReport(ctx, {
      path: '/api/rapports/relances?date_debut=2026-03-01&date_fin=2026-09-30',
      headers: makeAuthHeader(ctx, fx.financier),
    });
    assert.equal(financierForbidden.status, 403);
  });
});
