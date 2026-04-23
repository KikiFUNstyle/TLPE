import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { db, initSchema } from './db';
import {
  decodeDispositifsImportFile,
  executeDispositifsImport,
  type RawDispositifImportRow,
  validateDispositifsImportRows,
} from './dispositifsImport';

function resetTables() {
  initSchema();
  db.exec('DELETE FROM notifications_email');
  db.exec('DELETE FROM invitation_magic_links');
  db.exec('DELETE FROM campagne_jobs');
  db.exec('DELETE FROM mises_en_demeure');
  db.exec('DELETE FROM campagnes');
  db.exec('DELETE FROM pieces_jointes');
  db.exec('DELETE FROM paiements');
  db.exec('DELETE FROM contentieux');
  db.exec('DELETE FROM titres');
  db.exec('DELETE FROM lignes_declaration');
  db.exec('DELETE FROM declarations');
  db.exec('DELETE FROM dispositifs');
  db.exec('DELETE FROM assujettis');
  db.exec('DELETE FROM types_dispositifs');
  db.exec('DELETE FROM zones');
  db.exec('DELETE FROM audit_log');
  db.exec('DELETE FROM users');
}

function seedReferentiels() {
  db.prepare('INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES (?, ?, ?)').run('TLPE-2026-00001', 'Societe Alpha', 'actif');
  db.prepare('INSERT INTO assujettis (identifiant_tlpe, raison_sociale, statut) VALUES (?, ?, ?)').run('TLPE-2026-00002', 'Societe Beta', 'actif');

  db.prepare('INSERT INTO types_dispositifs (code, libelle, categorie) VALUES (?, ?, ?)').run('PUB-PAPIER', 'Affichage papier', 'publicitaire');
  db.prepare('INSERT INTO types_dispositifs (code, libelle, categorie) VALUES (?, ?, ?)').run('ENS-PLAT', 'Enseigne a plat', 'enseigne');

  db.prepare('INSERT INTO zones (code, libelle, coefficient, geometry) VALUES (?, ?, ?, ?)').run(
    'ZC',
    'Zone centrale',
    1.5,
    JSON.stringify({
      type: 'Polygon',
      coordinates: [[[2, 48], [2.2, 48], [2.2, 48.2], [2, 48.2], [2, 48]]],
    }),
  );
}

function createAdminUser(): number {
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('admin-dispositifs-import@tlpe.local', 'hash', 'Admin', 'Import', 'admin', 1);
  return Number(info.lastInsertRowid);
}

function base64Csv(content: string): string {
  return Buffer.from(content, 'utf-8').toString('base64');
}

function base64Xlsx(rows: Array<Record<string, string>>): string {
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Import');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return Buffer.from(buffer).toString('base64');
}

test.afterEach(() => {
  resetTables();
});

test('decodeDispositifsImportFile - decode CSV et XLSX', () => {
  resetTables();
  seedReferentiels();

  const csv = [
    'identifiant_assujetti,type_code,adresse,lat,lon,surface,faces,date_pose,zone_code,statut',
    'TLPE-2026-00001,PUB-PAPIER,12 rue de la Paix,48.8566,2.3522,8,2,2026-02-01,ZC,declare',
  ].join('\n');

  const csvRows = decodeDispositifsImportFile('dispositifs.csv', base64Csv(csv));
  assert.equal(csvRows.length, 1);
  assert.equal(csvRows[0].type_code, 'PUB-PAPIER');

  const xlsxRows = decodeDispositifsImportFile(
    'dispositifs.xlsx',
    base64Xlsx([
      {
        identifiant_assujetti: 'TLPE-2026-00001',
        type_code: 'ENS-PLAT',
        adresse: '5 avenue des Champs',
        lat: '48.86',
        lon: '2.30',
        surface: '4',
        faces: '1',
        date_pose: '2026-01-10',
        zone_code: 'ZC',
        statut: 'declare',
      },
    ]),
  );

  assert.equal(xlsxRows.length, 1);
  assert.equal(xlsxRows[0].type_code, 'ENS-PLAT');
});

test('validateDispositifsImportRows - detecte anomalies et valide ligne correcte', async () => {
  resetTables();
  seedReferentiels();

  const rows: RawDispositifImportRow[] = [
    {
      line: 2,
      identifiant_assujetti: 'TLPE-2026-00001',
      type_code: 'PUB-PAPIER',
      adresse: '12 rue de la Paix',
      lat: '48.1',
      lon: '2.1',
      surface: '5',
      faces: '2',
      date_pose: '2026-01-01',
      zone_code: 'ZC',
      statut: 'declare',
    },
    {
      line: 3,
      identifiant_assujetti: 'INCONNU',
      type_code: '???',
      adresse: '',
      lat: '48.1',
      lon: '',
      surface: '0',
      faces: '6',
      date_pose: '01-01-2026',
      zone_code: 'BAD',
      statut: 'invalid',
    },
  ];

  const result = await validateDispositifsImportRows(rows);
  assert.equal(result.total, 2);
  assert.equal(result.validRows.length, 1);
  assert.ok(result.anomalies.length >= 6);
  assert.ok(result.anomalies.some((a) => a.field === 'identifiant_assujetti'));
  assert.ok(result.anomalies.some((a) => a.field === 'type_code'));
  assert.ok(result.anomalies.some((a) => a.field === 'surface'));
});

