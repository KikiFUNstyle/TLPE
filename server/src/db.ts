import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.TLPE_DB_PATH || path.join(DATA_DIR, 'tlpe.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(sql);

  // migration legacy -> ajoute geometry sur zones si la table existe deja
  const zoneColumns = db.prepare("PRAGMA table_info('zones')").all() as Array<{ name: string }>;
  const hasGeometry = zoneColumns.some((col) => col.name === 'geometry');
  if (!hasGeometry) {
    db.exec('ALTER TABLE zones ADD COLUMN geometry TEXT');
  }

  // migration legacy -> ajoute deleted_at sur pieces_jointes si table deja presente
  const hasPiecesJointes = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pieces_jointes'").get() as
      | { name: string }
      | undefined
  )?.name === 'pieces_jointes';
  if (hasPiecesJointes) {
    const pieceColumns = db.prepare("PRAGMA table_info('pieces_jointes')").all() as Array<{ name: string }>;
    const hasDeletedAt = pieceColumns.some((col) => col.name === 'deleted_at');
    if (!hasDeletedAt) {
      db.exec('ALTER TABLE pieces_jointes ADD COLUMN deleted_at TEXT');
    }
  }

  // migration legacy -> ajoute la FK campagnes.created_by -> users(id)
  const campagneFks = db.prepare("PRAGMA foreign_key_list('campagnes')").all() as Array<{ from: string; table: string }>;
  const hasCampagneCreatedByFk = campagneFks.some((fk) => fk.from === 'created_by' && fk.table === 'users');
  if (!hasCampagneCreatedByFk) {
    const invalidCreatedByCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS c
           FROM campagnes c
           LEFT JOIN users u ON u.id = c.created_by
           WHERE u.id IS NULL`,
        )
        .get() as { c: number }
    ).c;

    if (invalidCreatedByCount > 0) {
      throw new Error(
        `Migration campagnes.created_by impossible: ${invalidCreatedByCount} campagne(s) reference(nt) un utilisateur inexistant`,
      );
    }

    db.pragma('foreign_keys = OFF');
    try {
      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE campagnes_new (
            id                        INTEGER PRIMARY KEY AUTOINCREMENT,
            annee                     INTEGER NOT NULL UNIQUE,
            date_ouverture            TEXT NOT NULL,
            date_limite_declaration   TEXT NOT NULL,
            date_cloture              TEXT NOT NULL,
            statut                    TEXT NOT NULL DEFAULT 'brouillon' CHECK (statut IN ('brouillon','ouverte','cloturee')),
            created_by                INTEGER NOT NULL,
            created_at                TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (created_by) REFERENCES users(id)
          );

          INSERT INTO campagnes_new (id, annee, date_ouverture, date_limite_declaration, date_cloture, statut, created_by, created_at, updated_at)
          SELECT id, annee, date_ouverture, date_limite_declaration, date_cloture, statut, created_by, created_at, updated_at
          FROM campagnes;

          DROP TABLE campagnes;
          ALTER TABLE campagnes_new RENAME TO campagnes;
          CREATE INDEX IF NOT EXISTS idx_campagnes_statut ON campagnes(statut);
        `);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
}

export function logAudit(params: {
  userId?: number | null;
  action: string;
  entite: string;
  entiteId?: number | null;
  details?: unknown;
  ip?: string | null;
}) {
  db.prepare(
    `INSERT INTO audit_log (user_id, action, entite, entite_id, details, ip)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    params.userId ?? null,
    params.action,
    params.entite,
    params.entiteId ?? null,
    params.details ? JSON.stringify(params.details) : null,
    params.ip ?? null,
  );
}
