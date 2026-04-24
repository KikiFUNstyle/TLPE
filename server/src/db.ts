import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DATA_DIR = path.resolve(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.TLPE_DB_PATH || path.join(DATA_DIR, 'tlpe.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function resolveSchemaPath(currentDir = __dirname) {
  const candidates = [
    path.join(currentDir, 'schema.sql'),
    path.resolve(currentDir, '..', 'src', 'schema.sql'),
  ];
  const schemaPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!schemaPath) {
    throw new Error(`Schema SQL introuvable. Chemins testes: ${candidates.join(', ')}`);
  }
  return schemaPath;
}

export function initSchema() {
  const sql = fs.readFileSync(resolveSchemaPath(), 'utf-8');
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

  // migration legacy -> ajoute relance_j7_courrier sur campagnes si table deja presente
  const hasCampagnes = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'campagnes'").get() as
      | { name: string }
      | undefined
  )?.name === 'campagnes';
  if (hasCampagnes) {
    const campagneColumns = db.prepare("PRAGMA table_info('campagnes')").all() as Array<{ name: string }>;
    const hasRelanceJ7Courrier = campagneColumns.some((col) => col.name === 'relance_j7_courrier');
    if (!hasRelanceJ7Courrier) {
      db.exec("ALTER TABLE campagnes ADD COLUMN relance_j7_courrier INTEGER NOT NULL DEFAULT 0");
    }
  }

  // migration legacy -> ajoute relance_niveau et piece_jointe_path sur notifications_email
  const hasNotificationsEmail = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notifications_email'").get() as
      | { name: string }
      | undefined
  )?.name === 'notifications_email';
  if (hasNotificationsEmail) {
    const notifColumns = db.prepare("PRAGMA table_info('notifications_email')").all() as Array<{ name: string }>;
    const hasRelanceNiveau = notifColumns.some((col) => col.name === 'relance_niveau');
    const hasPieceJointePath = notifColumns.some((col) => col.name === 'piece_jointe_path');
    if (!hasRelanceNiveau) {
      db.exec('ALTER TABLE notifications_email ADD COLUMN relance_niveau TEXT');
    }
    if (!hasPieceJointePath) {
      db.exec('ALTER TABLE notifications_email ADD COLUMN piece_jointe_path TEXT');
    }
  }

  // migration legacy -> ajoute alerte_gestionnaire sur declarations si table deja presente
  const hasDeclarations = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'declarations'").get() as
      | { name: string }
      | undefined
  )?.name === 'declarations';
  if (hasDeclarations) {
  const declarationColumns = db.prepare("PRAGMA table_info('declarations')").all() as Array<{ name: string }>;
  const hasAlerteGestionnaire = declarationColumns.some((col) => col.name === 'alerte_gestionnaire');
  if (!hasAlerteGestionnaire) {
    db.exec("ALTER TABLE declarations ADD COLUMN alerte_gestionnaire INTEGER NOT NULL DEFAULT 0");
  }
  const hasHashSoumission = declarationColumns.some((col) => col.name === 'hash_soumission');
  if (!hasHashSoumission) {
    db.exec("ALTER TABLE declarations ADD COLUMN hash_soumission TEXT");
  }
}

  // migration legacy -> ajoute quote_part sur lignes_declaration avec contrainte CHECK [0,1]
  const lignesDeclarationSql = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lignes_declaration'").get() as
      | { sql: string }
      | undefined
  )?.sql;
  const hasLignesDeclaration = Boolean(lignesDeclarationSql);
  if (hasLignesDeclaration) {
    const lignesColumns = db.prepare("PRAGMA table_info('lignes_declaration')").all() as Array<{ name: string }>;
    const hasQuotePart = lignesColumns.some((col) => col.name === 'quote_part');
    const hasQuotePartCheck = /quote_part\s+REAL\s+NOT\s+NULL\s+DEFAULT\s+1(?:\.0)?\s+CHECK\s*\(\s*quote_part\s*>=\s*0\s+AND\s+quote_part\s*<=\s*1\s*\)/i.test(
      lignesDeclarationSql ?? '',
    );

    if (!hasQuotePart || !hasQuotePartCheck) {
      if (hasQuotePart) {
        const invalidQuotePartCount = (
          db
            .prepare(
              `SELECT COUNT(*) AS c
               FROM lignes_declaration
               WHERE quote_part IS NULL OR quote_part < 0 OR quote_part > 1`,
            )
            .get() as { c: number }
        ).c;

        if (invalidQuotePartCount > 0) {
          throw new Error(
            `Migration lignes_declaration.quote_part impossible: ${invalidQuotePartCount} ligne(s) ont une quote-part invalide`,
          );
        }
      }

      db.pragma('foreign_keys = OFF');
      try {
        db.exec('BEGIN TRANSACTION');
        try {
          db.exec(`
            CREATE TABLE lignes_declaration_new (
              id                INTEGER PRIMARY KEY AUTOINCREMENT,
              declaration_id    INTEGER NOT NULL,
              dispositif_id     INTEGER NOT NULL,
              surface_declaree  REAL NOT NULL,
              nombre_faces      INTEGER NOT NULL DEFAULT 1,
              quote_part        REAL NOT NULL DEFAULT 1.0 CHECK (quote_part >= 0 AND quote_part <= 1),
              date_pose         TEXT,
              date_depose       TEXT,
              bareme_id         INTEGER,
              tarif_applique    REAL,
              coefficient_zone  REAL,
              prorata           REAL,
              montant_ligne     REAL,
              FOREIGN KEY (declaration_id) REFERENCES declarations(id) ON DELETE CASCADE,
              FOREIGN KEY (dispositif_id) REFERENCES dispositifs(id),
              FOREIGN KEY (bareme_id) REFERENCES baremes(id)
            );

            INSERT INTO lignes_declaration_new (
              id, declaration_id, dispositif_id, surface_declaree, nombre_faces, quote_part, date_pose, date_depose,
              bareme_id, tarif_applique, coefficient_zone, prorata, montant_ligne
            )
            SELECT
              id,
              declaration_id,
              dispositif_id,
              surface_declaree,
              nombre_faces,
              ${hasQuotePart ? 'quote_part' : '1.0'},
              date_pose,
              date_depose,
              bareme_id,
              tarif_applique,
              coefficient_zone,
              prorata,
              montant_ligne
            FROM lignes_declaration;

            DROP TABLE lignes_declaration;
            ALTER TABLE lignes_declaration_new RENAME TO lignes_declaration;
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

  // migration legacy -> ajoute CHECK de sélection exclusive sur pesv2_exports
  const pesv2ExportsSql = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pesv2_exports'").get() as
      | { sql: string }
      | undefined
  )?.sql;
  if (pesv2ExportsSql) {
    const hasPesv2SelectionCheck = /CHECK\s*\([\s\S]*selection_type = 'campagne'[\s\S]*selection_type = 'periode'[\s\S]*date_debut <= date_fin[\s\S]*\)/i.test(
      pesv2ExportsSql,
    );
    if (!hasPesv2SelectionCheck) {
      db.pragma('foreign_keys = OFF');
      try {
        db.exec('BEGIN TRANSACTION');
        try {
          db.exec(`
            CREATE TABLE pesv2_exports_new (
              id                    INTEGER PRIMARY KEY AUTOINCREMENT,
              numero_bordereau      INTEGER NOT NULL UNIQUE,
              selection_type        TEXT NOT NULL CHECK (selection_type IN ('campagne','periode')),
              campagne_id           INTEGER,
              date_debut            TEXT,
              date_fin              TEXT,
              exported_at           TEXT NOT NULL DEFAULT (datetime('now')),
              exported_by           INTEGER,
              filename              TEXT NOT NULL,
              xml_hash              TEXT NOT NULL,
              xsd_validation_ok     INTEGER NOT NULL DEFAULT 0 CHECK (xsd_validation_ok IN (0,1)),
              xsd_validation_report TEXT,
              titres_count          INTEGER NOT NULL DEFAULT 0,
              total_montant         REAL NOT NULL DEFAULT 0,
              confirmation_reexport INTEGER NOT NULL DEFAULT 0 CHECK (confirmation_reexport IN (0,1)),
              CHECK (
                (selection_type = 'campagne' AND campagne_id IS NOT NULL AND date_debut IS NULL AND date_fin IS NULL)
                OR
                (selection_type = 'periode' AND campagne_id IS NULL AND date_debut IS NOT NULL AND date_fin IS NOT NULL AND date_debut <= date_fin)
              ),
              FOREIGN KEY (campagne_id) REFERENCES campagnes(id) ON DELETE RESTRICT,
              FOREIGN KEY (exported_by) REFERENCES users(id) ON DELETE SET NULL
            );

            INSERT INTO pesv2_exports_new (
              id, numero_bordereau, selection_type, campagne_id, date_debut, date_fin, exported_at,
              exported_by, filename, xml_hash, xsd_validation_ok, xsd_validation_report,
              titres_count, total_montant, confirmation_reexport
            )
            SELECT
              id,
              numero_bordereau,
              selection_type,
              campagne_id,
              date_debut,
              date_fin,
              exported_at,
              exported_by,
              filename,
              xml_hash,
              xsd_validation_ok,
              xsd_validation_report,
              titres_count,
              total_montant,
              confirmation_reexport
            FROM pesv2_exports;

            DROP TABLE pesv2_exports;
            ALTER TABLE pesv2_exports_new RENAME TO pesv2_exports;
            CREATE INDEX IF NOT EXISTS idx_pesv2_exports_selection ON pesv2_exports(selection_type, campagne_id, date_debut, date_fin);
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

  const paiementsSql = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'paiements'").get() as
      | { sql: string }
      | undefined
  )?.sql;
  if (paiementsSql) {
    const paiementColumns = db.prepare("PRAGMA table_info('paiements')").all() as Array<{ name: string }>;
    const hasProvider = paiementColumns.some((col) => col.name === 'provider');
    const hasStatut = paiementColumns.some((col) => col.name === 'statut');
    const hasTransactionId = paiementColumns.some((col) => col.name === 'transaction_id');
    const hasCallbackPayload = paiementColumns.some((col) => col.name === 'callback_payload');
    const hasCreatedAt = paiementColumns.some((col) => col.name === 'created_at');
    const hasProviderCheck = /provider\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'manuel'\s+CHECK\s*\(\s*provider\s+IN\s*\('manuel','payfip'\)\s*\)/i.test(
      paiementsSql,
    );
    const hasStatutCheck = /statut\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'confirme'\s+CHECK\s*\(\s*statut\s+IN\s*\('confirme','annule','refuse','en_attente'\)\s*\)/i.test(
      paiementsSql,
    );
    const hasTransactionUnique = /transaction_id\s+TEXT\s+UNIQUE/i.test(paiementsSql);
    const hasCreatedAtDefault = /created_at\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s*\(datetime\('now'\)\)/i.test(
      paiementsSql,
    );

    const invalidProviderCount = hasProvider
      ? (
          db
            .prepare(
              `SELECT COUNT(*) AS c
               FROM paiements
               WHERE provider IS NULL OR provider NOT IN ('manuel','payfip')`,
            )
            .get() as { c: number }
        ).c
      : 0;
    if (invalidProviderCount > 0) {
      throw new Error(
        `Migration paiements.provider impossible: ${invalidProviderCount} paiement(s) ont un provider invalide`,
      );
    }

    const invalidStatutCount = hasStatut
      ? (
          db
            .prepare(
              `SELECT COUNT(*) AS c
               FROM paiements
               WHERE statut IS NULL OR statut NOT IN ('confirme','annule','refuse','en_attente')`,
            )
            .get() as { c: number }
        ).c
      : 0;
    if (invalidStatutCount > 0) {
      throw new Error(
        `Migration paiements.statut impossible: ${invalidStatutCount} paiement(s) ont un statut invalide`,
      );
    }

    const duplicateTransactionIds = hasTransactionId
      ? (
          db
            .prepare(
              `SELECT transaction_id, COUNT(*) AS c
               FROM paiements
               WHERE transaction_id IS NOT NULL
               GROUP BY transaction_id
               HAVING COUNT(*) > 1`,
            )
            .all() as Array<{ transaction_id: string; c: number }>
        )
      : [];
    if (duplicateTransactionIds.length > 0) {
      throw new Error(
        `Migration paiements.transaction_id unique impossible: ${duplicateTransactionIds.length} transaction(s) dupliquée(s)`,
      );
    }

    if (!hasProvider || !hasStatut || !hasTransactionId || !hasCallbackPayload || !hasCreatedAt || !hasProviderCheck || !hasStatutCheck || !hasTransactionUnique || !hasCreatedAtDefault) {
      db.pragma('foreign_keys = OFF');
      try {
        db.exec('BEGIN TRANSACTION');
        try {
          db.exec(`
            CREATE TABLE paiements_new (
              id               INTEGER PRIMARY KEY AUTOINCREMENT,
              titre_id         INTEGER NOT NULL,
              montant          REAL NOT NULL,
              date_paiement    TEXT NOT NULL,
              modalite         TEXT NOT NULL CHECK (modalite IN ('virement','cheque','tipi','sepa','numeraire')),
              reference        TEXT,
              commentaire      TEXT,
              provider         TEXT NOT NULL DEFAULT 'manuel' CHECK (provider IN ('manuel','payfip')),
              statut           TEXT NOT NULL DEFAULT 'confirme' CHECK (statut IN ('confirme','annule','refuse','en_attente')),
              transaction_id   TEXT UNIQUE,
              callback_payload TEXT,
              created_at       TEXT NOT NULL DEFAULT (datetime('now')),
              FOREIGN KEY (titre_id) REFERENCES titres(id) ON DELETE CASCADE
            );

            INSERT INTO paiements_new (
              id, titre_id, montant, date_paiement, modalite, reference, commentaire,
              provider, statut, transaction_id, callback_payload, created_at
            )
            SELECT
              id,
              titre_id,
              montant,
              date_paiement,
              modalite,
              reference,
              commentaire,
              ${hasProvider ? "COALESCE(provider, 'manuel')" : "'manuel'"},
              ${hasStatut ? "COALESCE(statut, 'confirme')" : "'confirme'"},
              ${hasTransactionId ? 'transaction_id' : 'NULL'},
              ${hasCallbackPayload ? 'callback_payload' : 'NULL'},
              ${hasCreatedAt ? "COALESCE(created_at, datetime('now'))" : "datetime('now')"}
            FROM paiements;

            DROP TABLE paiements;
            ALTER TABLE paiements_new RENAME TO paiements;
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

    db.exec('CREATE INDEX IF NOT EXISTS idx_paiements_titre_date ON paiements(titre_id, date_paiement DESC)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_paiements_transaction ON paiements(transaction_id) WHERE transaction_id IS NOT NULL');
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
            relance_j7_courrier       INTEGER NOT NULL DEFAULT 0 CHECK (relance_j7_courrier IN (0,1)),
            created_by                INTEGER NOT NULL,
            created_at                TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (created_by) REFERENCES users(id)
          );

          INSERT INTO campagnes_new (id, annee, date_ouverture, date_limite_declaration, date_cloture, statut, relance_j7_courrier, created_by, created_at, updated_at)
          SELECT id, annee, date_ouverture, date_limite_declaration, date_cloture, statut,
                 0, created_by, created_at, updated_at
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

  const hasRelevesBancaires = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'releves_bancaires'").get() as
      | { name: string }
      | undefined
  )?.name === 'releves_bancaires';
  if (!hasRelevesBancaires) {
    db.exec(`
      CREATE TABLE releves_bancaires (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        format           TEXT NOT NULL CHECK (format IN ('csv','ofx','mt940')),
        fichier_nom      TEXT NOT NULL,
        compte_bancaire  TEXT,
        date_debut       TEXT,
        date_fin         TEXT,
        imported_at      TEXT NOT NULL DEFAULT (datetime('now')),
        imported_by      INTEGER,
        FOREIGN KEY (imported_by) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_releves_bancaires_imported_at ON releves_bancaires(imported_at DESC);
    `);
  }

  const lignesReleveSql = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lignes_releve'").get() as
      | { sql: string }
      | undefined
  )?.sql;
  if (!lignesReleveSql) {
    db.exec(`
      CREATE TABLE lignes_releve (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        releve_id        INTEGER NOT NULL,
        date             TEXT NOT NULL,
        libelle          TEXT NOT NULL,
        montant          REAL NOT NULL,
        reference        TEXT,
        transaction_id   TEXT NOT NULL UNIQUE,
        rapproche        INTEGER NOT NULL DEFAULT 0 CHECK (rapproche IN (0,1)),
        paiement_id      INTEGER,
        raw_data         TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (releve_id) REFERENCES releves_bancaires(id) ON DELETE CASCADE,
        FOREIGN KEY (paiement_id) REFERENCES paiements(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_lignes_releve_releve ON lignes_releve(releve_id);
      CREATE INDEX IF NOT EXISTS idx_lignes_releve_rapproche ON lignes_releve(rapproche, date DESC);
      CREATE INDEX IF NOT EXISTS idx_lignes_releve_paiement ON lignes_releve(paiement_id);
    `);
  } else {
    db.exec('CREATE INDEX IF NOT EXISTS idx_lignes_releve_releve ON lignes_releve(releve_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_lignes_releve_rapproche ON lignes_releve(rapproche, date DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_lignes_releve_paiement ON lignes_releve(paiement_id)');
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
