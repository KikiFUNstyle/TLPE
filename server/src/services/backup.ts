import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database = require('better-sqlite3');
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export type BackupRetentionConfig = {
  dailyDays: number;
  weeklyWeeks: number;
  monthlyMonths: number;
};

export type BackupConfig = {
  backupLabel: string;
  dataDir: string;
  dbPath: string;
  storageMode: 'local' | 's3';
  localStorageDir?: string;
  storagePrefix: string;
  publicKeyPem: string;
  privateKeyPem?: string;
  s3Bucket?: string;
  s3Region?: string;
  s3Endpoint?: string;
  s3ForcePathStyle?: boolean;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  retention: BackupRetentionConfig;
  alertWebhookUrl?: string;
};

export type BackupManifestFile = {
  relativePath: string;
  size: number;
  sha256: string;
};

export type BackupManifest = {
  version: 'tlpe-backup-v1';
  generatedAt: string;
  backupLabel: string;
  dbSnapshot: BackupManifestFile;
  files: BackupManifestFile[];
};

export type BackupResult = {
  objectKey: string;
  manifest: BackupManifest;
  archiveSha256: string;
  encryptedSha256: string;
  bytesWritten: number;
  retention: {
    keep: string[];
    purged: string[];
  };
};

export type RestoreResult = {
  objectKey: string;
  restoreDir: string;
  manifest: BackupManifest;
  integrity: {
    ok: boolean;
    result: string;
  };
};

type StorageClient = {
  putObject: (key: string, body: Buffer) => Promise<void>;
  getObject: (key: string) => Promise<Buffer>;
  listObjects: () => Promise<string[]>;
  deleteObject: (key: string) => Promise<void>;
};

type ParsedBackupKey = {
  key: string;
  timestamp: Date;
};

type BackupEnvelope = {
  version: 'tlpe-backup-envelope-v1';
  algorithm: 'aes-256-gcm+rsa-oaep-sha256';
  encryptedKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
  archiveSha256: string;
};

function sha256Hex(buffer: Buffer | string): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function sanitizeBackupLabel(label: string): string {
  return label.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'tlpe-backup';
}

function timestampToObjectKey(timestamp: Date, backupLabel: string, storagePrefix: string): string {
  const safeIso = timestamp.toISOString().replace(/:/g, '-');
  const yyyy = String(timestamp.getUTCFullYear());
  const mm = String(timestamp.getUTCMonth() + 1).padStart(2, '0');
  const fileName = `${safeIso}__${sanitizeBackupLabel(backupLabel)}.tlpeb`;
  return path.posix.join(storagePrefix, yyyy, mm, fileName);
}

function parseBackupTimestampFromKey(key: string): Date | null {
  const match = path.posix.basename(key).match(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}\.\d{3}Z)__.+\.tlpeb$/);
  if (!match) return null;
  const iso = `${match[1]}:${match[2]}:${match[3]}`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseBackupKeys(keys: string[]): ParsedBackupKey[] {
  return keys
    .map((key) => {
      const timestamp = parseBackupTimestampFromKey(key);
      return timestamp ? { key, timestamp } : null;
    })
    .filter((item): item is ParsedBackupKey => item !== null)
    .sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime());
}

function isoDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isoMonthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isoWeekKey(date: Date): string {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function dayDistance(now: Date, candidate: Date): number {
  return Math.floor((now.getTime() - candidate.getTime()) / 86400000);
}

function monthDistance(now: Date, candidate: Date): number {
  return (now.getUTCFullYear() - candidate.getUTCFullYear()) * 12 + (now.getUTCMonth() - candidate.getUTCMonth());
}

function weekDistance(now: Date, candidate: Date): number {
  return Math.floor((now.getTime() - candidate.getTime()) / (86400000 * 7));
}

export function planBackupRetention(keys: string[], retention: BackupRetentionConfig, now = new Date()) {
  const parsed = parseBackupKeys(keys);
  const keep = new Set<string>();
  const seenDaily = new Set<string>();
  const seenWeekly = new Set<string>();
  const seenMonthly = new Set<string>();

  for (const item of parsed) {
    const dailyBucket = isoDayKey(item.timestamp);
    const weeklyBucket = isoWeekKey(item.timestamp);
    const monthlyBucket = isoMonthKey(item.timestamp);

    const dailyAge = dayDistance(now, item.timestamp);
    if (dailyAge >= 0 && dailyAge < retention.dailyDays) {
      if (!seenDaily.has(dailyBucket)) {
        seenDaily.add(dailyBucket);
        seenWeekly.add(weeklyBucket);
        seenMonthly.add(monthlyBucket);
        keep.add(item.key);
        continue;
      }
    }

    const weeklyAge = weekDistance(now, item.timestamp);
    if (weeklyAge >= 0 && weeklyAge < retention.weeklyWeeks) {
      if (!seenWeekly.has(weeklyBucket)) {
        seenWeekly.add(weeklyBucket);
        seenMonthly.add(monthlyBucket);
        keep.add(item.key);
        continue;
      }
    }

    const monthlyAge = monthDistance(now, item.timestamp);
    if (monthlyAge >= 0 && monthlyAge < retention.monthlyMonths) {
      if (!seenMonthly.has(monthlyBucket)) {
        seenMonthly.add(monthlyBucket);
        keep.add(item.key);
      }
    }
  }

  return {
    keep: parsed.filter((item) => keep.has(item.key)).map((item) => item.key),
    purge: parsed.filter((item) => !keep.has(item.key)).map((item) => item.key),
  };
}

async function buildStorageClient(config: BackupConfig): Promise<StorageClient> {
  if (config.storageMode === 'local') {
    if (!config.localStorageDir) {
      throw new Error('TLPE_BACKUP_LOCAL_DIR est obligatoire pour le stockage local');
    }
    const localStorageDir = config.localStorageDir;
    ensureDir(localStorageDir);
    return {
      async putObject(key, body) {
        const fullPath = path.join(localStorageDir, key);
        ensureDir(path.dirname(fullPath));
        await fs.promises.writeFile(fullPath, body);
      },
      async getObject(key) {
        return fs.promises.readFile(path.join(localStorageDir, key));
      },
      async listObjects() {
        const results: string[] = [];
        const walk = async (dir: string) => {
          const entries = await fs.promises.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              await walk(full);
            } else {
              results.push(path.relative(localStorageDir, full).split(path.sep).join(path.posix.sep));
            }
          }
        };
        await walk(localStorageDir);
        return results;
      },
      async deleteObject(key) {
        await fs.promises.rm(path.join(localStorageDir, key), { force: true });
      },
    };
  }

  if (!config.s3Bucket) {
    throw new Error('TLPE_BACKUP_S3_BUCKET est obligatoire pour le stockage S3');
  }

  const client = new S3Client({
    region: config.s3Region || 'us-east-1',
    endpoint: config.s3Endpoint || undefined,
    forcePathStyle: config.s3ForcePathStyle === true,
    credentials:
      config.s3AccessKeyId && config.s3SecretAccessKey
        ? {
            accessKeyId: config.s3AccessKeyId,
            secretAccessKey: config.s3SecretAccessKey,
          }
        : undefined,
  });

  return {
    async putObject(key, body) {
      await client.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: key, Body: body }));
    },
    async getObject(key) {
      const response = await client.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }));
      if (!response.Body) {
        throw new Error(`Objet S3 vide pour ${key}`);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    },
    async listObjects() {
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: config.s3Bucket,
            Prefix: config.storagePrefix ? `${config.storagePrefix.replace(/\/+$/, '')}/` : undefined,
            ContinuationToken: continuationToken,
          }),
        );
        for (const object of response.Contents ?? []) {
          if (object.Key) keys.push(object.Key);
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken);
      return keys;
    },
    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: key }));
    },
  };
}

function relativePathInsideDataRoot(dataDir: string, filePath: string): string {
  return path.relative(dataDir, filePath).split(path.sep).join(path.posix.sep);
}

function copyDirectoryIfExists(source: string, destination: string) {
  if (!fs.existsSync(source)) return;
  ensureDir(path.dirname(destination));
  fs.cpSync(source, destination, { recursive: true });
}

async function createSqliteSnapshot(sourceDbPath: string, destinationDbPath: string): Promise<void> {
  const db = new Database(sourceDbPath, { fileMustExist: true });
  try {
    await db.backup(destinationDbPath);
  } finally {
    db.close();
  }
}

function listFilesRecursively(rootDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  };
  if (fs.existsSync(rootDir)) {
    walk(rootDir);
  }
  return files.sort();
}

