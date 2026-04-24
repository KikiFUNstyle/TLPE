import { db, logAudit } from './db';
import { parseStatementFile, type CsvImportConfig, type ParsedStatement } from './rapprochementImport';

export interface ReleveBancaireRow {
  id: number;
  format: 'csv' | 'ofx' | 'mt940';
  fichier_nom: string;
  compte_bancaire: string | null;
  date_debut: string | null;
  date_fin: string | null;
  imported_at: string;
  imported_by: number | null;
  lignes_total: number;
  lignes_non_rapprochees: number;
}

export interface LigneReleveRow {
  id: number;
  releve_id: number;
  date: string;
  libelle: string;
  montant: number;
  reference: string | null;
  transaction_id: string;
  rapproche: number;
  paiement_id: number | null;
  raw_data: string | null;
}

export interface ImportRapprochementOptions {
  fileName: string;
  contentBase64: string;
  format?: 'csv' | 'ofx' | 'mt940';
  csvConfig?: CsvImportConfig;
  userId: number;
  ip?: string | null;
}

export interface ImportRapprochementResult {
  releve: ReleveBancaireRow;
  lignesImportees: number;
  lignesIgnorees: number;
  duplicates: Array<{ transaction_id: string; libelle: string; montant: number }>;
}

function mapReleveById(id: number): ReleveBancaireRow {
  return db
    .prepare(
      `SELECT r.id, r.format, r.fichier_nom, r.compte_bancaire, r.date_debut, r.date_fin, r.imported_at, r.imported_by,
              COUNT(l.id) AS lignes_total,
              COALESCE(SUM(CASE WHEN l.rapproche = 0 THEN 1 ELSE 0 END), 0) AS lignes_non_rapprochees
       FROM releves_bancaires r
       LEFT JOIN lignes_releve l ON l.releve_id = r.id
       WHERE r.id = ?
       GROUP BY r.id`,
    )
    .get(id) as ReleveBancaireRow;
}

function toDuplicateSummary(line: ParsedStatement['lignes'][number]) {
  return {
    transaction_id: line.transaction_id,
    libelle: line.libelle,
    montant: line.montant,
  };
}

export function importReleveBancaire(options: ImportRapprochementOptions): ImportRapprochementResult {
  const parsed = parseStatementFile({
    fileName: options.fileName,
    contentBase64: options.contentBase64,
    format: options.format,
    csvConfig: options.csvConfig,
  });

  const transactionIds = parsed.lignes.map((line) => line.transaction_id);
  const existingRows = transactionIds.length
    ? (db
        .prepare(
          `SELECT transaction_id
           FROM lignes_releve
           WHERE transaction_id IN (${transactionIds.map(() => '?').join(', ')})`,
        )
        .all(...transactionIds) as Array<{ transaction_id: string }>)
    : [];
  const existingIds = new Set(existingRows.map((row) => row.transaction_id));
  const seenIds = new Set(existingIds);
  const duplicates: Array<{ transaction_id: string; libelle: string; montant: number }> = [];
  const lignesAAjouter = parsed.lignes.filter((line) => {
    if (seenIds.has(line.transaction_id)) {
      duplicates.push(toDuplicateSummary(line));
      return false;
    }
    seenIds.add(line.transaction_id);
    return true;
  });

  const insertStatement = db.prepare(
    `INSERT INTO lignes_releve (
      releve_id, date, libelle, montant, reference, transaction_id, rapproche, paiement_id, raw_data
    ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
  );

  const result = db.transaction(() => {
    const releveId = Number(
      db
        .prepare(
          `INSERT INTO releves_bancaires (
            format, fichier_nom, compte_bancaire, date_debut, date_fin, imported_by
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(parsed.format, parsed.fileName, parsed.accountId, parsed.dateDebut, parsed.dateFin, options.userId).lastInsertRowid,
    );

    for (const line of lignesAAjouter) {
      insertStatement.run(releveId, line.date, line.libelle, line.montant, line.reference, line.transaction_id, line.raw_data);
    }

    logAudit({
      userId: options.userId,
      ip: options.ip ?? null,
      action: 'import',
      entite: 'releve_bancaire',
      entiteId: releveId,
      details: {
        format: parsed.format,
        fichier_nom: parsed.fileName,
        compte_bancaire: parsed.accountId,
        date_debut: parsed.dateDebut,
        date_fin: parsed.dateFin,
        lignes_importees: lignesAAjouter.length,
        lignes_ignorees: duplicates.length,
        transaction_ids_ignores: duplicates.map((duplicate) => duplicate.transaction_id),
      },
    });

    return {
      releve: mapReleveById(releveId),
      lignesImportees: lignesAAjouter.length,
      lignesIgnorees: duplicates.length,
      duplicates,
    } satisfies ImportRapprochementResult;
  })();

  return result;
}

export function listRelevesBancaires(): ReleveBancaireRow[] {
  return db
    .prepare(
      `SELECT r.id, r.format, r.fichier_nom, r.compte_bancaire, r.date_debut, r.date_fin, r.imported_at, r.imported_by,
              COUNT(l.id) AS lignes_total,
              COALESCE(SUM(CASE WHEN l.rapproche = 0 THEN 1 ELSE 0 END), 0) AS lignes_non_rapprochees
       FROM releves_bancaires r
       LEFT JOIN lignes_releve l ON l.releve_id = r.id
       GROUP BY r.id
       ORDER BY r.imported_at DESC, r.id DESC`,
    )
    .all() as ReleveBancaireRow[];
}

export function listLignesNonRapprochees(): LigneReleveRow[] {
  return db
    .prepare(
      `SELECT id, releve_id, date, libelle, montant, reference, transaction_id, rapproche, paiement_id, raw_data
       FROM lignes_releve
       WHERE rapproche = 0
       ORDER BY date DESC, id DESC`,
    )
    .all() as LigneReleveRow[];
}
