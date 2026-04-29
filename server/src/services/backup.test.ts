import test = require('node:test');
import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import Database = require('better-sqlite3');
import {
  createBackup,
  decryptBackupPayload,
  planBackupRetention,
  restoreLatestBackup,
  type BackupConfig,
} from './backup';

function createTempDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeRsaKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

function createFixtureDataRoot(rootDir: string) {
  const dataDir = path.join(rootDir, 'data');
  fs.mkdirSync(path.join(dataDir, 'uploads', 'titre', '42', '2026', '04'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'receipts'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'mises_en_demeure'), { recursive: true });

  fs.writeFileSync(path.join(dataDir, 'uploads', 'titre', '42', '2026', '04', 'piece.pdf'), 'piece-jointe-chiffree');
  fs.writeFileSync(path.join(dataDir, 'receipts', 'receipt.txt'), 'accuse-reception');
  fs.writeFileSync(path.join(dataDir, 'mises_en_demeure', 'md.txt'), 'mise-en-demeure');

  const dbPath = path.join(dataDir, 'tlpe.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL);
    INSERT INTO users (email) VALUES ('admin@tlpe.local');
  `);
  db.close();

  return { dataDir, dbPath };
}

function makeLocalConfig(rootDir: string, overrides: Partial<BackupConfig> = {}): BackupConfig {
  const { publicKey, privateKey } = makeRsaKeyPair();
  const { dataDir, dbPath } = createFixtureDataRoot(rootDir);
  return {
    backupLabel: 'tlpe-test',
    dataDir,
    dbPath,
    storageMode: 'local',
    localStorageDir: path.join(rootDir, 'remote-store'),
    storagePrefix: 'backups',
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    retention: {
      dailyDays: 35,
      weeklyWeeks: 26,
      monthlyMonths: 12,
    },
    ...overrides,
  };
}

test('planBackupRetention conserve les snapshots quotidiens récents puis hebdo et mensuels', () => {
  const keys = [
    'backups/2026/04/2026-04-29T08-00-00.000Z__tlpe-backup.tlpeb',
    'backups/2026/04/2026-04-29T07-00-00.000Z__tlpe-backup.tlpeb',
    'backups/2026/04/2026-04-20T08-00-00.000Z__tlpe-backup.tlpeb',
    'backups/2026/03/2026-03-15T08-00-00.000Z__tlpe-backup.tlpeb',
    'backups/2026/02/2026-02-01T08-00-00.000Z__tlpe-backup.tlpeb',
    'backups/2025/09/2025-09-10T08-00-00.000Z__tlpe-backup.tlpeb',
    'backups/2024/12/2024-12-31T08-00-00.000Z__tlpe-backup.tlpeb',
  ];

  const plan = planBackupRetention(keys, {
    dailyDays: 10,
    weeklyWeeks: 8,
    monthlyMonths: 12,
  }, new Date('2026-04-29T12:00:00.000Z'));

  assert.deepEqual(plan.keep, [
    'backups/2026/04/2026-04-29T08-00-00.000Z__tlpe-backup.tlpeb',
    'backups/2026/04/2026-04-20T08-00-00.000Z__tlpe-backup.tlpeb',
    'backups/2026/03/2026-03-15T08-00-00.000Z__tlpe-backup.tlpeb',
    'backups/2026/02/2026-02-01T08-00-00.000Z__tlpe-backup.tlpeb',
    'backups/2025/09/2025-09-10T08-00-00.000Z__tlpe-backup.tlpeb',
  ]);
  assert.deepEqual(plan.purge, [
    'backups/2026/04/2026-04-29T07-00-00.000Z__tlpe-backup.tlpeb',
    'backups/2024/12/2024-12-31T08-00-00.000Z__tlpe-backup.tlpeb',
  ]);
});

test('decryptBackupPayload relit un payload produit par createBackup', async () => {
  const rootDir = createTempDir('tlpe-backup-encrypt-');
  const config = makeLocalConfig(rootDir);

  try {
    const result = await createBackup(config, new Date('2026-04-29T10:15:30.000Z'));
    const encrypted = fs.readFileSync(path.join(config.localStorageDir!, result.objectKey));
    const decryptedArchive = decryptBackupPayload(encrypted, config.privateKeyPem!);

    assert.equal(decryptedArchive.subarray(0, 2).toString('hex'), '1f8b');
    assert.equal(result.manifest.files.some((entry) => entry.relativePath.endsWith('piece.pdf')), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('restoreLatestBackup restaure une sauvegarde locale et valide l’intégrité SQLite', async () => {
  const rootDir = createTempDir('tlpe-restore-check-');
  const config = makeLocalConfig(rootDir);

  try {
    const backupResult = await createBackup(config, new Date('2026-04-29T23:45:00.000Z'));
    const restoreResult = await restoreLatestBackup(config);

    assert.equal(restoreResult.objectKey, backupResult.objectKey);
    assert.equal(restoreResult.integrity.ok, true);
    assert.equal(restoreResult.manifest.dbSnapshot.relativePath, 'db/tlpe.db');
    assert.equal(fs.existsSync(path.join(restoreResult.restoreDir, 'payload', 'uploads', 'titre', '42', '2026', '04', 'piece.pdf')), true);

    const restoredDb = new Database(path.join(restoreResult.restoreDir, 'payload', 'db', 'tlpe.db'), { readonly: true });
    const row = restoredDb.prepare('SELECT email FROM users').get() as { email: string };
    restoredDb.close();
    assert.equal(row.email, 'admin@tlpe.local');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
