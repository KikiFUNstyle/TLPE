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