function buildManifest(params: { payloadDir: string; generatedAt: string; backupLabel: string }): BackupManifest {
  const files = listFilesRecursively(params.payloadDir);
  const manifestFiles = files.map((filePath) => {
    const buffer = fs.readFileSync(filePath);
    return {
      relativePath: path.relative(params.payloadDir, filePath).split(path.sep).join(path.posix.sep),
      size: buffer.length,
      sha256: sha256Hex(buffer),
    };
  });
  const dbSnapshot = manifestFiles.find((entry) => entry.relativePath === 'db/tlpe.db');
  if (!dbSnapshot) {
    throw new Error('Snapshot SQLite introuvable dans la sauvegarde');
  }
  return {
    version: 'tlpe-backup-v1',
    generatedAt: params.generatedAt,
    backupLabel: params.backupLabel,
    dbSnapshot,
    files: manifestFiles,
  };
}

function createTarGzArchive(sourceDir: string, archivePath: string) {
  execFileSync('tar', ['-czf', archivePath, '-C', sourceDir, '.'], { stdio: 'pipe' });
}

function extractTarGzArchive(archivePath: string, destinationDir: string) {
  ensureDir(destinationDir);
  execFileSync('tar', ['-xzf', archivePath, '-C', destinationDir], { stdio: 'pipe' });
}

