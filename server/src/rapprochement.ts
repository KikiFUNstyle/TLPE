import { db, logAudit } from './db';
import { parseStatementFile, type CsvImportConfig, type ParsedStatement } from './rapprochementImport';

export type RapprochementMode = 'auto' | 'manuel';
export type RapprochementResult = 'rapproche' | 'partiel' | 'excedentaire' | 'erreur_reference' | 'errone';

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
  workflow: RapprochementResult | 'en_attente';
  workflow_commentaire: string | null;
  numero_titre: string | null;
}

export interface RapprochementLogRow {
  id: number;
  ligne_releve_id: number;
  transaction_id: string;
  mode: RapprochementMode;
  resultat: RapprochementResult;
  commentaire: string | null;
  numero_titre: string | null;
  paiement_id: number | null;
  user_id: number | null;
  user_display: string | null;
  created_at: string;
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

export interface AutoRapprochementResult {
  matched_count: number;
  pending_count: number;
  payment_count: number;
  logs: RapprochementLogRow[];
}

export interface ManualRapprochementOptions {
  ligneId: number;
  numeroTitre: string;
  commentaire?: string | null;
  userId: number;
  ip?: string | null;
}

export interface ManualRapprochementResult {
  ok: true;
  mode: 'manuel';
  resultat: 'rapproche' | 'partiel';
  statut: string;
  montant_paye: number;
  paiement_id: number;
}

interface TitreLookupRow {
  id: number;
  numero: string;
  montant: number;
  montant_paye: number;
  statut: string;
}

interface PendingLineRow {
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

export class RapprochementWorkflowError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'RapprochementWorkflowError';
  }
}

const DUPLICATE_LOOKUP_BATCH_SIZE = 500;
const DEFAULT_REFERENCE_REGEX = 'TIT-\\d{4}-\\d{3,}';

