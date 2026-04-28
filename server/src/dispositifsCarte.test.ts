import test from 'node:test';
import assert from 'node:assert/strict';
import { db, initSchema } from './db';

function resetTables() {
  initSchema();
  db.exec('DELETE FROM notifications_email');
  db.exec('DELETE FROM invitation_magic_links');
  db.exec('DELETE FROM campagne_jobs');
  db.exec('DELETE FROM mises_en_demeure');
  db.exec('DELETE FROM campagnes');
  db.exec('DELETE FROM paiements');
  db.exec('DELETE FROM titres');
  db.exec('DELETE FROM lignes_declaration');
  db.exec('DELETE FROM declarations');
  db.exec('DELETE FROM pieces_jointes');
  db.exec('DELETE FROM contentieux');
  db.exec('DELETE FROM controles');
  db.exec('DELETE FROM dispositifs');
  db.exec('DELETE FROM assujettis');
  db.exec('DELETE FROM types_dispositifs');
  db.exec('DELETE FROM zones');
  db.exec('DELETE FROM audit_log');
  db.exec('DELETE FROM users');
}

function seedBase() {
  const assujettiA = Number(
    db
      .prepare("INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES ('TLPE-2026-00001', 'Alpha', 'actif')")
      .run().lastInsertRowid,
  );
  const assujettiB = Number(
    db
      .prepare("INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES ('TLPE-2026-00002', 'Beta', 'actif')")
      .run().lastInsertRowid,
  );

  const typeId = Number(
    db
      .prepare("INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('ENS-PLAT', 'Enseigne', 'enseigne')")
      .run().lastInsertRowid,
  );

  const zoneA = Number(
    db
      .prepare("INSERT INTO zones (code, libelle, coefficient) VALUES ('ZA', 'Zone A', 1.2)")
      .run().lastInsertRowid,
  );
  const zoneB = Number(
    db
      .prepare("INSERT INTO zones (code, libelle, coefficient) VALUES ('ZB', 'Zone B', 0.8)")
      .run().lastInsertRowid,
  );

  const dsp1 = Number(
    db
      .prepare(
        `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, zone_id, latitude, longitude, surface, nombre_faces, statut)
         VALUES ('DSP-1', ?, ?, ?, 48.85, 2.35, 8, 1, 'declare')`,
      )
      .run(assujettiA, typeId, zoneA).lastInsertRowid,
  );

  const dsp2 = Number(
    db
      .prepare(
        `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, zone_id, latitude, longitude, surface, nombre_faces, statut)
         VALUES ('DSP-2', ?, ?, ?, 48.86, 2.36, 12, 2, 'litigieux')`,
      )
      .run(assujettiB, typeId, zoneB).lastInsertRowid,
  );

  const decl2025 = Number(
    db
      .prepare(
        `INSERT INTO declarations (numero, assujetti_id, annee, statut)
         VALUES ('DEC-2025-1', ?, 2025, 'soumise')`,
      )
      .run(assujettiA).lastInsertRowid,
  );
  db.prepare('INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces) VALUES (?, ?, 8, 1)').run(
    decl2025,
    dsp1,
  );

  const decl2026 = Number(
    db
      .prepare(
        `INSERT INTO declarations (numero, assujetti_id, annee, statut)
         VALUES ('DEC-2026-1', ?, 2026, 'soumise')`,
      )
      .run(assujettiB).lastInsertRowid,
  );
  db.prepare('INSERT INTO lignes_declaration (declaration_id, dispositif_id, surface_declaree, nombre_faces) VALUES (?, ?, 12, 2)').run(
    decl2026,
    dsp2,
  );

  return { zoneA, zoneB, typeId, dsp1, dsp2 };
}

test.afterEach(() => {
  resetTables();
});

test('filtres cartes: zone/type/annee retournent le sous-ensemble attendu', () => {
  resetTables();
  const { zoneA, typeId } = seedBase();

  const byZone = db
    .prepare(
      `SELECT d.id
       FROM dispositifs d
       WHERE d.zone_id = ?
       ORDER BY d.id`,
    )
    .all(zoneA) as Array<{ id: number }>;
  assert.equal(byZone.length, 1);

  const byType = db
    .prepare(
      `SELECT d.id
       FROM dispositifs d
       WHERE d.type_id = ?
       ORDER BY d.id`,
    )
    .all(typeId) as Array<{ id: number }>;
  assert.equal(byType.length, 2);

  const byYear = db
    .prepare(
      `SELECT d.id
       FROM dispositifs d
       WHERE EXISTS (
         SELECT 1
         FROM lignes_declaration ld
         JOIN declarations dec ON dec.id = ld.declaration_id
         WHERE ld.dispositif_id = d.id
           AND dec.annee = ?
       )
       ORDER BY d.id`,
    )
    .all(2025) as Array<{ id: number }>;
  assert.equal(byYear.length, 1);
});

test('liste des années pour carte: distinct et tri DESC', () => {
  resetTables();
  seedBase();

  const rows = db
    .prepare(
      `SELECT DISTINCT dec.annee
       FROM declarations dec
       ORDER BY dec.annee DESC`,
    )
    .all() as Array<{ annee: number }>;

  assert.deepEqual(rows.map((r) => r.annee), [2026, 2025]);
});
