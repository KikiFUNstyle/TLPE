import { db, logAudit } from './db';

export type BaremeCategorie = 'publicitaire' | 'preenseigne' | 'enseigne';

export interface BaremeInput {
  annee: number;
  categorie: BaremeCategorie;
  surface_min: number;
  surface_max?: number | null;
  tarif_m2?: number | null;
  tarif_fixe?: number | null;
  exonere?: boolean;
  libelle: string;
}

export interface BaremeImportSummary {
  total: number;
  created: number;
  updated: number;
}

export class BaremeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaremeValidationError';
  }
}

function parseNumberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const v = value.trim();
  if (!v) return null;
  const normalized = v.replace(',', '.');
  const n = Number(normalized);
  if (Number.isNaN(n)) throw new Error(`Valeur numerique invalide: "${value}"`);
  return n;
}

function parseBoolean(value: string | undefined): boolean {
  const v = (value || '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'oui' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'non' || v === 'no') return false;
  throw new BaremeValidationError(`exonere invalide: ${value}`);
}

function asCategorie(value: string): BaremeCategorie {
  const v = value.trim().toLowerCase();
  if (v === 'publicitaire' || v === 'preenseigne' || v === 'enseigne') return v;
  throw new Error(`Categorie invalide: "${value}"`);
}

function splitCsvLine(line: string, delimiter: ',' | ';'): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && ch === delimiter) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out;
}

function detectDelimiter(headerLine: string): ',' | ';' {
  const semiCount = (headerLine.match(/;/g) || []).length;
  const commaCount = (headerLine.match(/,/g) || []).length;
  return semiCount > commaCount ? ';' : ',';
}

export function parseBaremesCsv(csv: string): BaremeInput[] {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) {
    throw new BaremeValidationError('CSV invalide: au moins un en-tete et une ligne sont requis');
  }

  const delimiter = detectDelimiter(lines[0]);
  const header = splitCsvLine(lines[0], delimiter).map((h) => h.toLowerCase());
  const required = ['annee', 'categorie', 'surface_min', 'surface_max', 'libelle', 'exonere'];
  for (const col of required) {
    if (!header.includes(col)) {
      throw new BaremeValidationError(`CSV invalide: colonne manquante "${col}"`);
    }
  }

  const idx = (name: string) => header.indexOf(name);

  return lines.slice(1).map((line, lineOffset) => {
    const values = splitCsvLine(line, delimiter);
    const get = (name: string) => {
      const i = idx(name);
      if (i < 0) return undefined;
      return values[i];
    };

    try {
      const annee = Number(get('annee'));
      if (!Number.isInteger(annee) || annee < 2008 || annee > 2100) {
        throw new Error(`Annee invalide: ${get('annee')}`);
      }

      const surfaceMin = parseNumberOrNull(get('surface_min'));
      if (surfaceMin === null || surfaceMin < 0) {
        throw new Error(`surface_min invalide: ${get('surface_min')}`);
      }

      const surfaceMax = parseNumberOrNull(get('surface_max'));
      if (surfaceMax === null) {
        throw new BaremeValidationError('surface_max obligatoire pour l\'import CSV');
      }
      const tarifM2 = parseNumberOrNull(get('tarif_m2'));
      const tarifFixe = parseNumberOrNull(get('tarif_fixe'));
      const exonereRaw = get('exonere');
      const libelle = (get('libelle') || '').trim();

      if (surfaceMax <= 0) {
        throw new BaremeValidationError(`surface_max invalide: ${get('surface_max')}`);
      }
      if (surfaceMax <= surfaceMin) {
        throw new BaremeValidationError(`surface_max doit etre > surface_min: ${get('surface_max')}`);
      }
      if (tarifM2 !== null && tarifM2 < 0) {
        throw new BaremeValidationError(`tarif_m2 invalide: ${get('tarif_m2')}`);
      }
      if (tarifFixe !== null && tarifFixe < 0) {
        throw new BaremeValidationError(`tarif_fixe invalide: ${get('tarif_fixe')}`);
      }
      if (!libelle) {
        throw new BaremeValidationError('libelle obligatoire');
      }
      if (exonereRaw === undefined || !exonereRaw.trim()) {
        throw new BaremeValidationError('exonere obligatoire pour l\'import CSV');
      }

      return {
        annee,
        categorie: asCategorie(get('categorie') || ''),
        surface_min: surfaceMin,
        surface_max: surfaceMax,
        tarif_m2: tarifM2,
        tarif_fixe: tarifFixe,
        exonere: parseBoolean(get('exonere')),
        libelle,
      } satisfies BaremeInput;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erreur inconnue';
      if (message.startsWith(`Ligne ${lineOffset + 2}:`)) {
        throw new BaremeValidationError(message);
      }
      throw new BaremeValidationError(`Ligne ${lineOffset + 2}: ${message}`);
    }
  });
}