function roundAmount(value: number) {
  return Number(value.toFixed(2));
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

function listExistingTransactionIds(transactionIds: string[]) {
  if (transactionIds.length === 0) return new Set<string>();

  const existingIds = new Set<string>();
  for (let index = 0; index < transactionIds.length; index += DUPLICATE_LOOKUP_BATCH_SIZE) {
    const batch = transactionIds.slice(index, index + DUPLICATE_LOOKUP_BATCH_SIZE);
    const placeholders = batch.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT transaction_id
         FROM lignes_releve
         WHERE transaction_id IN (${placeholders})`,
      )
      .all(...batch) as Array<{ transaction_id: string }>;
    rows.forEach((row) => existingIds.add(row.transaction_id));
  }

  return existingIds;
}

function getReferenceRegex() {
  const source = process.env.TLPE_RAPPROCHEMENT_REFERENCE_REGEX?.trim() || DEFAULT_REFERENCE_REGEX;
  try {
    return new RegExp(source, 'ig');
  } catch {
    return new RegExp(DEFAULT_REFERENCE_REGEX, 'ig');
  }
}

function extractTitreCandidates(line: Pick<PendingLineRow, 'reference' | 'libelle'>) {
  const regex = getReferenceRegex();
  const values = [line.reference ?? '', line.libelle ?? ''];
  const found = new Set<string>();

  for (const value of values) {
    regex.lastIndex = 0;
    const matches = value.match(regex) ?? [];
    for (const match of matches) {
      found.add(match.trim().toUpperCase());
    }
  }

  return Array.from(found);
}

function loadTitreByNumero(numero: string) {
  return db
    .prepare(
      `SELECT id, numero, montant, montant_paye, statut
       FROM titres
       WHERE numero = ?`,
    )
    .get(numero) as TitreLookupRow | undefined;
}

function listPendingLinesForProcessing() {
  return db
    .prepare(
      `SELECT id, releve_id, date, libelle, montant, reference, transaction_id, rapproche, paiement_id, raw_data
       FROM lignes_releve
       WHERE rapproche = 0
       ORDER BY date ASC, id ASC`,
    )
    .all() as PendingLineRow[];
}

function updateTitrePaiement(titre: Pick<TitreLookupRow, 'id' | 'montant' | 'statut'>, montantPaye: number) {
  let statut = titre.statut;
  if (montantPaye >= titre.montant) statut = 'paye';
  else if (montantPaye > 0) statut = 'paye_partiel';
  db.prepare('UPDATE titres SET montant_paye = ?, statut = ? WHERE id = ?').run(roundAmount(montantPaye), statut, titre.id);
  return statut;
}

function insertRapprochementLog(params: {
  ligneReleveId: number;
  titreId?: number | null;
  paiementId?: number | null;
  mode: RapprochementMode;
  resultat: RapprochementResult;
  commentaire?: string | null;
  userId?: number | null;
}) {
  const id = Number(
    db.prepare(
      `INSERT INTO rapprochements_log (
        ligne_releve_id, titre_id, paiement_id, mode, resultat, commentaire, user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      params.ligneReleveId,
      params.titreId ?? null,
      params.paiementId ?? null,
      params.mode,
      params.resultat,
      params.commentaire ?? null,
      params.userId ?? null,
    ).lastInsertRowid,
  );

  return db
    .prepare(
      `SELECT rl.id, rl.ligne_releve_id, lr.transaction_id, rl.mode, rl.resultat, rl.commentaire,
              t.numero AS numero_titre, rl.paiement_id, rl.user_id,
              CASE
                WHEN u.id IS NULL THEN NULL
                WHEN COALESCE(u.prenom, '') = '' AND COALESCE(u.nom, '') = '' THEN u.email
                ELSE trim(COALESCE(u.prenom, '') || ' ' || COALESCE(u.nom, ''))
              END AS user_display,
              rl.created_at
       FROM rapprochements_log rl
       JOIN lignes_releve lr ON lr.id = rl.ligne_releve_id
       LEFT JOIN titres t ON t.id = rl.titre_id
       LEFT JOIN users u ON u.id = rl.user_id
       WHERE rl.id = ?`,
    )
    .get(id) as RapprochementLogRow;
}

function createPaymentFromLine(params: {
  line: PendingLineRow;
  titre: TitreLookupRow;
  mode: RapprochementMode;
  commentaire?: string | null;
}) {
  const paymentReference = params.line.reference?.trim() || params.titre.numero;
  const paymentCommentaire = [
    params.mode === 'auto' ? 'Rapprochement automatique bancaire' : 'Rapprochement manuel bancaire',
    params.line.transaction_id,
    params.commentaire?.trim() || null,
  ]
    .filter(Boolean)
    .join(' · ');

  const paiementId = Number(
    db.prepare(
      `INSERT INTO paiements (
        titre_id, montant, date_paiement, modalite, reference, commentaire,
        provider, statut, transaction_id, callback_payload
      ) VALUES (?, ?, ?, 'virement', ?, ?, 'manuel', 'confirme', ?, ?)` ,
    ).run(
      params.titre.id,
      roundAmount(params.line.montant),
      params.line.date,
      paymentReference,
      paymentCommentaire,
      `rapprochement:${params.line.transaction_id}`,
      JSON.stringify({
        source: 'rapprochement-bancaire',
        mode: params.mode,
        ligne_releve_id: params.line.id,
        transaction_id: params.line.transaction_id,
      }),
    ).lastInsertRowid,
  );

  const montantPaye = roundAmount(params.titre.montant_paye + params.line.montant);
  const statut = updateTitrePaiement(params.titre, montantPaye);
  db.prepare('UPDATE lignes_releve SET rapproche = 1, paiement_id = ? WHERE id = ?').run(paiementId, params.line.id);

  return {
    paiementId,
    montantPaye,
    statut,
  };
}

function resolveTitreForLine(line: PendingLineRow) {
  const candidates = extractTitreCandidates(line);
  for (const candidate of candidates) {
    const titre = loadTitreByNumero(candidate);
    if (titre) {
      return titre;
    }
  }
  return null;
}

function buildWorkflowComment(resultat: RapprochementResult, line: PendingLineRow, titre?: TitreLookupRow | null) {
  if (resultat === 'errone') {
    return `Montant bancaire invalide pour un encaissement TLPE (${roundAmount(line.montant).toFixed(2)} €).`;
  }
  if (resultat === 'erreur_reference') {
    return `Aucun titre détecté dans le libellé/référence pour ${line.transaction_id}.`;
  }
  if (resultat === 'excedentaire') {
    const reste = titre ? roundAmount(titre.montant - titre.montant_paye) : null;
    return `Montant ${roundAmount(line.montant).toFixed(2)} € supérieur au reste à payer${reste === null ? '' : ` (${reste.toFixed(2)} €)`}.`;
  }
  if (resultat === 'partiel') {
    return `Paiement partiel rapproché sur ${titre?.numero ?? 'le titre ciblé'}.`;
  }
  return `Paiement rapproché sur ${titre?.numero ?? 'le titre ciblé'}.`;
}

export function importReleveBancaire(options: ImportRapprochementOptions): ImportRapprochementResult {
  const parsed = parseStatementFile({
    fileName: options.fileName,
    contentBase64: options.contentBase64,
    format: options.format,
    csvConfig: options.csvConfig,
  });

  const transactionIds = parsed.lignes.map((line) => line.transaction_id);
  const existingIds = listExistingTransactionIds(transactionIds);
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

export function runAutoRapprochement(userId: number, ip?: string | null): AutoRapprochementResult {
  const pendingLines = listPendingLinesForProcessing();
  if (pendingLines.length === 0) {
    return {
      matched_count: 0,
      pending_count: 0,
      payment_count: 0,
      logs: [],
    };
  }

  return db.transaction(() => {
    let matchedCount = 0;
    let paymentCount = 0;
    const logs: RapprochementLogRow[] = [];

    for (const line of pendingLines) {
      const titre = resolveTitreForLine(line);
      if (line.montant <= 0) {
        logs.push(
          insertRapprochementLog({
            ligneReleveId: line.id,
            mode: 'auto',
            resultat: 'errone',
            commentaire: buildWorkflowComment('errone', line, titre),
            userId,
          }),
        );
        continue;
      }
      if (!titre) {
        logs.push(
          insertRapprochementLog({
            ligneReleveId: line.id,
            mode: 'auto',
            resultat: 'erreur_reference',
            commentaire: buildWorkflowComment('erreur_reference', line, titre),
            userId,
          }),
        );
        continue;
      }

      const reste = roundAmount(titre.montant - titre.montant_paye);
      if (line.montant > reste) {
        logs.push(
          insertRapprochementLog({
            ligneReleveId: line.id,
            titreId: titre.id,
            mode: 'auto',
            resultat: 'excedentaire',
            commentaire: buildWorkflowComment('excedentaire', line, titre),
            userId,
          }),
        );
        continue;
      }

      const payment = createPaymentFromLine({
        line,
        titre,
        mode: 'auto',
      });
      const resultat: 'rapproche' | 'partiel' = line.montant < reste ? 'partiel' : 'rapproche';
      matchedCount += 1;
      paymentCount += 1;
      logs.push(
        insertRapprochementLog({
          ligneReleveId: line.id,
          titreId: titre.id,
          paiementId: payment.paiementId,
          mode: 'auto',
          resultat,
          commentaire: buildWorkflowComment(resultat, line, titre),
          userId,
        }),
      );

      logAudit({
        userId,
        ip: ip ?? null,
        action: 'rapprochement-auto',
        entite: 'titre',
        entiteId: titre.id,
        details: {
          transaction_id: line.transaction_id,
          ligne_releve_id: line.id,
          paiement_id: payment.paiementId,
          resultat,
          montant: roundAmount(line.montant),
        },
      });
    }

    return {
      matched_count: matchedCount,
      pending_count: pendingLines.length - matchedCount,
      payment_count: paymentCount,
      logs,
    } satisfies AutoRapprochementResult;
  })();
}

export function applyManualRapprochement(options: ManualRapprochementOptions): ManualRapprochementResult {
  const line = db
    .prepare(
      `SELECT id, releve_id, date, libelle, montant, reference, transaction_id, rapproche, paiement_id, raw_data
       FROM lignes_releve
       WHERE id = ?`,
    )
    .get(options.ligneId) as PendingLineRow | undefined;

  if (!line) {
    throw new RapprochementWorkflowError(404, 'Ligne de relevé introuvable');
  }
  if (line.rapproche) {
    throw new RapprochementWorkflowError(409, 'La ligne est déjà rapprochée');
  }
  if (line.montant <= 0) {
    throw new RapprochementWorkflowError(409, 'Le montant de la ligne ne permet pas un rapprochement manuel');
  }

  const titre = loadTitreByNumero(options.numeroTitre.trim().toUpperCase());
  if (!titre) {
    throw new RapprochementWorkflowError(404, 'Titre introuvable');
  }

  const reste = roundAmount(titre.montant - titre.montant_paye);
  if (reste <= 0) {
    throw new RapprochementWorkflowError(409, 'Le titre est déjà soldé');
  }
  if (line.montant > reste) {
    throw new RapprochementWorkflowError(409, 'Le montant de la ligne dépasse le reste à payer');
  }

  return db.transaction(() => {
    const payment = createPaymentFromLine({
      line,
      titre,
      mode: 'manuel',
      commentaire: options.commentaire,
    });
    const resultat: 'rapproche' | 'partiel' = line.montant < reste ? 'partiel' : 'rapproche';
    insertRapprochementLog({
      ligneReleveId: line.id,
      titreId: titre.id,
      paiementId: payment.paiementId,
      mode: 'manuel',
      resultat,
      commentaire: options.commentaire?.trim() || buildWorkflowComment(resultat, line, titre),
      userId: options.userId,
    });

    logAudit({
      userId: options.userId,
      ip: options.ip ?? null,
      action: 'rapprochement-manuel',
      entite: 'titre',
      entiteId: titre.id,
      details: {
        transaction_id: line.transaction_id,
        ligne_releve_id: line.id,
        paiement_id: payment.paiementId,
        resultat,
        montant: roundAmount(line.montant),
      },
    });

    return {
      ok: true,
      mode: 'manuel',
      resultat,
      statut: payment.statut,
      montant_paye: payment.montantPaye,
      paiement_id: payment.paiementId,
    } satisfies ManualRapprochementResult;
  })();
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
      `SELECT l.id, l.releve_id, l.date, l.libelle, l.montant, l.reference, l.transaction_id, l.rapproche, l.paiement_id, l.raw_data,
              COALESCE(last_log.resultat, 'en_attente') AS workflow,
              last_log.commentaire AS workflow_commentaire,
              t.numero AS numero_titre
       FROM lignes_releve l
       LEFT JOIN rapprochements_log last_log
         ON last_log.id = (
           SELECT rl.id
           FROM rapprochements_log rl
           WHERE rl.ligne_releve_id = l.id
           ORDER BY rl.created_at DESC, rl.id DESC
           LIMIT 1
         )
       LEFT JOIN titres t ON t.id = last_log.titre_id
       WHERE l.rapproche = 0
       ORDER BY l.date DESC, l.id DESC`,
    )
    .all() as LigneReleveRow[];
}

export function listRapprochementLogs(limit = 50): RapprochementLogRow[] {
  return db
    .prepare(
      `SELECT rl.id, rl.ligne_releve_id, lr.transaction_id, rl.mode, rl.resultat, rl.commentaire,
              t.numero AS numero_titre, rl.paiement_id, rl.user_id,
              CASE
                WHEN u.id IS NULL THEN NULL
                WHEN COALESCE(u.prenom, '') = '' AND COALESCE(u.nom, '') = '' THEN u.email
                ELSE trim(COALESCE(u.prenom, '') || ' ' || COALESCE(u.nom, ''))
              END AS user_display,
              rl.created_at
       FROM rapprochements_log rl
       JOIN lignes_releve lr ON lr.id = rl.ligne_releve_id
       LEFT JOIN titres t ON t.id = rl.titre_id
       LEFT JOIN users u ON u.id = rl.user_id
       ORDER BY rl.created_at DESC, rl.id DESC
       LIMIT ?`,
    )
    .all(limit) as RapprochementLogRow[];
}
