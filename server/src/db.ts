import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeContentieuxResponseDeadline } from './contentieuxDeadline';

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

  const userColumns = db.prepare("PRAGMA table_info('users')").all() as Array<{ name: string }>;
  const userColumnNames = new Set(userColumns.map((column) => column.name));
  if (!userColumnNames.has('two_factor_enabled')) {
    db.exec("ALTER TABLE users ADD COLUMN two_factor_enabled INTEGER NOT NULL DEFAULT 0 CHECK (two_factor_enabled IN (0,1))");
  }
  if (!userColumnNames.has('two_factor_secret_encrypted')) {
    db.exec('ALTER TABLE users ADD COLUMN two_factor_secret_encrypted TEXT');
  }
  if (!userColumnNames.has('two_factor_pending_secret_encrypted')) {
    db.exec('ALTER TABLE users ADD COLUMN two_factor_pending_secret_encrypted TEXT');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS codes_recuperation (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      code_hash  TEXT NOT NULL,
      used_at    TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_codes_recuperation_user ON codes_recuperation(user_id, used_at);
  `);

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
    const hasTypePiece = pieceColumns.some((col) => col.name === 'type_piece');
    const piecesJointesSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pieces_jointes'").get() as
        | { sql: string }
        | undefined
    )?.sql;
    const hasTitreEntite = /entite\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*entite\s+IN\s*\('dispositif','declaration','contentieux','titre','controle'\)\s*\)/i.test(
      piecesJointesSql ?? '',
    );
    const hasTypePieceConstraint = /type_piece\s+TEXT\s+CHECK\s*\(\s*type_piece\s+IS\s+NULL\s+OR\s*\(\s*entite\s*=\s*'contentieux'\s+AND\s+type_piece\s+IN\s*\('courrier-admin','courrier-contribuable','decision','jugement'\)\s*\)\s*\)/i.test(
      piecesJointesSql ?? '',
    );
    if (!hasDeletedAt || !hasTitreEntite || !hasTypePiece || !hasTypePieceConstraint) {
      db.pragma('foreign_keys = OFF');
      try {
        db.exec('BEGIN TRANSACTION');
        try {
          db.exec(`
            CREATE TABLE pieces_jointes_new (
              id            INTEGER PRIMARY KEY AUTOINCREMENT,
              entite        TEXT NOT NULL CHECK (entite IN ('dispositif','declaration','contentieux','titre','controle')),
              entite_id     INTEGER NOT NULL,
              nom           TEXT NOT NULL,
              mime_type     TEXT NOT NULL,
              taille        INTEGER NOT NULL CHECK (taille > 0),
              chemin        TEXT NOT NULL,
              type_piece    TEXT CHECK (type_piece IS NULL OR (entite = 'contentieux' AND type_piece IN ('courrier-admin','courrier-contribuable','decision','jugement'))),
              uploaded_by   INTEGER,
              created_at    TEXT NOT NULL DEFAULT (datetime('now')),
              deleted_at    TEXT,
              FOREIGN KEY (uploaded_by) REFERENCES users(id)
            );

            INSERT INTO pieces_jointes_new (id, entite, entite_id, nom, mime_type, taille, chemin, type_piece, uploaded_by, created_at, deleted_at)
            SELECT id, entite, entite_id, nom, mime_type, taille, chemin, ${hasTypePiece ? 'type_piece' : 'NULL'}, uploaded_by, created_at, ${hasDeletedAt ? 'deleted_at' : 'NULL'}
            FROM pieces_jointes;

            DROP TABLE pieces_jointes;
            ALTER TABLE pieces_jointes_new RENAME TO pieces_jointes;
            CREATE INDEX IF NOT EXISTS idx_pieces_jointes_entite ON pieces_jointes(entite, entite_id, deleted_at);
            CREATE INDEX IF NOT EXISTS idx_pieces_jointes_uploaded_by ON pieces_jointes(uploaded_by);
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

  const hasTitreMisesEnDemeure = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'titre_mises_en_demeure'").get() as
      | { name: string }
      | undefined
  )?.name === 'titre_mises_en_demeure';
  if (!hasTitreMisesEnDemeure) {
    db.exec(`
      CREATE TABLE titre_mises_en_demeure (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        numero           TEXT NOT NULL UNIQUE,
        titre_id         INTEGER NOT NULL UNIQUE,
        piece_jointe_id  INTEGER NOT NULL UNIQUE,
        annee            INTEGER NOT NULL,
        mode             TEXT NOT NULL DEFAULT 'manuel' CHECK (mode IN ('manuel','batch')),
        generated_by     INTEGER,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (titre_id) REFERENCES titres(id) ON DELETE CASCADE,
        FOREIGN KEY (piece_jointe_id) REFERENCES pieces_jointes(id) ON DELETE CASCADE,
        FOREIGN KEY (generated_by) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_titre_mises_en_demeure_annee ON titre_mises_en_demeure(annee, numero);
    `);
  }

  const hasTitreMisesEnDemeureSequences = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'titre_mises_en_demeure_sequences'").get() as
      | { name: string }
      | undefined
  )?.name === 'titre_mises_en_demeure_sequences';
  if (!hasTitreMisesEnDemeureSequences) {
    db.exec(`
      CREATE TABLE titre_mises_en_demeure_sequences (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        annee            INTEGER NOT NULL,
        numero_ordre     INTEGER NOT NULL,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (annee, numero_ordre)
      );
    `);
  }

  if (hasTitreMisesEnDemeure) {
    const sequenceBackfillCount = (
      db.prepare('SELECT COUNT(*) AS c FROM titre_mises_en_demeure_sequences').get() as { c: number }
    ).c;
    if (sequenceBackfillCount === 0) {
      db.exec(`
        INSERT INTO titre_mises_en_demeure_sequences (annee, numero_ordre, created_at)
        SELECT
          annee,
          CAST(substr(numero, -6) AS INTEGER) AS numero_ordre,
          created_at
        FROM titre_mises_en_demeure
      `);
    }
  }

  const hasRapportsExports = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rapports_exports'").get() as
      | { name: string }
      | undefined
  )?.name === 'rapports_exports';
  if (!hasRapportsExports) {
    db.exec(`
      CREATE TABLE rapports_exports (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        type_rapport  TEXT NOT NULL CHECK (type_rapport IN ('role_tlpe','etat_recouvrement','comparatif_pluriannuel','suivi_relances','synthese_contentieux','recettes_geographiques')),
        annee         INTEGER NOT NULL,
        format        TEXT NOT NULL CHECK (format IN ('pdf','xlsx')),
        filename      TEXT NOT NULL,
        storage_path  TEXT NOT NULL,
        content_hash  TEXT NOT NULL,
        titres_count  INTEGER NOT NULL DEFAULT 0,
        total_montant REAL NOT NULL DEFAULT 0,
        generated_by  INTEGER,
        exported_at   TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (generated_by) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rapports_exports_type_annee ON rapports_exports(type_rapport, annee, exported_at DESC);
    `);
  }

  const rapportsExportsSql = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rapports_exports'").get() as
      | { sql: string }
      | undefined
  )?.sql;
  const hasEtatRecouvrementReport = /type_rapport\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*type_rapport\s+IN\s*\([^)]*'etat_recouvrement'[^)]*\)\s*\)/i.test(
    rapportsExportsSql ?? '',
  );
  const hasSuiviRelancesReport = /type_rapport\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*type_rapport\s+IN\s*\([^)]*'suivi_relances'[^)]*\)\s*\)/i.test(
    rapportsExportsSql ?? '',
  );
  const hasComparatifPluriannuelReport = /type_rapport\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*type_rapport\s+IN\s*\([^)]*'comparatif_pluriannuel'[^)]*\)\s*\)/i.test(
    rapportsExportsSql ?? '',
  );
  const hasSyntheseContentieuxReport = /type_rapport\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*type_rapport\s+IN\s*\([^)]*'synthese_contentieux'[^)]*\)\s*\)/i.test(
    rapportsExportsSql ?? '',
  );
  const hasRecettesGeographiquesReport = /type_rapport\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*type_rapport\s+IN\s*\([^)]*'recettes_geographiques'[^)]*\)\s*\)/i.test(
    rapportsExportsSql ?? '',
  );
  if (rapportsExportsSql && (!hasEtatRecouvrementReport || !hasSuiviRelancesReport || !hasComparatifPluriannuelReport || !hasSyntheseContentieuxReport || !hasRecettesGeographiquesReport)) {
    db.pragma('foreign_keys = OFF');
    try {
      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE rapports_exports_new (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            type_rapport  TEXT NOT NULL CHECK (type_rapport IN ('role_tlpe','etat_recouvrement','comparatif_pluriannuel','suivi_relances','synthese_contentieux','recettes_geographiques')),
            annee         INTEGER NOT NULL,
            format        TEXT NOT NULL CHECK (format IN ('pdf','xlsx')),
            filename      TEXT NOT NULL,
            storage_path  TEXT NOT NULL,
            content_hash  TEXT NOT NULL,
            titres_count  INTEGER NOT NULL DEFAULT 0,
            total_montant REAL NOT NULL DEFAULT 0,
            generated_by  INTEGER,
            exported_at   TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (generated_by) REFERENCES users(id) ON DELETE SET NULL
          );

          INSERT INTO rapports_exports_new (
            id, type_rapport, annee, format, filename, storage_path, content_hash, titres_count, total_montant, generated_by, exported_at
          )
          SELECT
            id, type_rapport, annee, format, filename, storage_path, content_hash, titres_count, total_montant, generated_by, exported_at
          FROM rapports_exports;

          DROP TABLE rapports_exports;
          ALTER TABLE rapports_exports_new RENAME TO rapports_exports;
          CREATE INDEX IF NOT EXISTS idx_rapports_exports_type_annee ON rapports_exports(type_rapport, annee, exported_at DESC);
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

  const hasExportsSauvegardes = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'exports_sauvegardes'").get() as
      | { name: string }
      | undefined
  )?.name === 'exports_sauvegardes';
  if (!hasExportsSauvegardes) {
    db.exec(`
      CREATE TABLE exports_sauvegardes (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        INTEGER NOT NULL,
        nom            TEXT NOT NULL,
        entite         TEXT NOT NULL CHECK (entite IN ('assujettis','dispositifs','declarations','titres','paiements','contentieux')),
        configuration  TEXT NOT NULL,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE (user_id, nom)
      );
      CREATE INDEX IF NOT EXISTS idx_exports_sauvegardes_user_updated ON exports_sauvegardes(user_id, updated_at DESC);
    `);
  }

  const hasDeclarationSequences = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'declaration_sequences'").get() as
      | { name: string }
      | undefined
  )?.name === 'declaration_sequences';
  if (!hasDeclarationSequences) {
    db.exec(`
      CREATE TABLE declaration_sequences (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        annee            INTEGER NOT NULL,
        numero_ordre     INTEGER NOT NULL,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (annee, numero_ordre)
      );
    `);
  }

  const declarationSequenceBackfillCount = (
    db.prepare('SELECT COUNT(*) AS c FROM declaration_sequences').get() as { c: number }
  ).c;
  if (declarationSequenceBackfillCount === 0) {
    db.exec(`
      INSERT INTO declaration_sequences (annee, numero_ordre, created_at)
      SELECT
        annee,
        CAST(substr(numero, -6) AS INTEGER) AS numero_ordre,
        created_at
      FROM declarations
      WHERE numero GLOB 'DEC-[0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]'
    `);
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

  const contentieuxSql = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'contentieux'").get() as
      | { sql: string }
      | undefined
  )?.sql;
  if (contentieuxSql) {
    const contentieuxColumns = db.prepare("PRAGMA table_info('contentieux')").all() as Array<{ name: string }>;
    const hasDateLimiteReponse = contentieuxColumns.some((col) => col.name === 'date_limite_reponse');
    const hasDateLimiteReponseInitiale = contentieuxColumns.some((col) => col.name === 'date_limite_reponse_initiale');
    const hasMontantDegreve = contentieuxColumns.some((col) => col.name === 'montant_degreve');
    const hasMontantDegreveCheck = /montant_degreve\s+REAL\s+CHECK\s*\(\s*montant_degreve\s+IS\s+NULL\s+OR\s+montant_degreve\s*>?=\s*0\s*\)/i.test(
      contentieuxSql,
    );
    const hasDelaiProlongeJustification = contentieuxColumns.some((col) => col.name === 'delai_prolonge_justification');
    const hasDelaiProlongePar = contentieuxColumns.some((col) => col.name === 'delai_prolonge_par');
    const hasDelaiProlongeAt = contentieuxColumns.some((col) => col.name === 'delai_prolonge_at');
    const hasDelaiProlongeParFk = (
      db.prepare("PRAGMA foreign_key_list('contentieux')").all() as Array<{ from: string; table: string }>
    ).some((fk) => fk.from === 'delai_prolonge_par' && fk.table === 'users');

    if (
      !hasDateLimiteReponse ||
      !hasDateLimiteReponseInitiale ||
      !hasMontantDegreve ||
      !hasMontantDegreveCheck ||
      !hasDelaiProlongeJustification ||
      !hasDelaiProlongePar ||
      !hasDelaiProlongeAt ||
      !hasDelaiProlongeParFk
    ) {
      db.pragma('foreign_keys = OFF');
      try {
        db.exec('BEGIN TRANSACTION');
        try {
          db.exec(`
            CREATE TABLE contentieux_new (
              id              INTEGER PRIMARY KEY AUTOINCREMENT,
              numero          TEXT NOT NULL UNIQUE,
              assujetti_id    INTEGER NOT NULL,
              titre_id        INTEGER,
              type            TEXT NOT NULL CHECK (type IN ('gracieux','contentieux','moratoire','controle')),
              montant_litige  REAL,
              montant_degreve REAL CHECK (montant_degreve IS NULL OR montant_degreve >= 0),
              date_ouverture  TEXT NOT NULL DEFAULT (date('now')),
              date_limite_reponse TEXT,
              date_limite_reponse_initiale TEXT,
              delai_prolonge_justification TEXT,
              delai_prolonge_par INTEGER,
              delai_prolonge_at TEXT,
              date_cloture    TEXT,
              statut          TEXT NOT NULL DEFAULT 'ouvert' CHECK (statut IN ('ouvert','instruction','clos_maintenu','degrevement_partiel','degrevement_total','non_lieu')),
              description     TEXT,
              decision        TEXT,
              FOREIGN KEY (assujetti_id) REFERENCES assujettis(id),
              FOREIGN KEY (titre_id) REFERENCES titres(id),
              FOREIGN KEY (delai_prolonge_par) REFERENCES users(id) ON DELETE SET NULL
            );

            INSERT INTO contentieux_new (
              id, numero, assujetti_id, titre_id, type, montant_litige, montant_degreve, date_ouverture,
              date_limite_reponse, date_limite_reponse_initiale, delai_prolonge_justification,
              delai_prolonge_par, delai_prolonge_at, date_cloture, statut, description, decision
            )
            SELECT
              id,
              numero,
              assujetti_id,
              titre_id,
              type,
              montant_litige,
              ${hasMontantDegreve ? 'montant_degreve' : 'NULL'},
              date_ouverture,
              ${hasDateLimiteReponse ? 'date_limite_reponse' : 'NULL'},
              ${hasDateLimiteReponseInitiale ? 'date_limite_reponse_initiale' : 'NULL'},
              ${hasDelaiProlongeJustification ? 'delai_prolonge_justification' : 'NULL'},
              ${hasDelaiProlongePar ? 'delai_prolonge_par' : 'NULL'},
              ${hasDelaiProlongeAt ? 'delai_prolonge_at' : 'NULL'},
              date_cloture,
              statut,
              description,
              decision
            FROM contentieux;

            DROP TABLE contentieux;
            ALTER TABLE contentieux_new RENAME TO contentieux;
          `);

          if (!hasDateLimiteReponse || !hasDateLimiteReponseInitiale) {
            const legacyRows = db
              .prepare(
                `SELECT id, date_ouverture, date_limite_reponse, date_limite_reponse_initiale
                 FROM contentieux
                 WHERE date_limite_reponse IS NULL OR date_limite_reponse_initiale IS NULL`,
              )
              .all() as Array<{
              id: number;
              date_ouverture: string;
              date_limite_reponse: string | null;
              date_limite_reponse_initiale: string | null;
            }>;

            const updateLegacyDeadline = db.prepare(
              `UPDATE contentieux
               SET date_limite_reponse = ?,
                   date_limite_reponse_initiale = ?
               WHERE id = ?`,
            );

            for (const row of legacyRows) {
              const computedDeadline = computeContentieuxResponseDeadline(row.date_ouverture);
              updateLegacyDeadline.run(
                row.date_limite_reponse ?? computedDeadline,
                row.date_limite_reponse_initiale ?? row.date_limite_reponse ?? computedDeadline,
                row.id,
              );
            }
          }
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

  const hasContentieuxSequences = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contentieux_sequences'").get() as
      | { name: string }
      | undefined
  )?.name === 'contentieux_sequences';
  if (!hasContentieuxSequences) {
    db.exec(`
      CREATE TABLE contentieux_sequences (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        annee            INTEGER NOT NULL,
        numero_ordre     INTEGER NOT NULL,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (annee, numero_ordre)
      );
    `);
  }

  const contentieuxSequenceBackfillCount = (
    db.prepare('SELECT COUNT(*) AS c FROM contentieux_sequences').get() as { c: number }
  ).c;
  if (contentieuxSequenceBackfillCount === 0) {
    db.exec(`
      INSERT INTO contentieux_sequences (annee, numero_ordre, created_at)
      SELECT
        CAST(substr(numero, 5, 4) AS INTEGER) AS annee,
        CAST(substr(numero, -5) AS INTEGER) AS numero_ordre,
        date_ouverture
      FROM contentieux
      WHERE numero GLOB 'CTX-[0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9]'
    `);
  }

  const hasContentieuxAlerts = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contentieux_alerts'").get() as
      | { name: string }
      | undefined
  )?.name === 'contentieux_alerts';
  if (!hasContentieuxAlerts) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS contentieux_alerts (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        contentieux_id           INTEGER NOT NULL,
        assujetti_id             INTEGER NOT NULL,
        niveau_alerte            TEXT NOT NULL CHECK (niveau_alerte IN ('J-30','J-7','depasse')),
        date_reference           TEXT NOT NULL,
        date_echeance            TEXT NOT NULL,
        days_remaining           INTEGER NOT NULL,
        overdue                  INTEGER NOT NULL DEFAULT 0 CHECK (overdue IN (0,1)),
        email_status             TEXT NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending','envoye','echec')),
        email_error              TEXT,
        email_sent_at            TEXT,
        email_notification_id    INTEGER,
        created_by               INTEGER,
        created_at               TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (contentieux_id) REFERENCES contentieux(id) ON DELETE CASCADE,
        FOREIGN KEY (assujetti_id) REFERENCES assujettis(id) ON DELETE CASCADE,
        FOREIGN KEY (email_notification_id) REFERENCES notifications_email(id) ON DELETE SET NULL,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        UNIQUE (contentieux_id, niveau_alerte, date_echeance)
      );
    `);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_contentieux_alerts_contentieux ON contentieux_alerts(contentieux_id, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_contentieux_alerts_echeance ON contentieux_alerts(date_echeance, niveau_alerte)');

  const hasEvenementsContentieux = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'evenements_contentieux'").get() as
      | { name: string }
      | undefined
  )?.name === 'evenements_contentieux';
  if (!hasEvenementsContentieux) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS evenements_contentieux (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        contentieux_id   INTEGER NOT NULL,
        type             TEXT NOT NULL CHECK (type IN ('ouverture','courrier','statut','decision','jugement','relance','commentaire')),
        date             TEXT NOT NULL,
        auteur           TEXT,
        description      TEXT NOT NULL,
        piece_jointe_id  INTEGER,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (contentieux_id) REFERENCES contentieux(id) ON DELETE CASCADE,
        FOREIGN KEY (piece_jointe_id) REFERENCES pieces_jointes(id) ON DELETE SET NULL
      );
    `);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_evenements_contentieux_contentieux ON evenements_contentieux(contentieux_id, date, created_at)');

  // migration legacy -> aligne notifications_email avec le schéma courant
  const hasNotificationsEmail = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notifications_email'").get() as
      | { name: string }
      | undefined
  )?.name === 'notifications_email';
  if (hasNotificationsEmail) {
    const notifColumns = db.prepare("PRAGMA table_info('notifications_email')").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const notificationsEmailSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications_email'").get() as
        | { sql: string }
        | undefined
    )?.sql;
    const hasRelanceNiveau = notifColumns.some((col) => col.name === 'relance_niveau');
    const hasPieceJointePath = notifColumns.some((col) => col.name === 'piece_jointe_path');
    const campagneIdColumn = notifColumns.find((col) => col.name === 'campagne_id');
    const campagneIdNullable = (campagneIdColumn?.notnull ?? 0) === 0;
    const hasDepasseRelanceLevel = /relance_niveau\s+TEXT\s+CHECK\s*\(\s*relance_niveau\s+IN\s*\('J-30','J-15','J-7','depasse'\)\s*\)/i.test(
      notificationsEmailSql ?? '',
    );

    if (!hasRelanceNiveau || !hasPieceJointePath || !campagneIdNullable || !hasDepasseRelanceLevel) {
      db.pragma('foreign_keys = OFF');
      try {
        db.exec('BEGIN TRANSACTION');
        try {
          db.exec(`
            CREATE TABLE notifications_email_new (
              id                 INTEGER PRIMARY KEY AUTOINCREMENT,
              campagne_id         INTEGER,
              assujetti_id        INTEGER NOT NULL,
              email_destinataire  TEXT NOT NULL,
              objet               TEXT NOT NULL,
              corps               TEXT NOT NULL,
              template_code       TEXT NOT NULL DEFAULT 'invitation_campagne',
              relance_niveau      TEXT CHECK (relance_niveau IN ('J-30','J-15','J-7','depasse')),
              piece_jointe_path   TEXT,
              magic_link          TEXT,
              mode                TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto','manual')),
              statut              TEXT NOT NULL DEFAULT 'envoye' CHECK (statut IN ('pending','envoye','echec')),
              erreur              TEXT,
              sent_at             TEXT,
              created_by          INTEGER,
              created_at          TEXT NOT NULL DEFAULT (datetime('now')),
              FOREIGN KEY (campagne_id) REFERENCES campagnes(id) ON DELETE CASCADE,
              FOREIGN KEY (assujetti_id) REFERENCES assujettis(id) ON DELETE CASCADE,
              FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
            );

            INSERT INTO notifications_email_new (
              id, campagne_id, assujetti_id, email_destinataire, objet, corps,
              template_code, relance_niveau, piece_jointe_path, magic_link, mode,
              statut, erreur, sent_at, created_by, created_at
            )
            SELECT
              id,
              campagne_id,
              assujetti_id,
              email_destinataire,
              objet,
              corps,
              template_code,
              ${hasRelanceNiveau ? 'relance_niveau' : 'NULL'},
              ${hasPieceJointePath ? 'piece_jointe_path' : 'NULL'},
              magic_link,
              mode,
              statut,
              erreur,
              sent_at,
              created_by,
              created_at
            FROM notifications_email;

            DROP TABLE notifications_email;
            ALTER TABLE notifications_email_new RENAME TO notifications_email;
            CREATE INDEX IF NOT EXISTS idx_notifications_email_campagne ON notifications_email(campagne_id, assujetti_id);
            CREATE INDEX IF NOT EXISTS idx_notifications_email_statut ON notifications_email(statut, sent_at);
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

  const titresSql = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'titres'").get() as
      | { sql: string }
      | undefined
  )?.sql;
  if (titresSql) {
    const hasTransmisComptableStatut = /statut\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'emis'\s+CHECK\s*\(\s*statut\s+IN\s*\([^)]*'transmis_comptable'[^)]*'admis_en_non_valeur'[^)]*\)\s*\)/i.test(
      titresSql,
    );
    if (!hasTransmisComptableStatut) {
      const invalidTitreStatuts = db
        .prepare(
          `SELECT statut, COUNT(*) AS c
           FROM titres
           WHERE statut NOT IN ('emis','paye_partiel','paye','impaye','mise_en_demeure','transmis_comptable','admis_en_non_valeur')
           GROUP BY statut`,
        )
        .all() as Array<{ statut: string; c: number }>;
      if (invalidTitreStatuts.length > 0) {
        throw new Error(
          `Migration titres.statut impossible: ${invalidTitreStatuts.map((row) => `${row.statut} (${row.c})`).join(', ')}`,
        );
      }

      db.pragma('foreign_keys = OFF');
      try {
        db.exec('BEGIN TRANSACTION');
        try {
          db.exec(`
            CREATE TABLE titres_new (
              id              INTEGER PRIMARY KEY AUTOINCREMENT,
              numero          TEXT NOT NULL UNIQUE,
              declaration_id  INTEGER NOT NULL UNIQUE,
              assujetti_id    INTEGER NOT NULL,
              annee           INTEGER NOT NULL,
              montant         REAL NOT NULL,
              date_emission   TEXT NOT NULL,
              date_echeance   TEXT NOT NULL,
              statut          TEXT NOT NULL DEFAULT 'emis' CHECK (statut IN ('emis','paye_partiel','paye','impaye','mise_en_demeure','transmis_comptable','admis_en_non_valeur')),
              montant_paye    REAL NOT NULL DEFAULT 0,
              FOREIGN KEY (declaration_id) REFERENCES declarations(id),
              FOREIGN KEY (assujetti_id) REFERENCES assujettis(id)
            );

            INSERT INTO titres_new (
              id, numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut, montant_paye
            )
            SELECT id, numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut, montant_paye
            FROM titres;

            DROP TABLE titres;
            ALTER TABLE titres_new RENAME TO titres;
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

  const hasTitresExecutoires = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'titres_executoires'").get() as
      | { name: string }
      | undefined
  )?.name === 'titres_executoires';
  if (!hasTitresExecutoires) {
    db.exec(`
      CREATE TABLE titres_executoires (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        titre_id              INTEGER NOT NULL UNIQUE,
        numero_flux           INTEGER NOT NULL UNIQUE,
        xml_filename          TEXT NOT NULL,
        xml_content           TEXT NOT NULL,
        xml_hash              TEXT NOT NULL,
        mention_signature     TEXT NOT NULL,
        xsd_validation_ok     INTEGER NOT NULL DEFAULT 0 CHECK (xsd_validation_ok IN (0,1)),
        xsd_validation_report TEXT,
        transmitted_at        TEXT NOT NULL DEFAULT (datetime('now')),
        transmitted_by        INTEGER,
        FOREIGN KEY (titre_id) REFERENCES titres(id) ON DELETE CASCADE,
        FOREIGN KEY (transmitted_by) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_titres_executoires_transmitted_at ON titres_executoires(transmitted_at DESC);
    `);
  } else {
    db.exec('CREATE INDEX IF NOT EXISTS idx_titres_executoires_transmitted_at ON titres_executoires(transmitted_at DESC)');
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

  const hasRapprochementsLog = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rapprochements_log'").get() as
      | { name: string }
      | undefined
  )?.name === 'rapprochements_log';
  if (!hasRapprochementsLog) {
    db.exec(`
      CREATE TABLE rapprochements_log (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        ligne_releve_id  INTEGER NOT NULL,
        titre_id         INTEGER,
        paiement_id      INTEGER,
        mode             TEXT NOT NULL CHECK (mode IN ('auto','manuel')),
        resultat         TEXT NOT NULL CHECK (resultat IN ('rapproche','partiel','excedentaire','erreur_reference','errone')),
        commentaire      TEXT,
        user_id          INTEGER,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (ligne_releve_id) REFERENCES lignes_releve(id) ON DELETE CASCADE,
        FOREIGN KEY (titre_id) REFERENCES titres(id) ON DELETE SET NULL,
        FOREIGN KEY (paiement_id) REFERENCES paiements(id) ON DELETE SET NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rapprochements_log_ligne ON rapprochements_log(ligne_releve_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_rapprochements_log_created_at ON rapprochements_log(created_at DESC, id DESC);
    `);
  } else {
    const rapprochementsLogSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rapprochements_log'").get() as
        | { sql: string }
        | undefined
    )?.sql ?? '';
    const hasErroneWorkflow = /resultat\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*resultat\s+IN\s*\([^)]*'errone'[^)]*\)\s*\)/i.test(rapprochementsLogSql);
    if (!hasErroneWorkflow) {
      db.pragma('foreign_keys = OFF');
      try {
        db.exec('BEGIN TRANSACTION');
        try {
          db.exec(`
            CREATE TABLE rapprochements_log_new (
              id               INTEGER PRIMARY KEY AUTOINCREMENT,
              ligne_releve_id  INTEGER NOT NULL,
              titre_id         INTEGER,
              paiement_id      INTEGER,
              mode             TEXT NOT NULL CHECK (mode IN ('auto','manuel')),
              resultat         TEXT NOT NULL CHECK (resultat IN ('rapproche','partiel','excedentaire','erreur_reference','errone')),
              commentaire      TEXT,
              user_id          INTEGER,
              created_at       TEXT NOT NULL DEFAULT (datetime('now')),
              FOREIGN KEY (ligne_releve_id) REFERENCES lignes_releve(id) ON DELETE CASCADE,
              FOREIGN KEY (titre_id) REFERENCES titres(id) ON DELETE SET NULL,
              FOREIGN KEY (paiement_id) REFERENCES paiements(id) ON DELETE SET NULL,
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            );

            INSERT INTO rapprochements_log_new (
              id, ligne_releve_id, titre_id, paiement_id, mode, resultat, commentaire, user_id, created_at
            )
            SELECT id, ligne_releve_id, titre_id, paiement_id, mode, resultat, commentaire, user_id, created_at
            FROM rapprochements_log;

            DROP TABLE rapprochements_log;
            ALTER TABLE rapprochements_log_new RENAME TO rapprochements_log;
            CREATE INDEX IF NOT EXISTS idx_rapprochements_log_ligne ON rapprochements_log(ligne_releve_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_rapprochements_log_created_at ON rapprochements_log(created_at DESC, id DESC);
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
    db.exec('CREATE INDEX IF NOT EXISTS idx_rapprochements_log_ligne ON rapprochements_log(ligne_releve_id, created_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_rapprochements_log_created_at ON rapprochements_log(created_at DESC, id DESC)');
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_entite ON audit_log(entite, entite_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at DESC, id DESC)');

  const hasRecouvrementActions = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recouvrement_actions'").get() as
      | { name: string }
      | undefined
  )?.name === 'recouvrement_actions';
  if (!hasRecouvrementActions) {
    db.exec(`
      CREATE TABLE recouvrement_actions (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        titre_id           INTEGER NOT NULL,
        niveau             TEXT NOT NULL CHECK (niveau IN ('J+10','J+30','J+60','retour_comptable')),
        action_type        TEXT NOT NULL CHECK (action_type IN ('rappel_email','mise_en_demeure','transmission_comptable','admission_non_valeur')),
        statut             TEXT NOT NULL CHECK (statut IN ('pending','envoye','echec','transmis','classe')),
        email_destinataire TEXT,
        piece_jointe_path  TEXT,
        details            TEXT,
        created_by         INTEGER,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (titre_id) REFERENCES titres(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        UNIQUE (titre_id, niveau, action_type)
      );
      CREATE INDEX IF NOT EXISTS idx_recouvrement_actions_titre ON recouvrement_actions(titre_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_recouvrement_actions_niveau ON recouvrement_actions(niveau, statut, created_at DESC);
    `);
  } else {
    const recouvrementSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'recouvrement_actions'").get() as
        | { sql: string }
        | undefined
    )?.sql ?? '';
    const hasRetourComptable = /niveau\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*niveau\s+IN\s*\([^)]*'retour_comptable'[^)]*\)\s*\)/i.test(recouvrementSql);
    const hasAdmissionNonValeur = /action_type\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*action_type\s+IN\s*\([^)]*'admission_non_valeur'[^)]*\)\s*\)/i.test(recouvrementSql);
    const hasClasseStatut = /statut\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*statut\s+IN\s*\([^)]*'classe'[^)]*\)\s*\)/i.test(recouvrementSql);
    const hasActionScopedUnique = /UNIQUE\s*\(\s*titre_id\s*,\s*niveau\s*,\s*action_type\s*\)/i.test(recouvrementSql);
    if (!hasRetourComptable || !hasAdmissionNonValeur || !hasClasseStatut || !hasActionScopedUnique) {
      const invalidRecouvrementRows = db
        .prepare(
          `SELECT COUNT(*) AS c
           FROM recouvrement_actions
           WHERE niveau NOT IN ('J+10','J+30','J+60','retour_comptable')
              OR action_type NOT IN ('rappel_email','mise_en_demeure','transmission_comptable','admission_non_valeur')
              OR statut NOT IN ('pending','envoye','echec','transmis','classe')`,
        )
        .get() as { c: number };
      if (invalidRecouvrementRows.c > 0) {
        throw new Error(
          `Migration recouvrement_actions impossible: ${invalidRecouvrementRows.c} ligne(s) ont des valeurs invalides`,
        );
      }

      const duplicateRecouvrementRows = db
        .prepare(
          `SELECT titre_id, niveau, action_type, COUNT(*) AS c
           FROM recouvrement_actions
           GROUP BY titre_id, niveau, action_type
           HAVING COUNT(*) > 1`,
        )
        .all() as Array<{ titre_id: number; niveau: string; action_type: string; c: number }>;
      if (duplicateRecouvrementRows.length > 0) {
        throw new Error(
          `Migration recouvrement_actions impossible: ${duplicateRecouvrementRows.length} doublon(s) titre/niveau/action_type`,
        );
      }

      db.pragma('foreign_keys = OFF');
      try {
        db.exec('BEGIN TRANSACTION');
        try {
          db.exec(`
            CREATE TABLE recouvrement_actions_new (
              id                 INTEGER PRIMARY KEY AUTOINCREMENT,
              titre_id           INTEGER NOT NULL,
              niveau             TEXT NOT NULL CHECK (niveau IN ('J+10','J+30','J+60','retour_comptable')),
              action_type        TEXT NOT NULL CHECK (action_type IN ('rappel_email','mise_en_demeure','transmission_comptable','admission_non_valeur')),
              statut             TEXT NOT NULL CHECK (statut IN ('pending','envoye','echec','transmis','classe')),
              email_destinataire TEXT,
              piece_jointe_path  TEXT,
              details            TEXT,
              created_by         INTEGER,
              created_at         TEXT NOT NULL DEFAULT (datetime('now')),
              FOREIGN KEY (titre_id) REFERENCES titres(id) ON DELETE CASCADE,
              FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
              UNIQUE (titre_id, niveau, action_type)
            );

            INSERT INTO recouvrement_actions_new (
              id, titre_id, niveau, action_type, statut, email_destinataire, piece_jointe_path, details, created_by, created_at
            )
            SELECT id, titre_id, niveau, action_type, statut, email_destinataire, piece_jointe_path, details, created_by, created_at
            FROM recouvrement_actions;

            DROP TABLE recouvrement_actions;
            ALTER TABLE recouvrement_actions_new RENAME TO recouvrement_actions;
            CREATE INDEX IF NOT EXISTS idx_recouvrement_actions_titre ON recouvrement_actions(titre_id, created_at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS idx_recouvrement_actions_niveau ON recouvrement_actions(niveau, statut, created_at DESC);
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
    db.exec('CREATE INDEX IF NOT EXISTS idx_recouvrement_actions_titre ON recouvrement_actions(titre_id, created_at DESC, id DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_recouvrement_actions_niveau ON recouvrement_actions(niveau, statut, created_at DESC)');
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
