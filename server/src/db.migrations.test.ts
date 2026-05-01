import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type DbMigrationsContext = {
  db: typeof import('./db').db;
  initSchema: typeof import('./db').initSchema;
  cleanup: () => void;
};

const TEST_MODULES = ['./db'] as const;

function clearModuleCache() {
  for (const modulePath of TEST_MODULES) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // ignore cache misses during cleanup
    }
  }
}

function createContext(): DbMigrationsContext {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlpe-db-migrations-test-'));
  const dbPath = path.join(tempDir, 'tlpe.db');
  const previousDbPath = process.env.TLPE_DB_PATH;
  process.env.TLPE_DB_PATH = dbPath;
  clearModuleCache();

  const dbModule = require('./db') as typeof import('./db');

  return {
    db: dbModule.db,
    initSchema: dbModule.initSchema,
    cleanup: () => {
      try {
        dbModule.db.close();
      } catch {
        // ignore close errors during teardown
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

async function withContext(run: (ctx: DbMigrationsContext) => Promise<void> | void) {
  const ctx = createContext();
  try {
    await run(ctx);
  } finally {
    ctx.cleanup();
  }
}

function getCreateTableSql(ctx: DbMigrationsContext, tableName: string) {
  return (
    ctx.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
      | { sql: string }
      | undefined
  )?.sql;
}

function getIndexNames(ctx: DbMigrationsContext, tableName: string) {
  return new Set(
    (ctx.db.prepare(`PRAGMA index_list('${tableName}')`).all() as Array<{ name: string }>).map((row) => row.name),
  );
}

function seedUser(ctx: DbMigrationsContext, params?: { email?: string; role?: string }) {
  return Number(
    ctx.db
      .prepare(
        `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
         VALUES (?, 'hash', 'Test', 'User', ?, 1)`,
      )
      .run(params?.email ?? 'user-db-migration@tlpe.local', params?.role ?? 'admin').lastInsertRowid,
  );
}

function seedAssujetti(ctx: DbMigrationsContext, code = 'TLPE-DB-MIG-001') {
  return Number(
    ctx.db
      .prepare(
        `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, statut)
         VALUES (?, ?, ?, 'actif')`,
      )
      .run(code, `Assujetti ${code}`, `${code.toLowerCase()}@example.test`).lastInsertRowid,
  );
}

function seedCampagne(ctx: DbMigrationsContext, createdBy: number, annee = 2036) {
  return Number(
    ctx.db
      .prepare(
        `INSERT INTO campagnes (annee, date_ouverture, date_limite_declaration, date_cloture, statut, created_by)
         VALUES (?, ?, ?, ?, 'brouillon', ?)`,
      )
      .run(annee, `${annee}-01-01`, `${annee}-03-01`, `${annee}-03-10`, createdBy).lastInsertRowid,
  );
}

function seedDeclaration(ctx: DbMigrationsContext, assujettiId: number, annee = 2036) {
  return Number(
    ctx.db
      .prepare(
        `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
         VALUES (?, ?, ?, 'validee', 120)`,
      )
      .run(`DEC-${annee}-000001`, assujettiId, annee).lastInsertRowid,
  );
}

function seedTitre(ctx: DbMigrationsContext, declarationId: number, assujettiId: number, annee = 2036) {
  return Number(
    ctx.db
      .prepare(
        `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut, montant_paye)
         VALUES (?, ?, ?, ?, 120, ?, ?, 'emis', 0)`,
      )
      .run(`TIT-${annee}-000001`, declarationId, assujettiId, annee, `${annee}-04-01`, `${annee}-05-01`).lastInsertRowid,
  );
}

test('initSchema migre notifications_email legacy et rend campagne_id nullable', async () => {
  await withContext((ctx) => {
    ctx.initSchema();
    const userId = seedUser(ctx);
    const assujettiId = seedAssujetti(ctx);
    const campagneId = seedCampagne(ctx, userId);

    ctx.db.pragma('foreign_keys = OFF');
    ctx.db.exec('BEGIN TRANSACTION');
    try {
      ctx.db.exec(`
        CREATE TABLE notifications_email_legacy (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          campagne_id         INTEGER NOT NULL,
          assujetti_id        INTEGER NOT NULL,
          email_destinataire  TEXT NOT NULL,
          objet               TEXT NOT NULL,
          corps               TEXT NOT NULL,
          template_code       TEXT NOT NULL DEFAULT 'invitation_campagne',
          magic_link          TEXT,
          mode                TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto','manual')),
          statut              TEXT NOT NULL DEFAULT 'envoye' CHECK (statut IN ('pending','envoye','echec')),
          erreur              TEXT,
          sent_at             TEXT,
          created_by          INTEGER,
          created_at          TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (campagne_id) REFERENCES campagnes(id) ON DELETE CASCADE,
          FOREIGN KEY (assujetti_id) REFERENCES assujettis(id) ON DELETE CASCADE,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
        );

        INSERT INTO notifications_email_legacy (
          id, campagne_id, assujetti_id, email_destinataire, objet, corps,
          template_code, magic_link, mode, statut, erreur, sent_at, created_by, created_at
        ) VALUES (
          1, ${campagneId}, ${assujettiId}, 'legacy-notification@example.test', 'Objet legacy', 'Corps legacy',
          'invitation_campagne', 'token-legacy', 'manual', 'envoye', NULL, '2036-01-10 10:15:00', ${userId}, '2036-01-10 10:00:00'
        );

        DROP TABLE notifications_email;
        ALTER TABLE notifications_email_legacy RENAME TO notifications_email;
      `);
      ctx.db.exec('COMMIT');
    } catch (error) {
      ctx.db.exec('ROLLBACK');
      throw error;
    } finally {
      ctx.db.pragma('foreign_keys = ON');
    }

    ctx.initSchema();

    const columns = ctx.db.prepare("PRAGMA table_info('notifications_email')").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const byName = new Map(columns.map((column) => [column.name, column]));
    assert.equal(byName.get('relance_niveau')?.name, 'relance_niveau');
    assert.equal(byName.get('piece_jointe_path')?.name, 'piece_jointe_path');
    assert.equal(byName.get('campagne_id')?.notnull, 0);

    const sql = getCreateTableSql(ctx, 'notifications_email') ?? '';
    assert.match(sql, /relance_niveau\s+TEXT\s+CHECK\s*\(\s*relance_niveau\s+IN\s*\('J-30','J-15','J-7','depasse'\)\s*\)/i);

    const row = ctx.db.prepare(
      `SELECT id, campagne_id, assujetti_id, email_destinataire, magic_link, mode, statut, relance_niveau, piece_jointe_path
       FROM notifications_email
       WHERE id = 1`,
    ).get() as {
      id: number;
      campagne_id: number;
      assujetti_id: number;
      email_destinataire: string;
      magic_link: string | null;
      mode: string;
      statut: string;
      relance_niveau: string | null;
      piece_jointe_path: string | null;
    };
    assert.equal(row.id, 1);
    assert.equal(row.campagne_id, campagneId);
    assert.equal(row.assujetti_id, assujettiId);
    assert.equal(row.email_destinataire, 'legacy-notification@example.test');
    assert.equal(row.magic_link, 'token-legacy');
    assert.equal(row.mode, 'manual');
    assert.equal(row.statut, 'envoye');
    assert.equal(row.relance_niveau, null);
    assert.equal(row.piece_jointe_path, null);

    const indexes = getIndexNames(ctx, 'notifications_email');
    assert.equal(indexes.has('idx_notifications_email_campagne'), true);
    assert.equal(indexes.has('idx_notifications_email_statut'), true);

    ctx.db.prepare(
      `INSERT INTO notifications_email (
        campagne_id, assujetti_id, email_destinataire, objet, corps, template_code,
        relance_niveau, piece_jointe_path, magic_link, mode, statut, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      null,
      assujettiId,
      'depasse@example.test',
      'Relance depassee',
      'Corps',
      'mise_en_demeure_auto',
      'depasse',
      'archive/depasse.pdf',
      null,
      'auto',
      'pending',
      userId,
    );

    assert.throws(
      () =>
        ctx.db.prepare(
          `INSERT INTO notifications_email (
            campagne_id, assujetti_id, email_destinataire, objet, corps, template_code,
            relance_niveau, mode, statut, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          null,
          assujettiId,
          'invalid@example.test',
          'Invalide',
          'Corps',
          'mise_en_demeure_auto',
          'J-99',
          'auto',
          'pending',
          userId,
        ),
      /CHECK constraint failed/,
    );

    const fkState = ctx.db.pragma('foreign_keys', { simple: true }) as number;
    assert.equal(fkState, 1);
  });
});

test('initSchema migre paiements legacy avec defaults/backfill et indexes', async () => {
  await withContext((ctx) => {
    ctx.initSchema();
    const assujettiId = seedAssujetti(ctx);
    const declarationId = seedDeclaration(ctx, assujettiId);
    const titreId = seedTitre(ctx, declarationId, assujettiId);

    ctx.db.pragma('foreign_keys = OFF');
    ctx.db.exec('BEGIN TRANSACTION');
    try {
      ctx.db.exec(`
        CREATE TABLE paiements_legacy (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          titre_id      INTEGER NOT NULL,
          montant       REAL NOT NULL,
          date_paiement TEXT NOT NULL,
          modalite      TEXT NOT NULL CHECK (modalite IN ('virement','cheque','tipi','sepa','numeraire')),
          reference     TEXT,
          commentaire   TEXT,
          FOREIGN KEY (titre_id) REFERENCES titres(id) ON DELETE CASCADE
        );

        INSERT INTO paiements_legacy (id, titre_id, montant, date_paiement, modalite, reference, commentaire)
        VALUES (1, ${titreId}, 75.5, '2036-04-10', 'virement', 'VIR-LEGACY', 'Paiement historique');

        DROP TABLE paiements;
        ALTER TABLE paiements_legacy RENAME TO paiements;
      `);
      ctx.db.exec('COMMIT');
    } catch (error) {
      ctx.db.exec('ROLLBACK');
      throw error;
    } finally {
      ctx.db.pragma('foreign_keys = ON');
    }

    ctx.initSchema();

    const columns = ctx.db.prepare("PRAGMA table_info('paiements')").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    assert.equal(names.has('provider'), true);
    assert.equal(names.has('statut'), true);
    assert.equal(names.has('transaction_id'), true);
    assert.equal(names.has('callback_payload'), true);
    assert.equal(names.has('created_at'), true);

    const sql = getCreateTableSql(ctx, 'paiements') ?? '';
    assert.match(sql, /provider\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'manuel'\s+CHECK\s*\(\s*provider\s+IN\s*\('manuel','payfip'\)\s*\)/i);
    assert.match(sql, /statut\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'confirme'\s+CHECK\s*\(\s*statut\s+IN\s*\('confirme','annule','refuse','en_attente'\)\s*\)/i);
    assert.match(sql, /transaction_id\s+TEXT\s+UNIQUE/i);
    assert.match(sql, /created_at\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s*\(datetime\('now'\)\)/i);

    const row = ctx.db.prepare(
      `SELECT montant, provider, statut, transaction_id, callback_payload, created_at
       FROM paiements WHERE id = 1`,
    ).get() as {
      montant: number;
      provider: string;
      statut: string;
      transaction_id: string | null;
      callback_payload: string | null;
      created_at: string;
    };
    assert.equal(row.montant, 75.5);
    assert.equal(row.provider, 'manuel');
    assert.equal(row.statut, 'confirme');
    assert.equal(row.transaction_id, null);
    assert.equal(row.callback_payload, null);
    assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}/);

    const indexes = getIndexNames(ctx, 'paiements');
    assert.equal(indexes.has('idx_paiements_titre_date'), true);
    assert.equal(indexes.has('idx_paiements_transaction'), true);

    ctx.db.prepare(
      `INSERT INTO paiements (
        titre_id, montant, date_paiement, modalite, reference, commentaire,
        provider, statut, transaction_id, callback_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      titreId,
      10,
      '2036-04-11',
      'tipi',
      'PAY-1',
      'Premier paiement cible',
      'payfip',
      'en_attente',
      'PAY-UNIQUE-1',
      '{"source":"callback"}',
    );

    assert.throws(
      () =>
        ctx.db.prepare(
          `INSERT INTO paiements (
            titre_id, montant, date_paiement, modalite, reference, commentaire,
            provider, statut, transaction_id, callback_payload
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          titreId,
          12,
          '2036-04-12',
          'cheque',
          'PAY-2',
          'Doublon transaction',
          'manuel',
          'confirme',
          'PAY-UNIQUE-1',
          null,
        ),
      /UNIQUE constraint failed: paiements.transaction_id/,
    );

    const fkState = ctx.db.pragma('foreign_keys', { simple: true }) as number;
    assert.equal(fkState, 1);
  });
});

test('initSchema reconstruit recouvrement_actions legacy pour étendre enums et unicité', async () => {
  await withContext((ctx) => {
    ctx.initSchema();
    const userId = seedUser(ctx);
    const assujettiId = seedAssujetti(ctx);
    const declarationId = seedDeclaration(ctx, assujettiId);
    const titreId = seedTitre(ctx, declarationId, assujettiId);

    ctx.db.pragma('foreign_keys = OFF');
    ctx.db.exec('BEGIN TRANSACTION');
    try {
      ctx.db.exec(`
        CREATE TABLE recouvrement_actions_legacy (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          titre_id           INTEGER NOT NULL,
          niveau             TEXT NOT NULL CHECK (niveau IN ('J+10','J+30','J+60')),
          action_type        TEXT NOT NULL CHECK (action_type IN ('rappel_email','mise_en_demeure','transmission_comptable')),
          statut             TEXT NOT NULL CHECK (statut IN ('pending','envoye','echec','transmis')),
          email_destinataire TEXT,
          piece_jointe_path  TEXT,
          details            TEXT,
          created_by         INTEGER,
          created_at         TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (titre_id) REFERENCES titres(id) ON DELETE CASCADE,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
          UNIQUE (titre_id, niveau)
        );

        INSERT INTO recouvrement_actions_legacy (
          id, titre_id, niveau, action_type, statut, email_destinataire, piece_jointe_path, details, created_by, created_at
        ) VALUES (
          1, ${titreId}, 'J+30', 'mise_en_demeure', 'envoye', 'legacy-recouvrement@example.test', 'legacy.pdf', '{"source":"legacy"}', ${userId}, '2036-04-15 09:00:00'
        );

        DROP TABLE recouvrement_actions;
        ALTER TABLE recouvrement_actions_legacy RENAME TO recouvrement_actions;
      `);
      ctx.db.exec('COMMIT');
    } catch (error) {
      ctx.db.exec('ROLLBACK');
      throw error;
    } finally {
      ctx.db.pragma('foreign_keys = ON');
    }

    ctx.initSchema();

    const sql = getCreateTableSql(ctx, 'recouvrement_actions') ?? '';
    assert.match(sql, /niveau\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*niveau\s+IN\s*\('J\+10','J\+30','J\+60','retour_comptable'\)\s*\)/i);
    assert.match(sql, /action_type\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*action_type\s+IN\s*\('rappel_email','mise_en_demeure','transmission_comptable','admission_non_valeur'\)\s*\)/i);
    assert.match(sql, /statut\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*statut\s+IN\s*\('pending','envoye','echec','transmis','classe'\)\s*\)/i);
    assert.match(sql, /UNIQUE\s*\(\s*titre_id\s*,\s*niveau\s*,\s*action_type\s*\)/i);

    const legacyRow = ctx.db.prepare(
      `SELECT titre_id, niveau, action_type, statut, email_destinataire, piece_jointe_path, details, created_by
       FROM recouvrement_actions WHERE id = 1`,
    ).get() as {
      titre_id: number;
      niveau: string;
      action_type: string;
      statut: string;
      email_destinataire: string | null;
      piece_jointe_path: string | null;
      details: string | null;
      created_by: number | null;
    };
    assert.equal(legacyRow.titre_id, titreId);
    assert.equal(legacyRow.niveau, 'J+30');
    assert.equal(legacyRow.action_type, 'mise_en_demeure');
    assert.equal(legacyRow.statut, 'envoye');
    assert.equal(legacyRow.created_by, userId);

    ctx.db.prepare(
      `INSERT INTO recouvrement_actions (
        titre_id, niveau, action_type, statut, email_destinataire, details, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(titreId, 'retour_comptable', 'admission_non_valeur', 'classe', null, '{"resultat":"classe"}', userId);

    ctx.db.prepare(
      `INSERT INTO recouvrement_actions (
        titre_id, niveau, action_type, statut, email_destinataire, details, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(titreId, 'J+30', 'rappel_email', 'pending', 'followup@example.test', '{"resultat":"pending"}', userId);

    assert.throws(
      () =>
        ctx.db.prepare(
          `INSERT INTO recouvrement_actions (
            titre_id, niveau, action_type, statut, email_destinataire, details, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(titreId, 'J+30', 'rappel_email', 'envoye', 'duplicate@example.test', '{"duplicate":true}', userId),
      /UNIQUE constraint failed: recouvrement_actions.titre_id, recouvrement_actions.niveau, recouvrement_actions.action_type/,
    );

    const indexes = getIndexNames(ctx, 'recouvrement_actions');
    assert.equal(indexes.has('idx_recouvrement_actions_titre'), true);
    assert.equal(indexes.has('idx_recouvrement_actions_niveau'), true);

    const fkState = ctx.db.pragma('foreign_keys', { simple: true }) as number;
    assert.equal(fkState, 1);
  });
});

test('initSchema rejette des titres legacy avec statut invalide et restaure foreign_keys', async () => {
  await withContext((ctx) => {
    ctx.initSchema();
    const assujettiId = seedAssujetti(ctx);
    const declarationId = seedDeclaration(ctx, assujettiId);

    ctx.db.pragma('foreign_keys = OFF');
    ctx.db.exec('BEGIN TRANSACTION');
    try {
      ctx.db.exec(`
        CREATE TABLE titres_legacy (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          numero          TEXT NOT NULL UNIQUE,
          declaration_id  INTEGER NOT NULL UNIQUE,
          assujetti_id    INTEGER NOT NULL,
          annee           INTEGER NOT NULL,
          montant         REAL NOT NULL,
          date_emission   TEXT NOT NULL,
          date_echeance   TEXT NOT NULL,
          statut          TEXT NOT NULL DEFAULT 'emis',
          montant_paye    REAL NOT NULL DEFAULT 0,
          FOREIGN KEY (declaration_id) REFERENCES declarations(id),
          FOREIGN KEY (assujetti_id) REFERENCES assujettis(id)
        );

        INSERT INTO titres_legacy (
          id, numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut, montant_paye
        ) VALUES (
          1, 'TIT-2036-LEGACY', ${declarationId}, ${assujettiId}, 2036, 120, '2036-04-01', '2036-05-01', 'annule', 0
        );

        DROP TABLE titres;
        ALTER TABLE titres_legacy RENAME TO titres;
      `);
      ctx.db.exec('COMMIT');
    } catch (error) {
      ctx.db.exec('ROLLBACK');
      throw error;
    } finally {
      ctx.db.pragma('foreign_keys = ON');
    }

    assert.throws(
      () => ctx.initSchema(),
      /Migration titres\.statut impossible: annule \(1\)/,
    );

    const fkState = ctx.db.pragma('foreign_keys', { simple: true }) as number;
    assert.equal(fkState, 1);
  });
});
