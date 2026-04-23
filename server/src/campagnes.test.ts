import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { db, initSchema, resolveSchemaPath } from './db';
import { closeCampagne, createCampagne, getCampagneActive, listCampagnes, openCampagne } from './campagnes';

process.env.TLPE_EMAIL_DELIVERY_MODE = 'mock-success';

test('resolveSchemaPath retombe sur le schema source si dist/schema.sql est absent', () => {
  const fakeDistDir = path.join(__dirname, '..', 'dist');
  const resolved = resolveSchemaPath(fakeDistDir);
  assert.equal(resolved, path.join(__dirname, 'schema.sql'));
  assert.equal(fs.existsSync(resolved), true);
});

function resetTables() {
  initSchema();
  db.exec('DELETE FROM notifications_email');
  db.exec('DELETE FROM invitation_magic_links');
  db.exec('DELETE FROM campagne_jobs');
  db.exec('DELETE FROM mises_en_demeure');
  db.exec('DELETE FROM declarations');
  db.exec('DELETE FROM campagnes');
  db.exec('DELETE FROM audit_log');
  db.exec('DELETE FROM users');
  db.exec('DELETE FROM assujettis');
}

function seedAdmin(email = 'admin-campagne@tlpe.local') {
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES (?, 'hash', 'Admin', 'Campagne', 'admin', 1)`,
    )
    .run(email);
  return Number(info.lastInsertRowid);
}

function seedAssujetti(code = 'TLPE-CAMP-1', email?: string | null, statut: 'actif' | 'inactif' = 'actif') {
  const info = db
    .prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, statut) VALUES (?, ?, ?, ?)`)
    .run(code, `Assujetti ${code}`, email ?? null, statut);
  return Number(info.lastInsertRowid);
}

