// Seed initial : bareme 2024, zones, types, utilisateurs demo et donnees test.
import { db, initSchema } from './db';
import { hashPassword } from './auth';

initSchema();

function seedZones() {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM zones').get() as { c: number }).c;
  if (count > 0) return;
  const stmt = db.prepare('INSERT INTO zones (code, libelle, coefficient, description) VALUES (?, ?, ?, ?)');
  stmt.run('ZC', 'Zone centrale / commerciale', 1.5, 'Hypercentre a forte visibilite');
  stmt.run('ZS', 'Zone standard', 1.0, 'Reste de la commune');
  stmt.run('ZP', 'Zone peripherique', 0.8, 'Zones pavillonnaires peripheriques');
}

function seedTypes() {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM types_dispositifs').get() as { c: number }).c;
  if (count > 0) return;
  const stmt = db.prepare('INSERT INTO types_dispositifs (code, libelle, categorie) VALUES (?, ?, ?)');
  // Publicitaires
  stmt.run('PUB-PAPIER', 'Affichage papier', 'publicitaire');
  stmt.run('PUB-LED', 'Affichage numerique / LED', 'publicitaire');
  stmt.run('PUB-MU', 'Mobilier urbain', 'publicitaire');
  stmt.run('PUB-BACHE', 'Toiles et baches', 'publicitaire');
  stmt.run('PUB-VEHICULE', 'Vehicule publicitaire', 'publicitaire');
  // Preenseignes
  stmt.run('PRE-DEROG', 'Preenseigne derogatoire', 'preenseigne');
  stmt.run('PRE-BATI', 'Preenseigne sur bati', 'preenseigne');
  // Enseignes
  stmt.run('ENS-PLAT', 'Enseigne a plat (facade)', 'enseigne');
  stmt.run('ENS-DRAP', 'Enseigne en drapeau', 'enseigne');
  stmt.run('ENS-LUM', 'Enseigne lumineuse', 'enseigne');
  stmt.run('ENS-TOIT', 'Enseigne sur toiture', 'enseigne');
}

