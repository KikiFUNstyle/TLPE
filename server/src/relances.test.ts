import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { db, initSchema } from './db';
import { createCampagne, openCampagne } from './campagnes';
import { computeRunDateForNiveau, relanceNiveauFromDate, runRelancesDeclarations } from './relances';

process.env.TLPE_EMAIL_DELIVERY_MODE = 'mock-success';

function resetTables() {
  initSchema();
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('DELETE FROM paiements');
    db.exec('DELETE FROM titres');
    db.exec('DELETE FROM contentieux');
    db.exec('DELETE FROM pieces_jointes');
    db.exec('DELETE FROM lignes_declaration');
    db.exec('DELETE FROM declarations');
    db.exec('DELETE FROM dispositifs');
    db.exec('DELETE FROM notifications_email');
    db.exec('DELETE FROM invitation_magic_links');
    db.exec('DELETE FROM campagne_jobs');
    db.exec('DELETE FROM mises_en_demeure');
    db.exec('DELETE FROM campagnes');
    db.exec('DELETE FROM audit_log');
    db.exec('DELETE FROM users');
    db.exec('DELETE FROM assujettis');
  } finally {
    db.pragma('foreign_keys = ON');
  }

  const relancesRoot = path.resolve(__dirname, '..', 'data', 'courriers_relance');
  fs.rmSync(relancesRoot, { recursive: true, force: true });
}

function seedAdmin(email = 'admin-relances@tlpe.local') {
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES (?, 'hash', 'Admin', 'Relances', 'admin', 1)`,
    )
    .run(email);
  return Number(info.lastInsertRowid);
}

function seedAssujetti(code: string, email: string | null, statut: 'actif' | 'inactif' = 'actif') {
  const info = db
    .prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, statut) VALUES (?, ?, ?, ?)`)
    .run(code, `Assujetti ${code}`, email, statut);
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

test('relanceNiveauFromDate detecte correctement J-30/J-15/J-7', () => {
  assert.equal(relanceNiveauFromDate('2034-03-31', '2034-03-01'), 'J-30');
  assert.equal(relanceNiveauFromDate('2034-03-31', '2034-03-16'), 'J-15');
  assert.equal(relanceNiveauFromDate('2034-03-31', '2034-03-24'), 'J-7');
  assert.equal(relanceNiveauFromDate('2034-03-31', '2034-03-20'), null);
});

test('runRelancesDeclarations envoie les relances J-30 uniquement aux assujettis sans declaration soumise/validee', () => {
  resetTables();
  const adminId = seedAdmin();

  const annee = 2034;
  const a1 = seedAssujetti('TLPE-REL-1', 'rel1@example.fr');
  const a2 = seedAssujetti('TLPE-REL-2', 'rel2@example.fr');
  const a3 = seedAssujetti('TLPE-REL-3', 'rel3@example.fr');
  seedAssujetti('TLPE-REL-4', null);
  seedAssujetti('TLPE-REL-5', 'inactive@example.fr', 'inactif');

  seedDeclaration(a2, annee, 'soumise');
  seedDeclaration(a3, annee, 'validee');

  const campagneId = createCampagne({
    annee,
    date_ouverture: '2034-01-01',
    date_limite_declaration: '2034-03-31',
    date_cloture: '2034-04-15',
    relance_j7_courrier: false,
    created_by: adminId,
  });
  openCampagne(campagneId, adminId);

  const runDate = computeRunDateForNiveau('2034-03-31', 'J-30');
  const result = runRelancesDeclarations({ runDateIso: runDate, userId: adminId, ip: '127.0.0.1' });

  assert.equal(result.niveau, 'J-30');
  assert.equal(result.campagne_id, campagneId);
  assert.equal(result.total_eligibles, 1);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.generated_pdfs, 0);

  const notifications = db
    .prepare(
      `SELECT assujetti_id, relance_niveau, template_code, piece_jointe_path
       FROM notifications_email
       WHERE campagne_id = ?
       ORDER BY id`,
    )
    .all(campagneId) as Array<{ assujetti_id: number; relance_niveau: string | null; template_code: string; piece_jointe_path: string | null }>;

  const relances = notifications.filter((n) => n.relance_niveau !== null);
  assert.equal(relances.length, 1);
  assert.equal(relances[0].assujetti_id, a1);
  assert.equal(relances[0].relance_niveau, 'J-30');
  assert.equal(relances[0].template_code, 'relance_declaration');
  assert.equal(relances[0].piece_jointe_path, null);
});

