import test from 'node:test';
import assert from 'node:assert/strict';
import { db, initSchema } from './db';
import { closeCampagne, createCampagne, getCampagneActive, listCampagnes, openCampagne } from './campagnes';

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
  assert.ok(notif?.magic_link && notif.magic_link.includes('/activation?token='));

  const links = (
    db
      .prepare('SELECT COUNT(*) AS c FROM invitation_magic_links WHERE campagne_id = ? AND assujetti_id = ?')
      .get(campagneId, assujettiId) as { c: number }
  ).c;
  assert.equal(links, 1);
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

test('closeCampagne cloture et bascule les declarations brouillon en en_instruction + mises en demeure', () => {
  resetTables();
  const adminId = seedAdmin();
  const assujettiId = seedAssujetti('TLPE-CLOSE-1', 'close1@example.fr');

  const campagneId = createCampagne({
    annee: 2029,
    date_ouverture: '2029-01-01',
    date_limite_declaration: '2029-03-01',
    date_cloture: '2029-03-10',
    created_by: adminId,
  });

  const d1 = seedDeclaration(assujettiId, 2029, 'brouillon');
  const assujetti2 = seedAssujetti('TLPE-CLOSE-2', 'close2@example.fr');
  const d2 = seedDeclaration(assujetti2, 2029, 'brouillon');
  const assujetti3 = seedAssujetti('TLPE-CLOSE-3', 'close3@example.fr');
  const d3 = seedDeclaration(assujetti3, 2029, 'soumise');
  assert.ok(d1 > 0 && d2 > 0 && d3 > 0);

  openCampagne(campagneId, adminId);
  const result = closeCampagne(campagneId, adminId, '127.0.0.1');

  assert.equal(result.annee, 2029);
  assert.equal(result.brouillons_bascules, 2);

  const statusCampagne = (db.prepare('SELECT statut FROM campagnes WHERE id = ?').get(campagneId) as { statut: string }).statut;
  assert.equal(statusCampagne, 'cloturee');

  const counts = db
    .prepare(
      `SELECT statut, COUNT(*) AS total
       FROM declarations
       WHERE annee = 2029
       GROUP BY statut`,
    )
    .all() as Array<{ statut: string; total: number }>;

  const byStatus = new Map(counts.map((c) => [c.statut, c.total]));
  assert.equal(byStatus.get('en_instruction'), 2);
  assert.equal(byStatus.get('soumise'), 1);

  const mises = (db.prepare('SELECT COUNT(*) AS c FROM mises_en_demeure WHERE campagne_id = ?').get(campagneId) as { c: number }).c;
  assert.equal(mises, 2);
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
