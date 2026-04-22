import XLSX from 'xlsx';
import { db, logAudit } from './db';

export interface RawImportRow {
  line: number;
  identifiant_tlpe?: string;
  raison_sociale?: string;
  siret?: string;
  forme_juridique?: string;
  adresse_rue?: string;
  adresse_cp?: string;
  adresse_ville?: string;
  adresse_pays?: string;
  contact_nom?: string;
  contact_prenom?: string;
  contact_fonction?: string;
  email?: string;
  telephone?: string;
  portail_actif?: string;
  statut?: string;
  notes?: string;
}

export interface ImportAnomaly {
  line: number;
  field: string;
  message: string;
}

export interface NormalizedImportRow {
  line: number;
  identifiant_tlpe: string | null;
  raison_sociale: string;
  siret: string | null;
  forme_juridique: string | null;
  adresse_rue: string | null;
  adresse_cp: string | null;
  adresse_ville: string | null;
  adresse_pays: string;
  contact_nom: string | null;
  contact_prenom: string | null;
  contact_fonction: string | null;
  email: string | null;
  telephone: string | null;
  portail_actif: number;
  statut: 'actif' | 'inactif' | 'radie' | 'contentieux';
  notes: string | null;
}

export interface ValidationResult {
  total: number;
  validRows: NormalizedImportRow[];
  anomalies: ImportAnomaly[];
}

export interface ImportExecutionResult {
  total: number;
  created: number;
  updated: number;
  rejected: number;
}

const HEADERS = [
  'identifiant_tlpe',
  'raison_sociale',
  'siret',
  'forme_juridique',
  'adresse_rue',
  'adresse_cp',
  'adresse_ville',
  'adresse_pays',
  'contact_nom',
  'contact_prenom',
  'contact_fonction',
  'email',
  'telephone',
  'portail_actif',
  'statut',
  'notes',
] as const;

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function toStringValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeBoolean(value: string): number {
  const v = value.trim().toLowerCase();
  if (!v) return 0;
  if (['1', 'true', 'oui', 'yes'].includes(v)) return 1;
  if (['0', 'false', 'non', 'no'].includes(v)) return 0;
  return -1;
}

