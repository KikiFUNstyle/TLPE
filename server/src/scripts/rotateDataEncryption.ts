import { db, initSchema } from '../db';
import * as fs from 'node:fs';
import {
  decryptBufferOrLegacy,
  getDataEncryptionInfo,
  isEncryptedBuffer,
  resetDataEncryptionState,
  rotateEncryptedBuffer,
  rotateEncryptedText,
} from '../services/crypto';
import { readStoredFileBuffer, resolveUploadAbsolutePath, saveFile } from '../routes/piecesJointes';

resetDataEncryptionState();
initSchema();

const dryRun = process.argv.includes('--dry-run');
const info = getDataEncryptionInfo();

type CountMap = Record<string, { scanned: number; rotated: number }>;
const counts: CountMap = {
  users: { scanned: 0, rotated: 0 },
  mandats_sepa: { scanned: 0, rotated: 0 },
  pieces_jointes: { scanned: 0, rotated: 0 },
};

function rotateUsersSecrets() {
  const rows = db
    .prepare(
      `SELECT id, two_factor_secret_encrypted, two_factor_pending_secret_encrypted
       FROM users
       WHERE two_factor_secret_encrypted IS NOT NULL OR two_factor_pending_secret_encrypted IS NOT NULL`,
    )
    .all() as Array<{
      id: number;
      two_factor_secret_encrypted: string | null;
      two_factor_pending_secret_encrypted: string | null;
    }>;

  for (const row of rows) {
    const nextSecret = row.two_factor_secret_encrypted ? rotateEncryptedText(row.two_factor_secret_encrypted) : null;
    const nextPending = row.two_factor_pending_secret_encrypted ? rotateEncryptedText(row.two_factor_pending_secret_encrypted) : null;
    counts.users.scanned += Number(Boolean(row.two_factor_secret_encrypted)) + Number(Boolean(row.two_factor_pending_secret_encrypted));
    counts.users.rotated += Number(nextSecret !== row.two_factor_secret_encrypted) + Number(nextPending !== row.two_factor_pending_secret_encrypted);

    if (!dryRun && (nextSecret !== row.two_factor_secret_encrypted || nextPending !== row.two_factor_pending_secret_encrypted)) {
      db.prepare(
        `UPDATE users
         SET two_factor_secret_encrypted = ?,
             two_factor_pending_secret_encrypted = ?
         WHERE id = ?`,
      ).run(nextSecret, nextPending, row.id);
    }
  }
}

function rotateMandatsSepa() {
  const rows = db.prepare(`SELECT id, iban FROM mandats_sepa`).all() as Array<{ id: number; iban: string }>;
  for (const row of rows) {
    counts.mandats_sepa.scanned += 1;
    const nextIban = rotateEncryptedText(row.iban);
    if (nextIban !== row.iban) {
      counts.mandats_sepa.rotated += 1;
      if (!dryRun) {
        db.prepare(`UPDATE mandats_sepa SET iban = ?, updated_at = datetime('now') WHERE id = ?`).run(nextIban, row.id);
      }
    }
  }
}

async function rotatePiecesJointes() {
  const rows = db
    .prepare(`SELECT id, chemin, mime_type FROM pieces_jointes WHERE deleted_at IS NULL ORDER BY id ASC`)
    .all() as Array<{ id: number; chemin: string; mime_type: string }>;

  for (const row of rows) {
    counts.pieces_jointes.scanned += 1;
    const absolutePath = resolveUploadAbsolutePath(row.chemin);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    const raw = fs.readFileSync(absolutePath);
    const nextRaw = isEncryptedBuffer(raw) ? rotateEncryptedBuffer(raw) : rotateEncryptedBuffer(decryptBufferOrLegacy(raw));
    if (!raw.equals(nextRaw)) {
      counts.pieces_jointes.rotated += 1;
      if (!dryRun) {
        const clear = await readStoredFileBuffer(row.chemin);
        await saveFile(row.chemin, clear, row.mime_type || 'application/octet-stream');
      }
    }
  }
}

async function main() {
  rotateUsersSecrets();
  rotateMandatsSepa();
  await rotatePiecesJointes();

  const summary = {
    dry_run: dryRun,
    active_version: info.active_version,
    configured_versions: info.configured_versions,
    key_source: info.source,
    counts,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error('[rotateDataEncryption] failure', error);
  process.exitCode = 1;
});