function seedDeclaration(assujettiId: number, annee: number, statut: 'brouillon' | 'soumise' | 'validee' = 'brouillon') {
  const info = db
    .prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut)
       VALUES (?, ?, ?, ?)`,
    )
    .run(`DEC-${annee}-${Math.random().toString(16).slice(2, 8)}`, assujettiId, annee, statut);
  return Number(info.lastInsertRowid);
}

test('schema contient les tables campagnes, campagne_jobs et mises_en_demeure', () => {
  resetTables();

  const campagnesCols = db.prepare("PRAGMA table_info('campagnes')").all() as Array<{ name: string }>;
  const campagneNames = new Set(campagnesCols.map((c) => c.name));
  assert.ok(campagneNames.has('annee'));
  assert.ok(campagneNames.has('date_ouverture'));
  assert.ok(campagneNames.has('date_limite_declaration'));
  assert.ok(campagneNames.has('date_cloture'));
  assert.ok(campagneNames.has('statut'));
  assert.ok(campagneNames.has('created_by'));

  const campagnesFks = db.prepare("PRAGMA foreign_key_list('campagnes')").all() as Array<{ from: string; table: string }>;
  assert.ok(campagnesFks.some((fk) => fk.from === 'created_by' && fk.table === 'users'));

  const jobCols = db.prepare("PRAGMA table_info('campagne_jobs')").all() as Array<{ name: string }>;
  const jobNames = new Set(jobCols.map((c) => c.name));
  assert.ok(jobNames.has('campagne_id'));
  assert.ok(jobNames.has('type'));
  assert.ok(jobNames.has('statut'));

  const miseCols = db.prepare("PRAGMA table_info('mises_en_demeure')").all() as Array<{ name: string }>;
  const miseNames = new Set(miseCols.map((c) => c.name));
  assert.ok(miseNames.has('campagne_id'));
  assert.ok(miseNames.has('declaration_id'));
  assert.ok(miseNames.has('statut'));
});

test('initSchema restaure foreign_keys=ON meme si migration campagnes echoue', () => {
  resetTables();

  const hasFkBefore = (
    db.prepare("PRAGMA foreign_key_list('campagnes')").all() as Array<{ from: string; table: string }>
  ).some((fk) => fk.from === 'created_by' && fk.table === 'users');

  // Force une table legacy sans FK pour declencher le chemin de migration
  if (hasFkBefore) {
    db.pragma('foreign_keys = OFF');
    db.exec('BEGIN TRANSACTION');
    try {
      db.exec(`
        CREATE TABLE campagnes_legacy (
          id                        INTEGER PRIMARY KEY AUTOINCREMENT,
          annee                     INTEGER NOT NULL UNIQUE,
          date_ouverture            TEXT NOT NULL,
          date_limite_declaration   TEXT NOT NULL,
          date_cloture              TEXT NOT NULL,
          statut                    TEXT NOT NULL DEFAULT 'brouillon' CHECK (statut IN ('brouillon','ouverte','cloturee')),
          created_by                INTEGER NOT NULL,
          created_at                TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO campagnes_legacy (id, annee, date_ouverture, date_limite_declaration, date_cloture, statut, created_by, created_at, updated_at)
        SELECT id, annee, date_ouverture, date_limite_declaration, date_cloture, statut, created_by, created_at, updated_at
        FROM campagnes;

        DROP TABLE campagnes;
        ALTER TABLE campagnes_legacy RENAME TO campagnes;
        CREATE INDEX IF NOT EXISTS idx_campagnes_statut ON campagnes(statut);
      `);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }

  // Rend la migration impossible (created_by orphelin)
  db.pragma('foreign_keys = OFF');
  const orphanInsert = db
    .prepare(
      `INSERT INTO campagnes (annee, date_ouverture, date_limite_declaration, date_cloture, statut, created_by)
       VALUES (2099, '2099-01-01', '2099-03-01', '2099-03-10', 'brouillon', 999999)`,
    )
    .run();
  assert.ok(Number(orphanInsert.lastInsertRowid) > 0);
  db.pragma('foreign_keys = ON');

  try {
    assert.throws(() => initSchema(), /Migration campagnes\.created_by impossible/);

    const fkState = db.pragma('foreign_keys', { simple: true }) as number;
    assert.equal(fkState, 1);
  } finally {
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM campagnes WHERE annee = 2099').run();
    db.pragma('foreign_keys = ON');
    initSchema();
  }
});

test('initSchema ajoute quote_part avec une contrainte CHECK sur les bases legacy', () => {
  resetTables();

  db.pragma('foreign_keys = OFF');
  db.exec('BEGIN TRANSACTION');
  try {
    db.exec(`
      CREATE TABLE lignes_declaration_legacy (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        declaration_id    INTEGER NOT NULL,
        dispositif_id     INTEGER NOT NULL,
        surface_declaree  REAL NOT NULL,
        nombre_faces      INTEGER NOT NULL DEFAULT 1,
        date_pose         TEXT,
        date_depose       TEXT,
        bareme_id         INTEGER,
        tarif_applique    REAL,
        coefficient_zone  REAL,
        prorata           REAL,
        montant_ligne     REAL,
        FOREIGN KEY (declaration_id) REFERENCES declarations(id) ON DELETE CASCADE,
        FOREIGN KEY (dispositif_id) REFERENCES dispositifs(id),
        FOREIGN KEY (bareme_id) REFERENCES baremes(id)
      );

      INSERT INTO lignes_declaration_legacy (
        id, declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, date_depose,
        bareme_id, tarif_applique, coefficient_zone, prorata, montant_ligne
      )
      SELECT
        id, declaration_id, dispositif_id, surface_declaree, nombre_faces, date_pose, date_depose,
        bareme_id, tarif_applique, coefficient_zone, prorata, montant_ligne
      FROM lignes_declaration;

      DROP TABLE lignes_declaration;
      ALTER TABLE lignes_declaration_legacy RENAME TO lignes_declaration;
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.pragma('foreign_keys = ON');
  }

  initSchema();

  const quotePartColumn = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lignes_declaration'").get() as
      | { sql: string }
      | undefined
  )?.sql;
  assert.match(
    quotePartColumn ?? '',
    /quote_part\s+REAL\s+NOT\s+NULL\s+DEFAULT\s+1(?:\.0)?\s+CHECK\s*\(\s*quote_part\s*>=\s*0\s+AND\s+quote_part\s*<=\s*1\s*\)/i,
  );

  db.pragma('foreign_keys = OFF');
  try {
    assert.throws(
      () =>
        db.prepare(
          `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces, quote_part)
           VALUES (1, 1, 12, 1, 1.2)`,
        ).run(),
      /CHECK constraint failed/,
    );
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

test('createCampagne cree une campagne brouillon et journalise', () => {
  resetTables();
  const adminId = seedAdmin();

  const campagneId = createCampagne({
    annee: 2026,
    date_ouverture: '2026-01-01',
    date_limite_declaration: '2026-03-01',
    date_cloture: '2026-03-10',
    created_by: adminId,
  });

  const row = db.prepare('SELECT annee, statut, created_by FROM campagnes WHERE id = ?').get(campagneId) as
    | { annee: number; statut: string; created_by: number }
    | undefined;

  assert.ok(row);
  assert.equal(row?.annee, 2026);
  assert.equal(row?.statut, 'brouillon');
  assert.equal(row?.created_by, adminId);

  const auditCount = (db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE entite = 'campagne' AND action = 'create'").get() as { c: number }).c;
  assert.equal(auditCount, 1);
});

test('createCampagne rejette un annee dupliquee', () => {
  resetTables();
  const adminId = seedAdmin();

  createCampagne({
    annee: 2026,
    date_ouverture: '2026-01-01',
    date_limite_declaration: '2026-03-01',
    date_cloture: '2026-03-10',
    created_by: adminId,
  });

  assert.throws(
    () =>
      createCampagne({
        annee: 2026,
        date_ouverture: '2026-01-02',
        date_limite_declaration: '2026-03-01',
        date_cloture: '2026-03-10',
        created_by: adminId,
      }),
    /existe deja/,
  );
});

test('createCampagne rejette une date calendrier invalide', () => {
  resetTables();
  const adminId = seedAdmin();

  assert.throws(
    () =>
      createCampagne({
        annee: 2026,
        date_ouverture: '2026-02-30',
        date_limite_declaration: '2026-03-01',
        date_cloture: '2026-03-10',
        created_by: adminId,
      }),
    /date calendrier invalide/,
  );
});

test('openCampagne active une campagne et cree/termine un job invitation', () => {
  resetTables();
  const adminId = seedAdmin();
  const assujetti1 = seedAssujetti('TLPE-CAMP-OPEN-1', 'open-1@example.fr');
  const assujetti2 = seedAssujetti('TLPE-CAMP-OPEN-2', 'open-2@example.fr');

  const campagneId = createCampagne({
    annee: 2027,
    date_ouverture: '2027-01-01',
    date_limite_declaration: '2027-03-01',
    date_cloture: '2027-03-10',
    created_by: adminId,
  });

  const result = openCampagne(campagneId, adminId, '127.0.0.1');
  assert.equal(result.annee, 2027);
  assert.equal(result.invitations_preparees, 2);

  const active = getCampagneActive() as { id: number; statut: string } | undefined;
  assert.ok(active);
  assert.equal(active?.id, campagneId);
  assert.equal(active?.statut, 'ouverte');

  const jobs = db
    .prepare("SELECT type, statut FROM campagne_jobs WHERE campagne_id = ? ORDER BY id")
    .all(campagneId) as Array<{ type: string; statut: string }>;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].type, 'invitation');
  assert.equal(jobs[0].statut, 'done');

  const notifications = db
    .prepare('SELECT assujetti_id, statut FROM notifications_email WHERE campagne_id = ? ORDER BY assujetti_id')
    .all(campagneId) as Array<{ assujetti_id: number; statut: string }>;
  assert.equal(notifications.length, 2);
  assert.deepEqual(notifications.map((n) => n.assujetti_id), [assujetti1, assujetti2]);
  assert.ok(notifications.every((n) => n.statut === 'envoye'));
});