test('validateDispositifsImportRows - conserve les complements d\'adresse avant CP/ville', async () => {
  resetTables();
  seedReferentiels();

  const rows: RawDispositifImportRow[] = [
    {
      line: 2,
      identifiant_assujetti: 'TLPE-2026-00001',
      type_code: 'PUB-PAPIER',
      adresse: '12 rue de la Paix, Batiment A, 75001 Paris',
      lat: '',
      lon: '',
      surface: '8',
      faces: '1',
      date_pose: '2026-03-10',
      zone_code: '',
      statut: 'declare',
    },
  ];

  const result = await validateDispositifsImportRows(rows, {
    geocodeWithBan: true,
    geocodeFn: async () => ({ latitude: 48.1, longitude: 2.1 }),
  });

  assert.equal(result.anomalies.length, 0);
  assert.equal(result.validRows.length, 1);
  assert.equal(result.validRows[0].adresse_rue, '12 rue de la Paix, Batiment A');
  assert.equal(result.validRows[0].adresse_cp, '75001');
  assert.equal(result.validRows[0].adresse_ville, 'Paris');
});

test('validateDispositifsImportRows - geocodage BAN optionnel quand lat/lon absents', async () => {
  resetTables();
  seedReferentiels();

  const rows: RawDispositifImportRow[] = [
    {
      line: 2,
      identifiant_assujetti: 'TLPE-2026-00001',
      type_code: 'PUB-PAPIER',
      adresse: 'Adresse test BAN',
      lat: '',
      lon: '',
      surface: '8',
      faces: '1',
      date_pose: '2026-03-10',
      zone_code: '',
      statut: 'declare',
    },
  ];

  const result = await validateDispositifsImportRows(rows, {
    geocodeWithBan: true,
    geocodeFn: async () => ({ latitude: 48.1, longitude: 2.1 }),
  });

  assert.equal(result.anomalies.length, 0);
  assert.equal(result.validRows.length, 1);
  assert.equal(result.validRows[0].zone_id > 0, true);
});

test('validateDispositifsImportRows - rejette une date calendrier impossible', async () => {
  resetTables();
  seedReferentiels();

  const rows: RawDispositifImportRow[] = [
    {
      line: 2,
      identifiant_assujetti: 'TLPE-2026-00001',
      type_code: 'PUB-PAPIER',
      adresse: '12 rue de la Paix',
      lat: '48.1',
      lon: '2.1',
      surface: '5',
      faces: '2',
      date_pose: '2026-02-31',
      zone_code: 'ZC',
      statut: 'declare',
    },
  ];

  const result = await validateDispositifsImportRows(rows);
  assert.equal(result.validRows.length, 0);
  assert.ok(result.anomalies.some((a) => a.field === 'date_pose'));
});

test('executeDispositifsImport - cree des dispositifs et journalise', async () => {
  resetTables();
  seedReferentiels();
  const adminId = createAdminUser();

  const rows: RawDispositifImportRow[] = [
    {
      line: 2,
      identifiant_assujetti: 'TLPE-2026-00001',
      type_code: 'PUB-PAPIER',
      adresse: '12 rue de la Paix',
      lat: '48.1',
      lon: '2.1',
      surface: '9',
      faces: '2',
      date_pose: '2026-01-01',
      zone_code: 'ZC',
      statut: 'declare',
    },
  ];

  const validation = await validateDispositifsImportRows(rows);
  assert.equal(validation.anomalies.length, 0);

  const result = executeDispositifsImport(validation.validRows, adminId);
  assert.deepEqual(result, { total: 1, created: 1, rejected: 0 });

  const created = db.prepare('SELECT identifiant, surface, nombre_faces FROM dispositifs').get() as {
    identifiant: string;
    surface: number;
    nombre_faces: number;
  };
  assert.equal(created.identifiant.startsWith('DSP-'), true);
  assert.equal(created.surface, 9);
  assert.equal(created.nombre_faces, 2);

  const audit = db.prepare('SELECT COUNT(*) AS c FROM audit_log WHERE entite = ? AND action = ?').get('dispositif', 'import') as { c: number };
  assert.equal(audit.c, 1);
});