function normalizeStatut(value: string): 'actif' | 'inactif' | 'radie' | 'contentieux' | null {
  const v = value.trim().toLowerCase();
  if (!v) return 'actif';
  if (v === 'actif' || v === 'inactif' || v === 'radie' || v === 'contentieux') return v;
  return null;
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Validation SIRET via algorithme de Luhn (specs section 4.1)
export function isValidSiret(siret: string): boolean {
  if (!/^\d{14}$/.test(siret)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    let d = Number(siret[i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function decodeCsv(contentBase64: string): RawImportRow[] {
  const csv = Buffer.from(contentBase64, 'base64').toString('utf-8');
  const workbook = XLSX.read(csv, { type: 'string' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return sheetToRows(sheet);
}

function decodeXlsx(contentBase64: string): RawImportRow[] {
  const buffer = Buffer.from(contentBase64, 'base64');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return sheetToRows(sheet);
}

function sheetToRows(sheet: XLSX.WorkSheet): RawImportRow[] {
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: '',
  });

  if (matrix.length < 2) return [];

  const headerRow = matrix[0].map((v) => normalizeHeader(toStringValue(v)));
  const indexes = new Map<string, number>();
  headerRow.forEach((h, idx) => indexes.set(h, idx));

  return matrix.slice(1).map((row, idx) => {
    const get = (name: string) => {
      const index = indexes.get(name);
      return index === undefined ? '' : toStringValue(row[index]);
    };

    return {
      line: idx + 2,
      identifiant_tlpe: get('identifiant_tlpe'),
      raison_sociale: get('raison_sociale'),
      siret: get('siret'),
      forme_juridique: get('forme_juridique'),
      adresse_rue: get('adresse_rue'),
      adresse_cp: get('adresse_cp'),
      adresse_ville: get('adresse_ville'),
      adresse_pays: get('adresse_pays'),
      contact_nom: get('contact_nom'),
      contact_prenom: get('contact_prenom'),
      contact_fonction: get('contact_fonction'),
      email: get('email'),
      telephone: get('telephone'),
      portail_actif: get('portail_actif'),
      statut: get('statut'),
      notes: get('notes'),
    };
  });
}

export function decodeAssujettisImportFile(fileName: string, contentBase64: string): RawImportRow[] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    return decodeXlsx(contentBase64);
  }
  return decodeCsv(contentBase64);
}

export function validateImportRows(rows: RawImportRow[]): ValidationResult {
  const anomalies: ImportAnomaly[] = [];
  const validRows: NormalizedImportRow[] = [];

  const seenIdentifiers = new Map<string, number>();
  const seenSirets = new Map<string, number>();

  const dbByIdentifier = db.prepare('SELECT id FROM assujettis WHERE identifiant_tlpe = ? LIMIT 1');
  const dbBySiret = db.prepare('SELECT id FROM assujettis WHERE siret = ? LIMIT 1');

  for (const row of rows) {
    const identifiant = (row.identifiant_tlpe || '').trim() || null;
    const raisonSociale = (row.raison_sociale || '').trim();
    const siret = (row.siret || '').trim() || null;
    const email = (row.email || '').trim() || null;

    if (!raisonSociale) {
      anomalies.push({ line: row.line, field: 'raison_sociale', message: 'Raison sociale obligatoire' });
    }

    if (!identifiant && !siret) {
      anomalies.push({ line: row.line, field: 'identifiant_tlpe/siret', message: 'Identifiant TLPE ou SIRET obligatoire' });
    }

    if (siret && !isValidSiret(siret)) {
      anomalies.push({ line: row.line, field: 'siret', message: 'SIRET invalide (controle Luhn)' });
    }

    if (email && !isValidEmail(email)) {
      anomalies.push({ line: row.line, field: 'email', message: 'Email invalide' });
    }

    const portail = normalizeBoolean(row.portail_actif || '');
    if (portail < 0) {
      anomalies.push({ line: row.line, field: 'portail_actif', message: 'Valeur booleenne invalide (attendu: oui/non, true/false, 1/0)' });
    }

    const statut = normalizeStatut(row.statut || '');
    if (!statut) {
      anomalies.push({ line: row.line, field: 'statut', message: 'Statut invalide (actif, inactif, radie, contentieux)' });
    }

    if (identifiant) {
      const previous = seenIdentifiers.get(identifiant);
      if (previous) {
        anomalies.push({ line: row.line, field: 'identifiant_tlpe', message: `Doublon dans le fichier (ligne ${previous})` });
      } else {
        seenIdentifiers.set(identifiant, row.line);
      }
    }

    if (siret) {
      const previous = seenSirets.get(siret);
      if (previous) {
        anomalies.push({ line: row.line, field: 'siret', message: `Doublon dans le fichier (ligne ${previous})` });
      } else {
        seenSirets.set(siret, row.line);
      }
    }

    const existingByIdentifier = identifiant ? (dbByIdentifier.get(identifiant) as { id: number } | undefined) : undefined;
    const existingBySiret = siret ? (dbBySiret.get(siret) as { id: number } | undefined) : undefined;

    if (existingByIdentifier && existingBySiret && existingByIdentifier.id !== existingBySiret.id) {
      anomalies.push({
        line: row.line,
        field: 'identifiant_tlpe/siret',
        message: 'Conflit de correspondance: identifiant_tlpe et siret pointent vers des assujettis differents',
      });
    }

    if (anomalies.some((a) => a.line === row.line)) {
      continue;
    }

    validRows.push({
      line: row.line,
      identifiant_tlpe: identifiant,
      raison_sociale: raisonSociale,
      siret,
      forme_juridique: (row.forme_juridique || '').trim() || null,
      adresse_rue: (row.adresse_rue || '').trim() || null,
      adresse_cp: (row.adresse_cp || '').trim() || null,
      adresse_ville: (row.adresse_ville || '').trim() || null,
      adresse_pays: (row.adresse_pays || '').trim() || 'France',
      contact_nom: (row.contact_nom || '').trim() || null,
      contact_prenom: (row.contact_prenom || '').trim() || null,
      contact_fonction: (row.contact_fonction || '').trim() || null,
      email,
      telephone: (row.telephone || '').trim() || null,
      portail_actif: portail,
      statut: statut || 'actif',
      notes: (row.notes || '').trim() || null,
    });
  }

  return {
    total: rows.length,
    validRows,
    anomalies,
  };
}

function genIdentifiantCandidate(): string {
  const y = new Date().getFullYear();
  const prefix = `TLPE-${y}-`;
  const row = db
    .prepare(
      `SELECT identifiant_tlpe
       FROM assujettis
       WHERE identifiant_tlpe LIKE ?
       ORDER BY identifiant_tlpe DESC
       LIMIT 1`,
    )
    .get(`${prefix}%`) as { identifiant_tlpe: string } | undefined;

  const current = row?.identifiant_tlpe?.slice(prefix.length) || '00000';
  const next = Number(current) + 1;
  return `${prefix}${String(next).padStart(5, '0')}`;
}

export function executeAssujettisImport(rows: NormalizedImportRow[], userId: number, ip?: string | null): ImportExecutionResult {
  const selectByIdentifier = db.prepare('SELECT id FROM assujettis WHERE identifiant_tlpe = ? LIMIT 1');
  const selectBySiret = db.prepare('SELECT id FROM assujettis WHERE siret = ? LIMIT 1');

  const insertStmt = db.prepare(
    `INSERT INTO assujettis (
      identifiant_tlpe, raison_sociale, siret, forme_juridique,
      adresse_rue, adresse_cp, adresse_ville, adresse_pays,
      contact_nom, contact_prenom, contact_fonction,
      email, telephone, portail_actif, statut, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const updateStmt = db.prepare(
    `UPDATE assujettis SET
      raison_sociale = ?, siret = ?, forme_juridique = ?,
      adresse_rue = ?, adresse_cp = ?, adresse_ville = ?, adresse_pays = ?,
      contact_nom = ?, contact_prenom = ?, contact_fonction = ?,
      email = ?, telephone = ?, portail_actif = ?, statut = ?, notes = ?,
      updated_at = datetime('now')
     WHERE id = ?`,
  );

  let created = 0;
  let updated = 0;

  const tx = db.transaction((items: NormalizedImportRow[]) => {
    for (const row of items) {
      let existing: { id: number } | undefined;
      if (row.identifiant_tlpe) {
        existing = selectByIdentifier.get(row.identifiant_tlpe) as { id: number } | undefined;
      }
      if (!existing && row.siret) {
        existing = selectBySiret.get(row.siret) as { id: number } | undefined;
      }

      if (existing) {
        updateStmt.run(
          row.raison_sociale,
          row.siret,
          row.forme_juridique,
          row.adresse_rue,
          row.adresse_cp,
          row.adresse_ville,
          row.adresse_pays,
          row.contact_nom,
          row.contact_prenom,
          row.contact_fonction,
          row.email,
          row.telephone,
          row.portail_actif,
          row.statut,
          row.notes,
          existing.id,
        );
        updated += 1;
      } else {
        let attempts = 0;
        while (attempts < 5) {
          attempts += 1;
          const identifiant = row.identifiant_tlpe || genIdentifiantCandidate();
          try {
            insertStmt.run(
              identifiant,
              row.raison_sociale,
              row.siret,
              row.forme_juridique,
              row.adresse_rue,
              row.adresse_cp,
              row.adresse_ville,
              row.adresse_pays,
              row.contact_nom,
              row.contact_prenom,
              row.contact_fonction,
              row.email,
              row.telephone,
              row.portail_actif,
              row.statut,
              row.notes,
            );
            created += 1;
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : '';
            if (!row.identifiant_tlpe && message.includes('assujettis.identifiant_tlpe') && attempts < 5) {
              continue;
            }
            throw error;
          }
        }
      }
    }
  });

  tx(rows);

  logAudit({
    userId,
    ip: ip ?? null,
    action: 'import',
    entite: 'assujetti',
    details: { total: rows.length, created, updated },
  });

  return {
    total: rows.length,
    created,
    updated,
    rejected: 0,
  };
}

export function assujettisImportTemplateCsv(): string {
  return `${HEADERS.join(',')}\n`;
}