test('openCampagne rejette une campagne deja ouverte', () => {
  resetTables();
  const adminId = seedAdmin();
  seedAssujetti('TLPE-CAMP-OPEN-RETRY-1', 'retry@example.fr');

  const campagneId = createCampagne({
    annee: 2027,
    date_ouverture: '2027-01-01',
    date_limite_declaration: '2027-03-01',
    date_cloture: '2027-03-10',
    created_by: adminId,
  });

  openCampagne(campagneId, adminId);

  assert.throws(() => openCampagne(campagneId, adminId), /deja ouverte/);

  const invitations = (
    db
      .prepare("SELECT COUNT(*) AS c FROM campagne_jobs WHERE campagne_id = ? AND type = 'invitation'")
      .get(campagneId) as { c: number }
  ).c;
  assert.equal(invitations, 1);
});

test('openCampagne cree un magic link pour les assujettis sans compte portail', () => {
  resetTables();
  const adminId = seedAdmin();
  const assujettiId = seedAssujetti('TLPE-CAMP-MAGIC-1', 'magic@example.fr');

  const campagneId = createCampagne({
    annee: 2036,
    date_ouverture: '2036-01-01',
    date_limite_declaration: '2036-03-01',
    date_cloture: '2036-03-10',
    created_by: adminId,
  });

  openCampagne(campagneId, adminId);

  const notif = db
    .prepare('SELECT magic_link FROM notifications_email WHERE campagne_id = ? AND assujetti_id = ?')
    .get(campagneId, assujettiId) as { magic_link: string | null } | undefined;
  assert.ok(notif);
  assert.ok(notif?.magic_link && notif.magic_link.includes('/login?invitation_token=[redacted]'));

  const links = (
    db
      .prepare('SELECT COUNT(*) AS c FROM invitation_magic_links WHERE campagne_id = ? AND assujetti_id = ?')
      .get(campagneId, assujettiId) as { c: number }
  ).c;
  assert.equal(links, 1);
});