test('runRelancesDeclarations J-15 inclut un lien direct vers le formulaire dans le corps', () => {
  resetTables();
  const adminId = seedAdmin();
  const annee = 2035;

  seedAssujetti('TLPE-REL-J15', 'j15@example.fr');

  const campagneId = createCampagne({
    annee,
    date_ouverture: '2035-01-01',
    date_limite_declaration: '2035-03-31',
    date_cloture: '2035-04-15',
    relance_j7_courrier: false,
    created_by: adminId,
  });
  openCampagne(campagneId, adminId);

  const runDate = computeRunDateForNiveau('2035-03-31', 'J-15');
  const result = runRelancesDeclarations({ runDateIso: runDate, userId: adminId });
  assert.equal(result.niveau, 'J-15');
  assert.equal(result.sent, 1);

  const row = db
    .prepare(
      `SELECT corps, relance_niveau
       FROM notifications_email
       WHERE campagne_id = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(campagneId) as { corps: string; relance_niveau: string } | undefined;

  assert.ok(row);
  assert.equal(row?.relance_niveau, 'J-15');
  assert.match(row!.corps, /\/declarations/);
});

test('runRelancesDeclarations J-7 genere un PDF postal si option campagne activee', () => {
  resetTables();
  const adminId = seedAdmin();
  const annee = 2036;

  const assujettiId = seedAssujetti('TLPE-REL-J7', 'j7@example.fr');

  const campagneId = createCampagne({
    annee,
    date_ouverture: '2036-01-01',
    date_limite_declaration: '2036-03-31',
    date_cloture: '2036-04-15',
    relance_j7_courrier: true,
    created_by: adminId,
  });
  openCampagne(campagneId, adminId);

  const runDate = computeRunDateForNiveau('2036-03-31', 'J-7');
  const result = runRelancesDeclarations({ runDateIso: runDate, userId: adminId });
  assert.equal(result.niveau, 'J-7');
  assert.equal(result.sent, 1);
  assert.equal(result.generated_pdfs, 1);

  const row = db
    .prepare(
      `SELECT assujetti_id, piece_jointe_path, relance_niveau
       FROM notifications_email
       WHERE campagne_id = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(campagneId) as { assujetti_id: number; piece_jointe_path: string | null; relance_niveau: string | null } | undefined;

  assert.ok(row);
  assert.equal(row?.assujetti_id, assujettiId);
  assert.equal(row?.relance_niveau, 'J-7');
  assert.ok(row?.piece_jointe_path);

  const abs = path.resolve(path.join(__dirname, '..', 'data', row!.piece_jointe_path!));
  assert.equal(fs.existsSync(abs), true);
  const stat = fs.statSync(abs);
  assert.ok(stat.size > 0);
});

test('runRelancesDeclarations ne duplique pas une meme relance pour un meme assujetti/niveau', () => {
  resetTables();
  const adminId = seedAdmin();
  const annee = 2037;

  seedAssujetti('TLPE-REL-NODUP', 'nodup@example.fr');

  const campagneId = createCampagne({
    annee,
    date_ouverture: '2037-01-01',
    date_limite_declaration: '2037-03-31',
    date_cloture: '2037-04-15',
    relance_j7_courrier: false,
    created_by: adminId,
  });
  openCampagne(campagneId, adminId);

  const runDate = computeRunDateForNiveau('2037-03-31', 'J-15');
  const first = runRelancesDeclarations({ runDateIso: runDate, userId: adminId });
  const second = runRelancesDeclarations({ runDateIso: runDate, userId: adminId });

  assert.equal(first.sent, 1);
  assert.equal(second.sent, 0);
  assert.equal(second.skipped, 1);

  const count = (
    db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM notifications_email
         WHERE campagne_id = ? AND relance_niveau = 'J-15'`,
      )
      .get(campagneId) as { c: number }
  ).c;
  assert.equal(count, 1);
});

test('runRelancesDeclarations retourne niveau null hors J-30/J-15/J-7', () => {
  resetTables();
  const adminId = seedAdmin();

  const campagneId = createCampagne({
    annee: 2038,
    date_ouverture: '2038-01-01',
    date_limite_declaration: '2038-03-31',
    date_cloture: '2038-04-15',
    relance_j7_courrier: false,
    created_by: adminId,
  });
  openCampagne(campagneId, adminId);

  const result = runRelancesDeclarations({ runDateIso: '2038-03-20', userId: adminId });
  assert.equal(result.campagne_id, campagneId);
  assert.equal(result.niveau, null);

  const relanceNotifs = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM notifications_email WHERE campagne_id = ? AND relance_niveau IS NOT NULL`)
      .get(campagneId) as { c: number }
  ).c;
  assert.equal(relanceNotifs, 0);
});

test('computeRunDateForNiveau calcule les dates correctes pour chaque niveau', () => {
  assert.equal(computeRunDateForNiveau('2034-03-31', 'J-30'), '2034-03-01');
  assert.equal(computeRunDateForNiveau('2034-03-31', 'J-15'), '2034-03-16');
  assert.equal(computeRunDateForNiveau('2034-03-31', 'J-7'), '2034-03-24');
});

test('runRelancesDeclarations retourne campagne_id=0 si aucune campagne active', () => {
  resetTables();
  const result = runRelancesDeclarations({ runDateIso: '2099-01-01' });
  assert.equal(result.campagne_id, 0);
  assert.equal(result.annee, 0);
  assert.equal(result.niveau, null);
  assert.equal(result.total_eligibles, 0);
});

test('runRelancesDeclarations en mode mock-failure comptabilise les echecs', () => {
  resetTables();
  const prevMode = process.env.TLPE_EMAIL_DELIVERY_MODE;
  process.env.TLPE_EMAIL_DELIVERY_MODE = 'mock-failure';

  try {
    const adminId = seedAdmin('admin-fail@tlpe.local');
    const annee = 2039;
    seedAssujetti('TLPE-REL-FAIL', 'fail@example.fr');

    const campagneId = createCampagne({
      annee,
      date_ouverture: '2039-01-01',
      date_limite_declaration: '2039-03-31',
      date_cloture: '2039-04-15',
      relance_j7_courrier: false,
      created_by: adminId,
    });
    openCampagne(campagneId, adminId);

    const runDate = computeRunDateForNiveau('2039-03-31', 'J-30');
    const result = runRelancesDeclarations({ runDateIso: runDate, userId: adminId });

    assert.equal(result.niveau, 'J-30');
    assert.equal(result.total_eligibles, 1);
    assert.equal(result.sent, 0);
    assert.equal(result.failed, 1);

    const notif = db
      .prepare('SELECT statut, erreur FROM notifications_email WHERE campagne_id = ? LIMIT 1')
      .get(campagneId) as { statut: string; erreur: string } | undefined;
    assert.ok(notif);
    assert.equal(notif!.statut, 'echec');
    assert.ok(notif!.erreur?.includes('mock-failure'));
  } finally {
    process.env.TLPE_EMAIL_DELIVERY_MODE = prevMode;
  }
});