export function upsertBaremes(rows: BaremeInput[], userId: number, ip?: string | null): BaremeImportSummary {
  const findStmt = db.prepare(
    `SELECT id FROM baremes
     WHERE annee = ? AND categorie = ? AND surface_min = ? AND (surface_max IS ? OR surface_max = ?)
     LIMIT 1`,
  );

  const insertStmt = db.prepare(
    `INSERT INTO baremes (annee, categorie, surface_min, surface_max, tarif_m2, tarif_fixe, exonere, libelle)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const updateStmt = db.prepare(
    `UPDATE baremes
     SET tarif_m2 = ?, tarif_fixe = ?, exonere = ?, libelle = ?
     WHERE id = ?`,
  );

  let created = 0;
  let updated = 0;

  const tx = db.transaction((items: BaremeInput[]) => {
    for (const row of items) {
      const existing = findStmt.get(
        row.annee,
        row.categorie,
        row.surface_min,
        row.surface_max ?? null,
        row.surface_max ?? null,
      ) as { id: number } | undefined;

      if (existing) {
        updateStmt.run(row.tarif_m2 ?? null, row.tarif_fixe ?? null, row.exonere ? 1 : 0, row.libelle, existing.id);
        updated += 1;
        logAudit({
          userId,
          ip: ip ?? null,
          action: 'update',
          entite: 'bareme',
          entiteId: existing.id,
          details: row,
        });
      } else {
        const info = insertStmt.run(
          row.annee,
          row.categorie,
          row.surface_min,
          row.surface_max ?? null,
          row.tarif_m2 ?? null,
          row.tarif_fixe ?? null,
          row.exonere ? 1 : 0,
          row.libelle,
        );
        const id = Number(info.lastInsertRowid);
        created += 1;
        logAudit({
          userId,
          ip: ip ?? null,
          action: 'create',
          entite: 'bareme',
          entiteId: id,
          details: row,
        });
      }
    }
  });

  tx(rows);
  return { total: rows.length, created, updated };
}

export function activateBaremesForYear(year: number, nowIso: string = new Date().toISOString()): boolean {
  const hasRows = db
    .prepare('SELECT COUNT(*) AS c FROM baremes WHERE annee = ?')
    .get(year) as { c: number };

  if (hasRows.c === 0) return false;

  const insertIfMissing = db.prepare(
    `INSERT OR IGNORE INTO bareme_activation (annee, activated_at)
     VALUES (?, ?)`,
  );

  const info = insertIfMissing.run(year, nowIso);
  if (info.changes === 0) return false;

  logAudit({
    userId: null,
    action: 'activate',
    entite: 'bareme_annee',
    entiteId: year,
    details: { annee: year, activated_at: nowIso },
    ip: null,
  });

  return true;
}

export function getActiveBaremeYear(referenceDate: Date = new Date()): number | null {
  const year = referenceDate.getUTCFullYear();

  const activated = db
    .prepare(
      `SELECT ba.annee
       FROM bareme_activation ba
       JOIN baremes b ON b.annee = ba.annee
       WHERE ba.annee <= ?
       ORDER BY ba.annee DESC
       LIMIT 1`,
    )
    .get(year) as { annee: number } | undefined;

  if (activated) return activated.annee;

  const exact = db.prepare('SELECT annee FROM baremes WHERE annee = ? LIMIT 1').get(year) as
    | { annee: number }
    | undefined;
  if (exact) return exact.annee;

  const latest = db
    .prepare('SELECT annee FROM baremes WHERE annee <= ? ORDER BY annee DESC LIMIT 1')
    .get(year) as { annee: number } | undefined;

  return latest?.annee ?? null;
}