test('openCampagne reporte invitations_preparees y compris pending/echec', () => {
  resetTables();
  const adminId = seedAdmin();
  seedAssujetti('TLPE-CAMP-PREP-1', 'prep1@example.fr');
  seedAssujetti('TLPE-CAMP-PREP-2', 'prep2@example.fr');

  const prevMode = process.env.TLPE_EMAIL_DELIVERY_MODE;
  process.env.TLPE_EMAIL_DELIVERY_MODE = 'disabled';

  try {
    const campagneId = createCampagne({
      annee: 2037,
      date_ouverture: '2037-01-01',
      date_limite_declaration: '2037-03-01',
      date_cloture: '2037-03-10',
      created_by: adminId,
    });

    const result = openCampagne(campagneId, adminId);
    assert.equal(result.invitations_preparees, 2);

    const jobPayloadRaw = (
      db
        .prepare("SELECT payload FROM campagne_jobs WHERE campagne_id = ? AND type = 'invitation' LIMIT 1")
        .get(campagneId) as { payload: string | null }
    ).payload;
    assert.ok(jobPayloadRaw);
    const jobPayload = JSON.parse(jobPayloadRaw!);
    assert.equal(jobPayload.invitations_preparees, 2);
    assert.equal(jobPayload.invitations_skipped, 0);
  } finally {
    process.env.TLPE_EMAIL_DELIVERY_MODE = prevMode;
  }
});

