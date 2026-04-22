import test from 'node:test';
import assert from 'node:assert/strict';
import { db, initSchema } from './db';
import { calculerTLPE, computeProrata } from './calculator';

// Bareme de test (valeurs indicatives 2024 du document de specs)
function seedTestBareme() {
  db.exec('DELETE FROM baremes');
  db.exec('DELETE FROM exonerations');
  const stmt = db.prepare(
    `INSERT INTO baremes (annee, categorie, surface_min, surface_max, tarif_m2, tarif_fixe, exonere, libelle)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(2024, 'publicitaire', 0, 8, 15.5, null, 0, 'Publicitaire <= 8 m2');
  stmt.run(2024, 'publicitaire', 8, 50, 31, null, 0, 'Publicitaire 8-50 m2');
  stmt.run(2024, 'publicitaire', 50, null, 62, null, 0, 'Publicitaire > 50 m2');
  stmt.run(2024, 'preenseigne', 0, 1.5, 6.2, null, 0, 'Preenseigne <= 1,5 m2');
  stmt.run(2024, 'preenseigne', 1.5, null, 15.5, null, 0, 'Preenseigne > 1,5 m2');
  stmt.run(2024, 'enseigne', 0, 7, null, null, 1, 'Enseigne <= 7 m2 (exoneree)');
  stmt.run(2024, 'enseigne', 7, 12, null, 75, 0, 'Enseigne 7-12 m2 (forfait)');
  stmt.run(2024, 'enseigne', 12, null, 15.5, null, 0, 'Enseigne > 12 m2');
}

test('setup - init schema + seed bareme', () => {
  initSchema();
  seedTestBareme();
});

test('publicitaire 4m2 simple face', () => {
  const r = calculerTLPE({ annee: 2024, categorie: 'publicitaire', surface: 4 });
  // 4 x 15.5 x 1 x 1 = 62 -> arrondi euro inferieur = 62
  assert.equal(r.montant, 62);
  assert.equal(r.detail.tarif_m2, 15.5);
});

test('publicitaire 4m2 double face -> surface effective 8 reste dans <=8m2', () => {
  const r = calculerTLPE({
    annee: 2024,
    categorie: 'publicitaire',
    surface: 4,
    nombre_faces: 2,
  });
  // surface effective = 8, tranche <=8m2 -> 8 x 15.5 = 124
  assert.equal(r.detail.surface_effective, 8);
  assert.equal(r.montant, 124);
});

test('publicitaire 10m2 -> tranche 8-50', () => {
  const r = calculerTLPE({ annee: 2024, categorie: 'publicitaire', surface: 10 });
  // 10 x 31 = 310
  assert.equal(r.detail.tarif_m2, 31);
  assert.equal(r.montant, 310);
});

test('publicitaire 60m2 -> tranche > 50', () => {
  const r = calculerTLPE({ annee: 2024, categorie: 'publicitaire', surface: 60 });
  // 60 x 62 = 3720
  assert.equal(r.detail.tarif_m2, 62);
  assert.equal(r.montant, 3720);
});

test('enseigne 5m2 -> exoneree', () => {
  const r = calculerTLPE({ annee: 2024, categorie: 'enseigne', surface: 5 });
  assert.equal(r.montant, 0);
  assert.equal(r.detail.exonere, true);
});

test('enseigne 10m2 -> tarif fixe 75', () => {
  const r = calculerTLPE({ annee: 2024, categorie: 'enseigne', surface: 10 });
  assert.equal(r.detail.tarif_fixe, 75);
  assert.equal(r.montant, 75);
});

test('enseigne 15m2 -> tranche >12', () => {
  const r = calculerTLPE({ annee: 2024, categorie: 'enseigne', surface: 15 });
  // 15 x 15.5 = 232.5 -> floor = 232
  assert.equal(r.montant, 232);
});

test('coefficient zone applique', () => {
  const r = calculerTLPE({
    annee: 2024,
    categorie: 'publicitaire',
    surface: 4,
    coefficient_zone: 2,
  });
  // 4 x 15.5 x 2 = 124
  assert.equal(r.montant, 124);
});

test('prorata temporis - pose en avril', () => {
  const { jours, prorata } = computeProrata(2024, '2024-04-01', null);
  // avril = jour 92 -> du 01/04 au 31/12 = 275 jours
  assert.ok(jours >= 270 && jours <= 280, `jours=${jours}`);
  assert.ok(prorata > 0.7 && prorata < 0.8);
});

test('prorata temporis - depose avant debut = 0', () => {
  const { jours, prorata } = computeProrata(2024, '2024-06-01', '2024-05-01');
  assert.equal(jours, 0);
  assert.equal(prorata, 0);
});

test('exoneration explicite -> montant 0 sans recherche bareme', () => {
  const r = calculerTLPE({
    annee: 2024,
    categorie: 'publicitaire',
    surface: 100,
    exonere: true,
  });
  assert.equal(r.montant, 0);
  assert.equal(r.detail.bareme_id, null);
});

test('abattement delibere 25% applique sur preenseigne <= 1.5m2', () => {
  db.exec('DELETE FROM exonerations');
  db.prepare(
    `INSERT INTO exonerations (type, critere, taux, date_debut, date_fin, active)
     VALUES (?, ?, ?, ?, ?, 1)`,
  ).run('deliberee', JSON.stringify({ categorie: 'preenseigne', surface_max: 1.5 }), 0.25, null, null);

  const r = calculerTLPE({ annee: 2024, categorie: 'preenseigne', surface: 1 });
  // 1 * 6.2 = 6.2 -> -25% = 4.65 -> floor = 4
  assert.equal(r.montant, 4);
  assert.equal(r.detail.sous_total, 4.65);
});

test('exoneration de droit 100% appliquee via table exonerations', () => {
  db.exec('DELETE FROM exonerations');
  db.prepare(
    `INSERT INTO exonerations (type, critere, taux, date_debut, date_fin, active)
     VALUES (?, ?, ?, ?, ?, 1)`,
  ).run('droit', JSON.stringify({ categorie: 'publicitaire', surface_max: 8 }), 1, null, null);

  const r = calculerTLPE({ annee: 2024, categorie: 'publicitaire', surface: 4 });
  assert.equal(r.montant, 0);
  assert.equal(r.detail.exonere, true);
});

test('exoneration ciblee par assujetti_id uniquement', () => {
  db.exec('DELETE FROM exonerations');
  db.prepare(
    `INSERT INTO exonerations (type, critere, taux, date_debut, date_fin, active)
     VALUES (?, ?, ?, ?, ?, 1)`,
  ).run('eco', JSON.stringify({ assujetti_id: 999 }), 0.1, null, null);

  const sansMatch = calculerTLPE({ annee: 2024, categorie: 'publicitaire', surface: 4, assujetti_id: 1 });
  const avecMatch = calculerTLPE({ annee: 2024, categorie: 'publicitaire', surface: 4, assujetti_id: 999 });

  assert.equal(sansMatch.montant, 62);
  assert.equal(avecMatch.montant, 55);
});
