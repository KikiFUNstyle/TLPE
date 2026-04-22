import test from 'node:test';
import assert from 'node:assert/strict';
import { db, initSchema } from './db';
import { activateBaremesForYear, getActiveBaremeYear, parseBaremesCsv, upsertBaremes } from './baremes';
import { findBareme } from './calculator';

function resetTables() {
  initSchema();
  db.exec('DELETE FROM baremes');
  db.exec('DELETE FROM bareme_activation');
  db.exec('DELETE FROM audit_log');
  db.exec('DELETE FROM users');
}

function createAdminUser(): number {
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('admin-test@tlpe.local', 'hash', 'Admin', 'Test', 'admin', 1);
  return Number(info.lastInsertRowid);
}

function seedBareme2025() {
  const stmt = db.prepare(
    `INSERT INTO baremes (annee, categorie, surface_min, surface_max, tarif_m2, tarif_fixe, exonere, libelle)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(2025, 'publicitaire', 0, 8, 16, null, 0, 'Publicitaire <= 8 m2');
  stmt.run(2025, 'publicitaire', 8, 50, 32, null, 0, 'Publicitaire 8-50 m2');
}

test('parseBaremesCsv - parse virgule et point-virgule', () => {
  resetTables();
  const csvSemicolon = [
    'annee;categorie;surface_min;surface_max;tarif_m2;tarif_fixe;exonere;libelle',
    '2026;publicitaire;0;8;15.5;;0;Publicitaire <= 8 m2',
  ].join('\n');

  const csvComma = [
    'annee,categorie,surface_min,surface_max,tarif_m2,tarif_fixe,exonere,libelle',
    '2026,enseigne,7,12,,75,0,Enseigne 7-12 m2 (forfait)',
  ].join('\n');

  const a = parseBaremesCsv(csvSemicolon);
  const b = parseBaremesCsv(csvComma);

  assert.equal(a[0].annee, 2026);
  assert.equal(a[0].categorie, 'publicitaire');
  assert.equal(a[0].tarif_m2, 15.5);

  assert.equal(b[0].categorie, 'enseigne');
  assert.equal(b[0].tarif_fixe, 75);
});

test('parseBaremesCsv - rejette les tarifs negatifs', () => {
  resetTables();
  const badCsv = [
    'annee,categorie,surface_min,surface_max,tarif_m2,tarif_fixe,exonere,libelle',
    '2026,publicitaire,0,8,-1,,0,Publicitaire <= 8 m2',
  ].join('\n');

  assert.throws(() => parseBaremesCsv(badCsv), /tarif_m2 invalide/);
});

test('parseBaremesCsv - rejette si surface_max absente', () => {
  resetTables();
  const badCsv = [
    'annee,categorie,surface_min,tarif_m2,tarif_fixe,exonere,libelle',
    '2026,publicitaire,0,15.5,,0,Publicitaire <= 8 m2',
  ].join('\n');

  assert.throws(() => parseBaremesCsv(badCsv), /colonne manquante "surface_max"/);
});

test('parseBaremesCsv - rejette si exonere absent', () => {
  resetTables();
  const badCsv = [
    'annee,categorie,surface_min,surface_max,tarif_m2,tarif_fixe,libelle',
    '2026,publicitaire,0,8,15.5,,Publicitaire <= 8 m2',
  ].join('\n');

  assert.throws(() => parseBaremesCsv(badCsv), /colonne manquante "exonere"/);
});

test('parseBaremesCsv - rejette si exonere invalide', () => {
  resetTables();
  const badCsv = [
    'annee,categorie,surface_min,surface_max,tarif_m2,tarif_fixe,exonere,libelle',
    '2026,publicitaire,0,8,15.5,,peut-etre,Publicitaire <= 8 m2',
  ].join('\n');

  assert.throws(() => parseBaremesCsv(badCsv), /Ligne 2: exonere invalide: peut-etre/);
});

test('upsertBaremes - cree puis met a jour avec audit', () => {
  resetTables();

  const adminId = createAdminUser();

  const first = upsertBaremes(
    [
      {
        annee: 2026,
        categorie: 'publicitaire',
        surface_min: 0,
        surface_max: 8,
        tarif_m2: 15.5,
        tarif_fixe: null,
        exonere: false,
        libelle: 'Publicitaire <= 8 m2',
      },
    ],
    adminId,
  );

  const second = upsertBaremes(
    [
      {
        annee: 2026,
        categorie: 'publicitaire',
        surface_min: 0,
        surface_max: 8,
        tarif_m2: 16,
        tarif_fixe: null,
        exonere: false,
        libelle: 'Publicitaire <= 8 m2 revalorise',
      },
    ],
    adminId,
  );

  assert.deepEqual(first, { total: 1, created: 1, updated: 0 });
  assert.deepEqual(second, { total: 1, created: 0, updated: 1 });

  const row = db.prepare('SELECT tarif_m2, libelle FROM baremes WHERE annee = 2026').get() as { tarif_m2: number; libelle: string };
  assert.equal(row.tarif_m2, 16);
  assert.equal(row.libelle, 'Publicitaire <= 8 m2 revalorise');

  const auditCount = (db.prepare('SELECT COUNT(*) AS c FROM audit_log WHERE entite = ?').get('bareme') as { c: number }).c;
  assert.equal(auditCount, 2);
});

test('activateBaremesForYear - active une annee existante une seule fois', () => {
  resetTables();
  seedBareme2025();

  const first = activateBaremesForYear(2025, '2025-01-01T00:00:00.000Z');
  const second = activateBaremesForYear(2025, '2025-01-01T00:00:00.000Z');

  assert.equal(first, true);
  assert.equal(second, false);

  const activationCount = (db.prepare('SELECT COUNT(*) AS c FROM bareme_activation WHERE annee = 2025').get() as { c: number }).c;
  assert.equal(activationCount, 1);
});

test('findBareme - prend le bareme le plus recent <= annee (antidatage)', () => {
  resetTables();

  const stmt = db.prepare(
    `INSERT INTO baremes (annee, categorie, surface_min, surface_max, tarif_m2, tarif_fixe, exonere, libelle)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(2024, 'publicitaire', 0, 8, 15.5, null, 0, 'Publicitaire <= 8 m2 (2024)');
  stmt.run(2026, 'publicitaire', 0, 8, 16.2, null, 0, 'Publicitaire <= 8 m2 (2026)');

  const from2025 = findBareme(2025, 'publicitaire', 4);
  const from2026 = findBareme(2026, 'publicitaire', 4);

  assert.ok(from2025);
  assert.ok(from2026);
  assert.equal(from2025?.annee, 2024);
  assert.equal(from2026?.annee, 2026);
});

test('getActiveBaremeYear - priorise une annee activee', () => {
  resetTables();

  const stmt = db.prepare(
    `INSERT INTO baremes (annee, categorie, surface_min, surface_max, tarif_m2, tarif_fixe, exonere, libelle)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  stmt.run(2025, 'publicitaire', 0, 8, 16, null, 0, 'Publicitaire <= 8 m2 (2025)');
  stmt.run(2026, 'publicitaire', 0, 8, 17, null, 0, 'Publicitaire <= 8 m2 (2026)');

  activateBaremesForYear(2025, '2025-01-01T00:00:00.000Z');

  const active = getActiveBaremeYear(new Date('2026-06-01T00:00:00.000Z'));
  assert.equal(active, 2025);
});
