import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { db, initSchema } from './db';
import {
  decodeAssujettisImportFile,
  executeAssujettisImport,
  type RawImportRow,
  validateImportRows,
} from './assujettisImport';

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
  db.exec('DELETE FROM controles');
  db.exec('DELETE FROM dispositifs');
  db.exec('DELETE FROM assujettis');
  db.exec('DELETE FROM audit_log');
  db.exec('DELETE FROM users');
}

function createAdminUser(): number {
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('admin-import@tlpe.local', 'hash', 'Admin', 'Import', 'admin', 1);
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

test('decodeAssujettisImportFile - decode CSV et XLSX', () => {
  resetTables();

  const csv = [
    'identifiant_tlpe,raison_sociale,siret,email,portail_actif,statut',
    'TLPE-2026-00001,Alpha,73282932000074,alpha@example.fr,oui,actif',
  ].join('\n');

  const csvRows = decodeAssujettisImportFile('import.csv', base64Csv(csv));
  assert.equal(csvRows.length, 1);
  assert.equal(csvRows[0].raison_sociale, 'Alpha');

  const xlsxRows = decodeAssujettisImportFile(
    'import.xlsx',
    base64Xlsx([
      {
        identifiant_tlpe: 'TLPE-2026-00002',
        raison_sociale: 'Beta',
        siret: '73282932000074',
        email: 'beta@example.fr',
        portail_actif: 'non',
        statut: 'actif',
      },
    ]),
  );

  assert.equal(xlsxRows.length, 1);
  assert.equal(xlsxRows[0].raison_sociale, 'Beta');
});

test('decodeAssujettisImportFile - rejecte les payloads base64 invalides pour XLSX', () => {
  resetTables();

  assert.throws(
    () => decodeAssujettisImportFile('import.xlsx', 'not-base64'),
    /Invalid base64 payload/,
  );
});

test('decodeAssujettisImportFile - decode un CSV base64 invalide en aperçu vide pour compatibilité historique', () => {
  resetTables();

  const rows = decodeAssujettisImportFile('import.csv', 'not-base64');
  assert.deepEqual(rows, []);
});

test('validateImportRows - detecte anomalies et valide lignes correctes', () => {
  resetTables();

  const rows: RawImportRow[] = [
    {
      line: 2,
      identifiant_tlpe: 'TLPE-2026-00010',
      raison_sociale: 'Valide SARL',
      siret: '73282932000074',
      email: 'ok@example.fr',
      portail_actif: 'oui',
      statut: 'actif',
    },
    {
      line: 3,
      identifiant_tlpe: 'TLPE-2026-00011',
      raison_sociale: '',
      siret: '123',
      email: 'not-an-email',
      portail_actif: 'peut-etre',
      statut: 'inconnu',
    },
  ];

  const result = validateImportRows(rows);
  assert.equal(result.total, 2);
  assert.equal(result.validRows.length, 1);
  assert.ok(result.anomalies.length >= 4);
  assert.ok(result.anomalies.some((a) => a.field === 'raison_sociale'));
  assert.ok(result.anomalies.some((a) => a.field === 'siret'));
  assert.ok(result.anomalies.some((a) => a.field === 'email'));
});

test('validateImportRows - detecte les doublons, l’absence d’identifiant exploitable et les conflits de correspondance', () => {
  resetTables();

  db.prepare(
    `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, siret, statut)
     VALUES ('TLPE-2026-02000', 'Alpha existant', '73282932000074', 'actif')`,
  ).run();
  db.prepare(
    `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, siret, statut)
     VALUES ('TLPE-2026-02001', 'Beta existant', '55210055400005', 'actif')`,
  ).run();

  const rows: RawImportRow[] = [
    {
      line: 2,
      identifiant_tlpe: 'TLPE-2026-03000',
      raison_sociale: 'Gamma',
      siret: '34921495400001',
      portail_actif: 'oui',
      statut: 'actif',
    },
    {
      line: 3,
      identifiant_tlpe: 'TLPE-2026-03000',
      raison_sociale: 'Gamma doublon',
      siret: '34921495400025',
      portail_actif: 'oui',
      statut: 'actif',
    },
    {
      line: 4,
      raison_sociale: 'Sans identifiant',
      siret: '',
      portail_actif: 'non',
      statut: 'inactif',
    },
    {
      line: 5,
      identifiant_tlpe: 'TLPE-2026-02000',
      raison_sociale: 'Conflit correspondance',
      siret: '55210055400005',
      portail_actif: 'oui',
      statut: 'contentieux',
    },
  ];

  const result = validateImportRows(rows);
  assert.equal(result.total, 4);
  assert.equal(result.validRows.length, 1);
  assert.ok(
    result.anomalies.some((a) => a.line === 3 && a.field === 'identifiant_tlpe' && /Doublon dans le fichier/.test(a.message)),
  );
  assert.ok(
    result.anomalies.some(
      (a) => a.line === 4 && a.field === 'identifiant_tlpe/siret' && /Identifiant TLPE ou SIRET obligatoire/.test(a.message),
    ),
  );
  assert.ok(
    result.anomalies.some(
      (a) => a.line === 5 && a.field === 'identifiant_tlpe/siret' && /assujettis differents/.test(a.message),
    ),
  );
});

test('validateImportRows - applique les valeurs par défaut et détecte aussi les doublons de SIRET', () => {
  resetTables();

  const rows: RawImportRow[] = [
    {
      line: 2,
      identifiant_tlpe: 'TLPE-2026-04000',
      raison_sociale: 'Delta',
      siret: '73282932000074',
      portail_actif: '',
      statut: '',
      adresse_pays: '',
    },
    {
      line: 3,
      identifiant_tlpe: 'TLPE-2026-04001',
      raison_sociale: 'Delta doublon',
      siret: '73282932000074',
      portail_actif: 'non',
      statut: 'actif',
    },
  ];

  const result = validateImportRows(rows);
  assert.equal(result.validRows.length, 1);
  assert.equal(result.validRows[0].portail_actif, 0);
  assert.equal(result.validRows[0].statut, 'actif');
  assert.equal(result.validRows[0].adresse_pays, 'France');
  assert.ok(result.anomalies.some((a) => a.line === 3 && a.field === 'siret' && /Doublon dans le fichier/.test(a.message)));
});

test('executeAssujettisImport - cree et met a jour avec audit', () => {
  resetTables();
  const adminId = createAdminUser();

  const createResult = executeAssujettisImport(
    [
      {
        line: 2,
        identifiant_tlpe: 'TLPE-2026-00100',
        raison_sociale: 'Initiale SARL',
        siret: '73282932000074',
        forme_juridique: 'SARL',
        adresse_rue: null,
        adresse_cp: null,
        adresse_ville: null,
        adresse_pays: 'France',
        contact_nom: null,
        contact_prenom: null,
        contact_fonction: null,
        email: 'contact@initiale.fr',
        telephone: null,
        portail_actif: 1,
        statut: 'actif',
        notes: null,
      },
    ],
    adminId,
  );

  assert.deepEqual(createResult, { total: 1, created: 1, updated: 0, rejected: 0 });

  const updateResult = executeAssujettisImport(
    [
      {
        line: 2,
        identifiant_tlpe: 'TLPE-2026-00100',
        raison_sociale: 'Initiale SARL Modifiee',
        siret: '73282932000074',
        forme_juridique: 'SARL',
        adresse_rue: '1 rue des Tests',
        adresse_cp: '75001',
        adresse_ville: 'Paris',
        adresse_pays: 'France',
        contact_nom: 'Dupont',
        contact_prenom: 'Alice',
        contact_fonction: 'Gerante',
        email: 'contact@initiale.fr',
        telephone: '0102030405',
        portail_actif: 0,
        statut: 'inactif',
        notes: 'Mise a jour',
      },
    ],
    adminId,
  );

  assert.deepEqual(updateResult, { total: 1, created: 0, updated: 1, rejected: 0 });

  const row = db.prepare('SELECT raison_sociale, statut, portail_actif FROM assujettis WHERE identifiant_tlpe = ?').get('TLPE-2026-00100') as {
    raison_sociale: string;
    statut: string;
    portail_actif: number;
  };

  assert.equal(row.raison_sociale, 'Initiale SARL Modifiee');
  assert.equal(row.statut, 'inactif');
  assert.equal(row.portail_actif, 0);

  const audit = db.prepare('SELECT COUNT(*) AS c FROM audit_log WHERE entite = ? AND action = ?').get('assujetti', 'import') as { c: number };
  assert.equal(audit.c, 2);
});

test('executeAssujettisImport - génère un identifiant TLPE automatique et met à jour via le SIRET', () => {
  resetTables();
  const adminId = createAdminUser();

  const createResult = executeAssujettisImport(
    [
      {
        line: 2,
        identifiant_tlpe: null,
        raison_sociale: 'Sans identifiant manuel',
        siret: '55210055400005',
        forme_juridique: null,
        adresse_rue: null,
        adresse_cp: null,
        adresse_ville: null,
        adresse_pays: 'France',
        contact_nom: null,
        contact_prenom: null,
        contact_fonction: null,
        email: null,
        telephone: null,
        portail_actif: 0,
        statut: 'actif',
        notes: null,
      },
    ],
    adminId,
  );

  assert.deepEqual(createResult, { total: 1, created: 1, updated: 0, rejected: 0 });

  const createdRow = db.prepare('SELECT id, identifiant_tlpe, raison_sociale FROM assujettis WHERE siret = ?').get('55210055400005') as {
    id: number;
    identifiant_tlpe: string;
    raison_sociale: string;
  };
  assert.match(createdRow.identifiant_tlpe, /^TLPE-\d{4}-\d{5}$/);
  assert.equal(createdRow.raison_sociale, 'Sans identifiant manuel');

  const updateResult = executeAssujettisImport(
    [
      {
        line: 3,
        identifiant_tlpe: null,
        raison_sociale: 'Sans identifiant manuel - MAJ',
        siret: '55210055400005',
        forme_juridique: 'SARL',
        adresse_rue: '3 rue des Imports',
        adresse_cp: '33000',
        adresse_ville: 'Bordeaux',
        adresse_pays: 'France',
        contact_nom: 'Martin',
        contact_prenom: 'Jeanne',
        contact_fonction: 'Gerante',
        email: 'delta@example.fr',
        telephone: '0102030405',
        portail_actif: 1,
        statut: 'contentieux',
        notes: 'Maj via siret',
      },
    ],
    adminId,
  );

  assert.deepEqual(updateResult, { total: 1, created: 0, updated: 1, rejected: 0 });

  const updatedRow = db.prepare('SELECT identifiant_tlpe, raison_sociale, statut, portail_actif FROM assujettis WHERE siret = ?').get('55210055400005') as {
    identifiant_tlpe: string;
    raison_sociale: string;
    statut: string;
    portail_actif: number;
  };
  assert.equal(updatedRow.identifiant_tlpe, createdRow.identifiant_tlpe);
  assert.equal(updatedRow.raison_sociale, 'Sans identifiant manuel - MAJ');
  assert.equal(updatedRow.statut, 'contentieux');
  assert.equal(updatedRow.portail_actif, 1);
});