function encryptArchivePayload(archiveBuffer: Buffer, publicKeyPem: string): Buffer {
  const dataKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(archiveBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encryptedKey = crypto.publicEncrypt(
    {
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    dataKey,
  );
  const envelope: BackupEnvelope = {
    version: 'tlpe-backup-envelope-v1',
    algorithm: 'aes-256-gcm+rsa-oaep-sha256',
    encryptedKey: encryptedKey.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    archiveSha256: sha256Hex(archiveBuffer),
  };
  return Buffer.from(JSON.stringify(envelope), 'utf8');
}

export function decryptBackupPayload(payload: Buffer, privateKeyPem: string): Buffer {
  const envelope = JSON.parse(payload.toString('utf8')) as BackupEnvelope;
  if (envelope.version !== 'tlpe-backup-envelope-v1') {
    throw new Error('Format de sauvegarde chiffrée invalide');
  }
  const dataKey = crypto.privateDecrypt(
    {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(envelope.encryptedKey, 'base64'),
  );
  const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const archiveBuffer = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  if (sha256Hex(archiveBuffer) !== envelope.archiveSha256) {
    throw new Error('Intégrité de la sauvegarde compromise');
  }
  return archiveBuffer;
}

async function applyRetention(storage: StorageClient, config: BackupConfig, now: Date) {
  const keys = await storage.listObjects();
  const plan = planBackupRetention(keys, config.retention, now);
  for (const key of plan.purge) {
    await storage.deleteObject(key);
  }
  return plan;
}

async function buildBackupArchive(config: BackupConfig, now: Date) {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tlpe-backup-build-'));
  try {
    const archiveRoot = path.join(tempRoot, 'archive-root');
    const payloadDir = path.join(archiveRoot, 'payload');
    const dbDir = path.join(payloadDir, 'db');
    ensureDir(dbDir);

    const snapshotPath = path.join(dbDir, 'tlpe.db');
    await createSqliteSnapshot(config.dbPath, snapshotPath);

    for (const relativeDir of ['uploads', 'receipts', 'mises_en_demeure']) {
      copyDirectoryIfExists(path.join(config.dataDir, relativeDir), path.join(payloadDir, relativeDir));
    }

    const manifest = buildManifest({
      payloadDir,
      generatedAt: now.toISOString(),
      backupLabel: config.backupLabel,
    });
    const manifestPath = path.join(archiveRoot, 'manifest.json');
    await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const archivePath = path.join(tempRoot, 'backup.tar.gz');
    createTarGzArchive(archiveRoot, archivePath);
    const archiveBuffer = await fs.promises.readFile(archivePath);
    return { archiveBuffer, manifest };
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
}

export async function createBackup(config: BackupConfig, now = new Date()): Promise<BackupResult> {
  const storage = await buildStorageClient(config);
  const { archiveBuffer, manifest } = await buildBackupArchive(config, now);
  const encryptedPayload = encryptArchivePayload(archiveBuffer, config.publicKeyPem);
  const objectKey = timestampToObjectKey(now, config.backupLabel, config.storagePrefix);
  await storage.putObject(objectKey, encryptedPayload);
  const retention = await applyRetention(storage, config, now);
  return {
    objectKey,
    manifest,
    archiveSha256: sha256Hex(archiveBuffer),
    encryptedSha256: sha256Hex(encryptedPayload),
    bytesWritten: encryptedPayload.length,
    retention: {
      keep: retention.keep,
      purged: retention.purge,
    },
  };
}

function ensurePrivateKey(config: BackupConfig): string {
  if (!config.privateKeyPem) {
    throw new Error('TLPE_BACKUP_PRIVATE_KEY est obligatoire pour la restauration');
  }
  return config.privateKeyPem;
}

function parseManifest(manifestPath: string): BackupManifest {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BackupManifest;
}

function validateRestoredSqlite(dbPath: string) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.pragma('integrity_check', { simple: true }) as string;
    return {
      ok: row === 'ok',
      result: row,
    };
  } finally {
    db.close();
  }
}

export async function restoreLatestBackup(config: BackupConfig): Promise<RestoreResult> {
  const storage = await buildStorageClient(config);
  const keys = parseBackupKeys(await storage.listObjects());
  if (keys.length === 0) {
    throw new Error('Aucune sauvegarde disponible');
  }
  const latest = keys[0];
  const encryptedPayload = await storage.getObject(latest.key);
  const archiveBuffer = decryptBackupPayload(encryptedPayload, ensurePrivateKey(config));
  const restoreRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tlpe-backup-restore-'));
  const archivePath = path.join(restoreRoot, 'backup.tar.gz');
  await fs.promises.writeFile(archivePath, archiveBuffer);
  extractTarGzArchive(archivePath, restoreRoot);
  const manifest = parseManifest(path.join(restoreRoot, 'manifest.json'));
  const integrity = validateRestoredSqlite(path.join(restoreRoot, 'payload', 'db', 'tlpe.db'));
  return {
    objectKey: latest.key,
    restoreDir: restoreRoot,
    manifest,
    integrity,
  };
}

export async function sendBackupAlert(config: BackupConfig, summary: Record<string, unknown>) {
  if (!config.alertWebhookUrl) return;
  const response = await fetch(config.alertWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(summary),
  });
  if (!response.ok) {
    throw new Error(`Webhook d’alerte en échec (${response.status})`);
  }
}

export function resolveBackupConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BackupConfig {
  const storageMode = (env.TLPE_BACKUP_STORAGE_MODE || 'local').trim().toLowerCase();
  if (storageMode !== 'local' && storageMode !== 's3') {
    throw new Error(`TLPE_BACKUP_STORAGE_MODE invalide: ${storageMode}`);
  }
  const dataDir = path.resolve(env.TLPE_DATA_DIR || path.resolve(__dirname, '..', '..', 'data'));
  const dbPath = path.resolve(env.TLPE_DB_PATH || path.join(dataDir, 'tlpe.db'));
  const publicKeyPem = env.TLPE_BACKUP_PUBLIC_KEY?.trim();
  if (!publicKeyPem) {
    throw new Error('TLPE_BACKUP_PUBLIC_KEY est obligatoire');
  }

  const retention = {
    dailyDays: Number(env.TLPE_BACKUP_RETENTION_DAILY_DAYS || 35),
    weeklyWeeks: Number(env.TLPE_BACKUP_RETENTION_WEEKLY_WEEKS || 26),
    monthlyMonths: Number(env.TLPE_BACKUP_RETENTION_MONTHLY_MONTHS || 12),
  };

  for (const [label, value] of Object.entries(retention)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${label} doit être un entier strictement positif`);
    }
  }

  return {
    backupLabel: env.TLPE_BACKUP_LABEL || 'tlpe-backup',
    dataDir,
    dbPath,
    storageMode,
    localStorageDir: env.TLPE_BACKUP_LOCAL_DIR ? path.resolve(env.TLPE_BACKUP_LOCAL_DIR) : undefined,
    storagePrefix: (env.TLPE_BACKUP_STORAGE_PREFIX || 'backups').replace(/^\/+|\/+$/g, ''),
    publicKeyPem,
    privateKeyPem: env.TLPE_BACKUP_PRIVATE_KEY,
    s3Bucket: env.TLPE_BACKUP_S3_BUCKET,
    s3Region: env.TLPE_BACKUP_S3_REGION,
    s3Endpoint: env.TLPE_BACKUP_S3_ENDPOINT,
    s3ForcePathStyle: env.TLPE_BACKUP_S3_FORCE_PATH_STYLE === 'true',
    s3AccessKeyId: env.TLPE_BACKUP_S3_ACCESS_KEY_ID,
    s3SecretAccessKey: env.TLPE_BACKUP_S3_SECRET_ACCESS_KEY,
    retention,
    alertWebhookUrl: env.TLPE_BACKUP_ALERT_WEBHOOK_URL,
  };
}
