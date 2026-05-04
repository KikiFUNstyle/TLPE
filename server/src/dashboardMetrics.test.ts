import test from 'node:test';
import assert from 'node:assert/strict';
import { db, initSchema } from './db';
import { getDashboardMetrics } from './dashboardMetrics';

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
    db.exec('DELETE FROM controles');
  db.exec('DELETE FROM dispositifs');
    db.exec('DELETE FROM notifications_email');
    db.exec('DELETE FROM invitation_magic_links');
    db.exec('DELETE FROM campagne_jobs');
    db.exec('DELETE FROM mises_en_demeure');
    db.exec('DELETE FROM campagnes');
    db.exec('DELETE FROM baremes');
    db.exec('DELETE FROM exonerations');
    db.exec('DELETE FROM types_dispositifs');
    db.exec('DELETE FROM zones');
    db.exec('DELETE FROM audit_log');
    db.exec('DELETE FROM users');
    db.exec('DELETE FROM assujettis');
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function seedUser(email: string, role: 'admin' | 'gestionnaire' | 'financier' | 'controleur' | 'contribuable') {
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES (?, 'hash', 'Nom', 'Prenom', ?, 1)`,
    )
    .run(email, role);
  return Number(info.lastInsertRowid);
}

test.afterEach(() => {
  resetTables();
});

test('getDashboardMetrics calcule KPI, drilldown et evolution journaliere de la campagne active', () => {
  resetTables();

  const adminId = seedUser('admin-dashboard@tlpe.local', 'admin');

  const zoneCentre = Number(
    db.prepare("INSERT INTO zones (code, libelle, coefficient) VALUES ('ZC', 'Zone Centre', 1.5)").run().lastInsertRowid,
  );
  const zonePeri = Number(
    db.prepare("INSERT INTO zones (code, libelle, coefficient) VALUES ('ZP', 'Zone Peri', 0.8)").run().lastInsertRowid,
  );
  const typeEns = Number(
    db.prepare("INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('ENS-PLAT', 'Enseigne', 'enseigne')").run().lastInsertRowid,
  );

  const a1 = Number(
    db
      .prepare(
        `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, forme_juridique, statut)
         VALUES ('TLPE-DASH-1', 'Alpha', 'SARL', 'actif')`,
      )
      .run().lastInsertRowid,
  );
  const a2 = Number(
    db
      .prepare(
        `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, forme_juridique, statut)
         VALUES ('TLPE-DASH-2', 'Beta', 'SAS', 'actif')`,
      )
      .run().lastInsertRowid,
  );
  const a3 = Number(
    db
      .prepare(
        `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, forme_juridique, statut)
         VALUES ('TLPE-DASH-3', 'Gamma', NULL, 'actif')`,
      )
      .run().lastInsertRowid,
  );

  db.prepare(
    `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, zone_id, surface, nombre_faces, statut)
     VALUES ('DSP-D-1', ?, ?, ?, 8, 1, 'declare')`,
  ).run(a1, typeEns, zoneCentre);
  db.prepare(
    `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, zone_id, surface, nombre_faces, statut)
     VALUES ('DSP-D-2', ?, ?, ?, 12, 1, 'declare')`,
  ).run(a2, typeEns, zonePeri);

  const currentYear = new Date().getFullYear();
  db.prepare(
    `INSERT INTO campagnes (annee, date_ouverture, date_limite_declaration, date_cloture, statut, created_by)
     VALUES (?, '2026-01-01', '2026-01-03', '2026-01-31', 'ouverte', ?)`,
  ).run(currentYear, adminId);

  const decl1 = Number(
    db
      .prepare(
    `INSERT INTO declarations (numero, assujetti_id, annee, statut, date_soumission, created_at)
     VALUES ('DEC-DASH-1', ?, ?, 'soumise', '2026-01-01', '2026-01-01T10:00:00.000Z')`,
  )
      .run(a1, currentYear).lastInsertRowid,
  );
  const decl2 = Number(
    db
      .prepare(
    `INSERT INTO declarations (numero, assujetti_id, annee, statut, date_soumission, created_at)
     VALUES ('DEC-DASH-2', ?, ?, 'validee', '2026-01-02', '2026-01-02T11:00:00.000Z')`,
  )
      .run(a2, currentYear).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO declarations (numero, assujetti_id, annee, statut, date_soumission, created_at)
     VALUES ('DEC-DASH-3', ?, ?, 'rejetee', '2026-01-03', '2026-01-03T12:00:00.000Z')`,
  ).run(a3, currentYear);
  const declNm1 = Number(
    db
      .prepare(
    `INSERT INTO declarations (numero, assujetti_id, annee, statut)
     VALUES ('DEC-DASH-NM1', ?, ?, 'soumise')`,
  )
      .run(a1, currentYear - 1).lastInsertRowid,
  );

  const titre1 = Number(
    db
      .prepare(
    `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut, montant_paye)
     VALUES ('T-DASH-1', ?, ?, ?, 1000, '2026-01-15', '2026-01-31', 'paye_partiel', 400)`,
  )
      .run(decl1, a1, currentYear).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut, montant_paye)
     VALUES ('T-DASH-2', ?, ?, ?, 500, '2026-01-15', '2026-01-31', 'emis', 0)`,
  ).run(decl2, a2, currentYear);
  db.prepare(
    `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut, montant_paye)
     VALUES ('T-DASH-NM1', ?, ?, ?, 800, '2025-01-15', '2025-01-31', 'paye', 800)`,
  ).run(declNm1, a1, currentYear - 1);

  db.prepare(
    `INSERT INTO contentieux (numero, titre_id, assujetti_id, type, montant_litige, statut, description)
     VALUES ('CTX-DASH-1', ?, ?, 'contentieux', 250, 'ouvert', 'Erreur assiette')`,
  ).run(titre1, a1);

  const metrics = getDashboardMetrics();

  assert.equal(metrics.annee, currentYear);
  assert.equal(metrics.operationnel.assujettis_actifs, 3);
  assert.equal(metrics.operationnel.declarations_soumises, 1);
  assert.equal(metrics.operationnel.declarations_validees, 1);
  assert.equal(metrics.operationnel.declarations_rejetees, 1);
  assert.equal(metrics.operationnel.declarations_recues, 3);
  assert.equal(metrics.operationnel.declarations_attendues, 3);
  assert.equal(metrics.operationnel.taux_declaration, 1);

  assert.equal(metrics.financier.montant_emis_n, 1500);
  assert.equal(metrics.financier.montant_emis_nm1, 800);
  assert.equal(metrics.financier.montant_recouvre, 400);

  assert.equal(metrics.operationnel.contentieux_ouverts, 1);
  assert.equal(metrics.financier.montant_litige, 250);

  const zoneCentreRow = metrics.drilldown.by_zone.find((r) => r.label === 'Zone Centre');
  assert.ok(zoneCentreRow);
  assert.equal(zoneCentreRow?.assujettis_attendus, 1);
  assert.equal(zoneCentreRow?.declarations_soumises, 1);

  const typeSarl = metrics.drilldown.by_type_assujetti.find((r) => r.label === 'SARL');
  assert.ok(typeSarl);
  assert.equal(typeSarl?.assujettis_attendus, 1);

  assert.equal(metrics.evolution_journaliere.length, 3);
  assert.deepEqual(metrics.evolution_journaliere.map((r) => r.soumissions_jour), [1, 1, 1]);
  assert.deepEqual(metrics.evolution_journaliere.map((r) => r.cumul_soumissions), [1, 2, 3]);
});