test('openCampagne bascule une ancienne ouverte en brouillon', () => {
  resetTables();
  const adminId = seedAdmin();
  seedAssujetti('TLPE-CAMP-SWITCH-1', 'switch@example.fr');

  const firstId = createCampagne({
    annee: 2027,
    date_ouverture: '2027-01-01',
    date_limite_declaration: '2027-03-01',
    date_cloture: '2027-03-10',
    created_by: adminId,
  });
  const secondId = createCampagne({
    annee: 2028,
    date_ouverture: '2028-01-01',
    date_limite_declaration: '2028-03-01',
    date_cloture: '2028-03-10',
    created_by: adminId,
  });

  openCampagne(firstId, adminId);
  openCampagne(secondId, adminId);

  const firstStatus = (db.prepare('SELECT statut FROM campagnes WHERE id = ?').get(firstId) as { statut: string }).statut;
  const secondStatus = (db.prepare('SELECT statut FROM campagnes WHERE id = ?').get(secondId) as { statut: string }).statut;
  assert.equal(firstStatus, 'brouillon');
  assert.equal(secondStatus, 'ouverte');
});

test('closeCampagne genere les mises en demeure J+1, declaration d\'office et notifications associees', () => {
  resetTables();
  const adminId = seedAdmin();

  const assujettiSansDecl = seedAssujetti('TLPE-J1-A1', 'j1-a1@example.fr');
  const assujettiAvecSoumise = seedAssujetti('TLPE-J1-A2', 'j1-a2@example.fr');
  const assujettiSansEmail = seedAssujetti('TLPE-J1-A3', null);

  const campagneId = createCampagne({
    annee: 2031,
    date_ouverture: '2031-01-01',
    date_limite_declaration: '2031-03-01',
    date_cloture: '2031-03-10',
    created_by: adminId,
  });

  // Historique N-1 pour reprise PDF
  const declN1 = seedDeclaration(assujettiSansDecl, 2030, 'validee');
  const typeId = Number(
    (
      db
        .prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('AFF', 'Affiche', 'publicitaire')`)
        .run().lastInsertRowid
    ),
  );
  const dispositifId = Number(
    (
      db
        .prepare(
          `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces, statut)
           VALUES ('DSP-J1-0001', ?, ?, 12.5, 2, 'declare')`,
        )
        .run(assujettiSansDecl, typeId).lastInsertRowid
    ),
  );
  db.prepare(
    `INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces)
     VALUES (?, ?, 12.5, 2)`,
  ).run(declN1, dispositifId);

  // Deja declare pour annee courante -> doit etre exclu
  seedDeclaration(assujettiAvecSoumise, 2031, 'soumise');

  openCampagne(campagneId, adminId);
  const result = closeCampagne(campagneId, adminId, '127.0.0.1') as {
    annee: number;
    mises_en_demeure_j1: {
      run_date: string;
      eligibles: number;
      declarations_office_creees: number;
      notifications_envoyees: number;
      pdf_generes: number;
    };
  };

  assert.equal(result.annee, 2031);
  assert.equal(result.mises_en_demeure_j1.run_date, '2031-03-11');
  assert.equal(result.mises_en_demeure_j1.eligibles, 2);
  assert.equal(result.mises_en_demeure_j1.declarations_office_creees, 2);
  assert.equal(result.mises_en_demeure_j1.notifications_envoyees, 2);
  assert.equal(result.mises_en_demeure_j1.pdf_generes, 2);

  const decl2031 = db
    .prepare(`SELECT assujetti_id, statut, commentaires, alerte_gestionnaire FROM declarations WHERE annee = 2031 ORDER BY assujetti_id`)
    .all() as Array<{ assujetti_id: number; statut: string; commentaires: string | null; alerte_gestionnaire: number }>;

  const byAssujetti = new Map(decl2031.map((row) => [row.assujetti_id, row]));
  assert.equal(byAssujetti.get(assujettiSansDecl)?.statut, 'en_instruction');
  assert.equal(byAssujetti.get(assujettiSansDecl)?.alerte_gestionnaire, 1);
  assert.match(byAssujetti.get(assujettiSansDecl)?.commentaires ?? '', /Declaration d'office auto-generee/);
  assert.equal(byAssujetti.get(assujettiSansEmail)?.statut, 'en_instruction');
  assert.equal(byAssujetti.get(assujettiAvecSoumise)?.statut, 'soumise');

  const mises = db
    .prepare(
      `SELECT m.statut, d.assujetti_id
       FROM mises_en_demeure m
       JOIN declarations d ON d.id = m.declaration_id
       WHERE m.campagne_id = ?
       ORDER BY d.assujetti_id`,
    )
    .all(campagneId) as Array<{ statut: string; assujetti_id: number }>;
  assert.equal(mises.length, 2);
  const statutA1 = mises.find((m) => m.assujetti_id === assujettiSansDecl)?.statut;
  const statutA3 = mises.find((m) => m.assujetti_id === assujettiSansEmail)?.statut;
  assert.equal(statutA1, 'envoyee');
  assert.equal(statutA3, 'a_traiter');

  const notif = db
    .prepare(
      `SELECT assujetti_id, template_code, statut, erreur, piece_jointe_path
       FROM notifications_email
       WHERE campagne_id = ?
       AND template_code = 'mise_en_demeure_auto'
       ORDER BY assujetti_id`,
    )
    .all(campagneId) as Array<{
    assujetti_id: number;
    template_code: string;
    statut: string;
    erreur: string | null;
    piece_jointe_path: string | null;
  }>;
  assert.equal(notif.length, 2);
  const notifA1 = notif.find((n) => n.assujetti_id === assujettiSansDecl);
  const notifA3 = notif.find((n) => n.assujetti_id === assujettiSansEmail);
  assert.equal(notifA1?.statut, 'envoye');
  assert.equal(notifA1?.erreur, null);
  assert.ok(notifA1?.piece_jointe_path);
  assert.equal(notifA3?.statut, 'echec');
  assert.match(notifA3?.erreur ?? '', /Email manquant/);
  assert.ok(notifA3?.piece_jointe_path);

  const pdfAbs = path.resolve(__dirname, '..', 'data', notifA1!.piece_jointe_path!);
  assert.equal(fs.existsSync(pdfAbs), true);

  const closeJob = db
    .prepare(`SELECT payload FROM campagne_jobs WHERE campagne_id = ? AND type = 'cloture' ORDER BY id DESC LIMIT 1`)
    .get(campagneId) as { payload: string } | undefined;
  assert.ok(closeJob);
  const payload = JSON.parse(closeJob!.payload);
  assert.equal(payload.run_date, '2031-03-11');
  assert.equal(payload.eligibles, 2);

  const auditCount = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE entite = 'campagne' AND action = 'mise-en-demeure-j1' AND entite_id = ?`)
      .get(campagneId) as { c: number }
  ).c;
  assert.equal(auditCount, 2);
});


test('closeCampagne rejette une campagne non ouverte', () => {
  resetTables();
  const adminId = seedAdmin();

  const campagneId = createCampagne({
    annee: 2030,
    date_ouverture: '2030-01-01',
    date_limite_declaration: '2030-03-01',
    date_cloture: '2030-03-10',
    created_by: adminId,
  });

  assert.throws(() => closeCampagne(campagneId, adminId), /ouverte/);
});

test('listCampagnes renvoie les campagnes triees annee desc', () => {
  resetTables();
  const adminId = seedAdmin();

  createCampagne({ annee: 2031, date_ouverture: '2031-01-01', date_limite_declaration: '2031-03-01', date_cloture: '2031-03-10', created_by: adminId });
  createCampagne({ annee: 2033, date_ouverture: '2033-01-01', date_limite_declaration: '2033-03-01', date_cloture: '2033-03-10', created_by: adminId });
  createCampagne({ annee: 2032, date_ouverture: '2032-01-01', date_limite_declaration: '2032-03-01', date_cloture: '2032-03-10', created_by: adminId });

  const rows = listCampagnes() as Array<{ annee: number }>;
  assert.deepEqual(rows.map((r) => r.annee), [2033, 2032, 2031]);
});