function seedBareme() {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM baremes WHERE annee = 2024').get() as { c: number }).c;
  if (count > 0) return;
  const stmt = db.prepare(
    `INSERT INTO baremes (annee, categorie, surface_min, surface_max, tarif_m2, tarif_fixe, exonere, libelle)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Publicitaire (3 tranches)
  stmt.run(2024, 'publicitaire', 0, 8, 15.5, null, 0, 'Dispositif publicitaire <= 8 m2');
  stmt.run(2024, 'publicitaire', 8, 50, 31, null, 0, 'Dispositif publicitaire 8-50 m2');
  stmt.run(2024, 'publicitaire', 50, null, 62, null, 0, 'Dispositif publicitaire > 50 m2');
  // Preenseignes
  stmt.run(2024, 'preenseigne', 0, 1.5, 6.2, null, 0, 'Preenseigne <= 1,5 m2');
  stmt.run(2024, 'preenseigne', 1.5, null, 15.5, null, 0, 'Preenseigne > 1,5 m2');
  // Enseignes
  stmt.run(2024, 'enseigne', 0, 7, null, null, 1, 'Enseigne <= 7 m2 (exoneree)');
  stmt.run(2024, 'enseigne', 7, 12, null, 75, 0, 'Enseigne 7-12 m2 (forfait 75 EUR)');
  stmt.run(2024, 'enseigne', 12, null, 15.5, null, 0, 'Enseigne > 12 m2');

  // Bareme 2025 (revalorisation indicative +2%)
  stmt.run(2025, 'publicitaire', 0, 8, 15.81, null, 0, 'Dispositif publicitaire <= 8 m2 (2025)');
  stmt.run(2025, 'publicitaire', 8, 50, 31.62, null, 0, 'Dispositif publicitaire 8-50 m2 (2025)');
  stmt.run(2025, 'publicitaire', 50, null, 63.24, null, 0, 'Dispositif publicitaire > 50 m2 (2025)');
  stmt.run(2025, 'preenseigne', 0, 1.5, 6.32, null, 0, 'Preenseigne <= 1,5 m2 (2025)');
  stmt.run(2025, 'preenseigne', 1.5, null, 15.81, null, 0, 'Preenseigne > 1,5 m2 (2025)');
  stmt.run(2025, 'enseigne', 0, 7, null, null, 1, 'Enseigne <= 7 m2 exoneree (2025)');
  stmt.run(2025, 'enseigne', 7, 12, null, 76.5, 0, 'Enseigne 7-12 m2 forfait (2025)');
  stmt.run(2025, 'enseigne', 12, null, 15.81, null, 0, 'Enseigne > 12 m2 (2025)');
}

function seedExonerations() {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM exonerations').get() as { c: number }).c;
  if (count > 0) return;

  const stmt = db.prepare(
    `INSERT INTO exonerations (type, critere, taux, date_debut, date_fin, active)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  // Exoneration de droit (spec §3.4)
  stmt.run('droit', JSON.stringify({ categorie: 'enseigne', surface_max: 7 }), 1, null, null, 1);
  // Exemple d'abattement delibere de 25%
  stmt.run('deliberee', JSON.stringify({ categorie: 'preenseigne', surface_max: 1.5 }), 0.25, null, null, 1);
  // Exemple eco-responsable 10%
  stmt.run('eco', JSON.stringify({ categorie: 'publicitaire', coefficient_zone_max: 1 }), 0.1, null, null, 1);
}

function seedUsers() {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  if (count > 0) return;
  const stmt = db.prepare(
    `INSERT INTO users (
      email,
      password_hash,
      nom,
      prenom,
      role,
      assujetti_id,
      two_factor_enabled,
      two_factor_secret_encrypted,
      two_factor_pending_secret_encrypted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run('admin@tlpe.local', hashPassword('admin123'), 'Admin', 'Systeme', 'admin', null, 0, null, null);
  stmt.run('gestionnaire@tlpe.local', hashPassword('gestion123'), 'Martin', 'Claire', 'gestionnaire', null, 0, null, null);
  stmt.run('financier@tlpe.local', hashPassword('finance123'), 'Dubois', 'Paul', 'financier', null, 0, null, null);
  stmt.run('controleur@tlpe.local', hashPassword('controle123'), 'Leroy', 'Sophie', 'controleur', null, 0, null, null);
}

function seedDonneesDemo() {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM assujettis').get() as { c: number }).c;
  if (count > 0) return;

  const insAssujetti = db.prepare(
    `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, siret, forme_juridique,
       adresse_rue, adresse_cp, adresse_ville,
       contact_nom, contact_prenom, email, telephone, statut)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'actif')`,
  );
  const a1 = insAssujetti.run(
    'TLPE-2024-00001',
    'Boulangerie du Centre SARL',
    '73282932000074',
    'SARL',
    '12 place du Marche',
    '75001',
    'Paris',
    'Durand',
    'Marie',
    'contact@boulangerie-centre.fr',
    '0142000000',
  );
  const a2 = insAssujetti.run(
    'TLPE-2024-00002',
    'Media Affichage National SA',
    '80295478200015',
    'SA',
    '45 rue de la Publicite',
    '92100',
    'Boulogne',
    'Moreau',
    'Pierre',
    'contact@mediaaffichage.fr',
    '0145000000',
  );
  const a3 = insAssujetti.run(
    'TLPE-2024-00003',
    'Supermarche Bellevue',
    '38792100400027',
    'SAS',
    '88 avenue des Champs',
    '75008',
    'Paris',
    'Petit',
    'Julie',
    'direction@bellevue.fr',
    '0156000000',
  );

  // Creation d'un compte contribuable lie a a1
  db.prepare(
    `INSERT INTO users (
      email,
      password_hash,
      nom,
      prenom,
      role,
      assujetti_id,
      two_factor_enabled,
      two_factor_secret_encrypted,
      two_factor_pending_secret_encrypted
    ) VALUES (?, ?, ?, ?, 'contribuable', ?, 0, NULL, NULL)`,
  ).run(
    'contribuable@tlpe.local',
    hashPassword('contrib123'),
    'Durand',
    'Marie',
    Number(a1.lastInsertRowid),
  );

  const zonesAll = db.prepare('SELECT id, code FROM zones').all() as Array<{ id: number; code: string }>;
  const typesAll = db.prepare('SELECT id, code FROM types_dispositifs').all() as Array<{ id: number; code: string }>;
  const byType = Object.fromEntries(typesAll.map((t) => [t.code, t.id]));
  const byZone = Object.fromEntries(zonesAll.map((z) => [z.code, z.id]));

  const insDsp = db.prepare(
    `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, zone_id,
       adresse_rue, adresse_cp, adresse_ville, latitude, longitude,
       surface, nombre_faces, date_pose, statut)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'declare')`,
  );
  // Dispositifs pour la boulangerie
  insDsp.run('DSP-2024-000001', a1.lastInsertRowid, byType['ENS-PLAT'], byZone['ZC'], '12 place du Marche', '75001', 'Paris', 48.8606, 2.3376, 4.5, 1, '2020-01-15');
  insDsp.run('DSP-2024-000002', a1.lastInsertRowid, byType['ENS-DRAP'], byZone['ZC'], '12 place du Marche', '75001', 'Paris', 48.8606, 2.3376, 0.8, 2, '2021-06-01');
  // Dispositifs afficheur
  insDsp.run('DSP-2024-000003', a2.lastInsertRowid, byType['PUB-PAPIER'], byZone['ZC'], 'Boulevard Saint-Germain', '75006', 'Paris', 48.853, 2.333, 8, 2, '2019-03-01');
  insDsp.run('DSP-2024-000004', a2.lastInsertRowid, byType['PUB-LED'], byZone['ZC'], 'Place de la Nation', '75011', 'Paris', 48.848, 2.398, 12, 1, '2022-09-01');
  insDsp.run('DSP-2024-000005', a2.lastInsertRowid, byType['PUB-PAPIER'], byZone['ZS'], 'Rue de Vaugirard', '75015', 'Paris', 48.842, 2.30, 4, 2, '2020-01-01');
  // Dispositifs supermarche
  insDsp.run('DSP-2024-000006', a3.lastInsertRowid, byType['ENS-LUM'], byZone['ZC'], '88 avenue des Champs', '75008', 'Paris', 48.8696, 2.307, 20, 1, '2018-01-01');
  insDsp.run('DSP-2024-000007', a3.lastInsertRowid, byType['ENS-TOIT'], byZone['ZC'], '88 avenue des Champs', '75008', 'Paris', 48.8696, 2.307, 35, 2, '2018-01-01');
}

seedZones();
seedTypes();
seedBareme();
seedExonerations();
seedUsers();
seedDonneesDemo();

// eslint-disable-next-line no-console
console.log('[TLPE] Seed termine. Comptes demo :');
// eslint-disable-next-line no-console
console.log('  admin@tlpe.local / admin123');
// eslint-disable-next-line no-console
console.log('  gestionnaire@tlpe.local / gestion123');
// eslint-disable-next-line no-console
console.log('  financier@tlpe.local / finance123');
// eslint-disable-next-line no-console
console.log('  controleur@tlpe.local / controle123');
// eslint-disable-next-line no-console
console.log('  contribuable@tlpe.local / contrib123');
