import XLSX from 'xlsx';
import { db, logAudit } from './db';
import { findZoneIdByPoint } from './zones';

export interface RawDispositifImportRow {
  line: number;
  identifiant_assujetti?: string;
  type_code?: string;
  adresse?: string;
  lat?: string;
  lon?: string;
  surface?: string;
  faces?: string;
  date_pose?: string;
  zone_code?: string;
  statut?: string;
}

export interface ImportAnomaly {
  line: number;
  field: string;
  message: string;
}

export interface NormalizedDispositifImportRow {
  line: number;
  assujetti_id: number;
  type_id: number;
  zone_id: number;
  adresse_rue: string | null;
  adresse_cp: string | null;
  adresse_ville: string | null;
  latitude: number | null;
  longitude: number | null;
  surface: number;
  nombre_faces: number;
  date_pose: string | null;
  statut: 'declare' | 'controle' | 'litigieux' | 'depose' | 'exonere';
}

export interface ValidationResult {
  total: number;
  validRows: NormalizedDispositifImportRow[];
  anomalies: ImportAnomaly[];
}

export interface ImportExecutionResult {
  total: number;
  created: number;
  rejected: number;
}

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  adresse?: string;
  codePostal?: string | null;
  ville?: string | null;
}

export interface ValidateOptions {
  geocodeWithBan?: boolean;
  geocodeFn?: (address: string) => Promise<GeocodeResult | null>;
}

const HEADERS = [
  'identifiant_assujetti',
  'type_code',
  'adresse',
  'lat',
  'lon',
  'surface',
  'faces',
  'date_pose',
  'zone_code',
  'statut',
] as const;

const statutValues = new Set(['declare', 'controle', 'litigieux', 'depose', 'exonere']);
const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoCalendarDate(value: string): boolean {
  if (!isoDateRegex.test(value)) return false;
  const [yearRaw, monthRaw, dayRaw] = value.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

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

function decodeCsv(contentBase64: string): RawDispositifImportRow[] {
  const csv = Buffer.from(contentBase64, 'base64').toString('utf-8');
  const workbook = XLSX.read(csv, { type: 'string' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return sheetToRows(sheet);
}

function decodeXlsx(contentBase64: string): RawDispositifImportRow[] {
  const buffer = Buffer.from(contentBase64, 'base64');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return sheetToRows(sheet);
}

function sheetToRows(sheet: XLSX.WorkSheet): RawDispositifImportRow[] {
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
      identifiant_assujetti: get('identifiant_assujetti'),
      type_code: get('type_code'),
      adresse: get('adresse'),
      lat: get('lat'),
      lon: get('lon'),
      surface: get('surface'),
      faces: get('faces'),
      date_pose: get('date_pose'),
      zone_code: get('zone_code'),
      statut: get('statut'),
    };
  });
}

export function decodeDispositifsImportFile(fileName: string, contentBase64: string): RawDispositifImportRow[] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    return decodeXlsx(contentBase64);
  }
  return decodeCsv(contentBase64);
}

async function geocodeBanAddress(address: string): Promise<GeocodeResult | null> {
  const endpoint = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(address)}&limit=1`;
  const response = await fetch(endpoint);
  if (!response.ok) return null;

  const payload = (await response.json()) as {
    features?: Array<{
      properties?: { label?: string; postcode?: string; city?: string };
      geometry?: { coordinates?: [number, number] };
    }>;
  };
  const coordinates = payload.features?.[0]?.geometry?.coordinates;
  if (!coordinates || coordinates.length < 2) return null;

  return {
    longitude: Number(coordinates[0]),
    latitude: Number(coordinates[1]),
    adresse: payload.features?.[0]?.properties?.label,
    codePostal: payload.features?.[0]?.properties?.postcode ?? null,
    ville: payload.features?.[0]?.properties?.city ?? null,
  };
}

function parseNumber(raw: string): number | null {
  if (!raw.trim()) return null;
  const normalized = raw.replace(',', '.');
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return value;
}

export async function validateDispositifsImportRows(
  rows: RawDispositifImportRow[],
  options: ValidateOptions = {},
): Promise<ValidationResult> {
  const anomalies: ImportAnomaly[] = [];
  const validRows: NormalizedDispositifImportRow[] = [];

  const assujettis = db.prepare('SELECT id, identifiant_tlpe FROM assujettis').all() as Array<{ id: number; identifiant_tlpe: string }>;
  const types = db.prepare('SELECT id, code FROM types_dispositifs').all() as Array<{ id: number; code: string }>;
  const zones = db.prepare('SELECT id, code FROM zones').all() as Array<{ id: number; code: string }>;

  const assujettiByIdentifier = new Map<string, number>(assujettis.map((a) => [a.identifiant_tlpe, a.id]));
  const typeByCode = new Map<string, number>(types.map((t) => [t.code, t.id]));
  const zoneByCode = new Map<string, number>(zones.map((z) => [z.code, z.id]));

  const geocodeCache = new Map<string, GeocodeResult | null>();
  const geocodeFn = options.geocodeFn ?? geocodeBanAddress;

  for (const row of rows) {
    const identifiantAssujetti = (row.identifiant_assujetti || '').trim();
    const typeCode = (row.type_code || '').trim();
    const adresse = (row.adresse || '').trim();
    const zoneCode = (row.zone_code || '').trim();

    if (!identifiantAssujetti) {
      anomalies.push({ line: row.line, field: 'identifiant_assujetti', message: 'Identifiant assujetti obligatoire' });
    }

    const assujettiId = assujettiByIdentifier.get(identifiantAssujetti);
    if (identifiantAssujetti && !assujettiId) {
      anomalies.push({ line: row.line, field: 'identifiant_assujetti', message: 'Assujetti inconnu' });
    }

    if (!typeCode) {
      anomalies.push({ line: row.line, field: 'type_code', message: 'Code type obligatoire' });
    }

    const typeId = typeByCode.get(typeCode);
    if (typeCode && !typeId) {
      anomalies.push({ line: row.line, field: 'type_code', message: 'Type dispositif inconnu' });
    }

    const surface = parseNumber(row.surface || '');
    if (!surface || surface <= 0) {
      anomalies.push({ line: row.line, field: 'surface', message: 'Surface invalide (doit etre > 0)' });
    }

    const faces = parseNumber(row.faces || '');
    if (!faces || !Number.isInteger(faces) || faces < 1 || faces > 4) {
      anomalies.push({ line: row.line, field: 'faces', message: 'Nombre de faces invalide (1 a 4)' });
    }

    const datePoseRaw = (row.date_pose || '').trim();
    if (datePoseRaw && !isValidIsoCalendarDate(datePoseRaw)) {
      anomalies.push({ line: row.line, field: 'date_pose', message: 'Date invalide (format attendu YYYY-MM-DD avec date calendrier valide)' });
    }

    const statutRaw = (row.statut || '').trim().toLowerCase();
    const statut = (statutRaw || 'declare') as NormalizedDispositifImportRow['statut'];
    if (!statutValues.has(statut)) {
      anomalies.push({ line: row.line, field: 'statut', message: 'Statut invalide (declare, controle, litigieux, depose, exonere)' });
    }

    let latitude = parseNumber(row.lat || '');
    let longitude = parseNumber(row.lon || '');
    if ((latitude === null) !== (longitude === null)) {
      anomalies.push({ line: row.line, field: 'lat/lon', message: 'Latitude et longitude doivent etre fournies ensemble' });
    }

    if (latitude !== null && (latitude < -90 || latitude > 90)) {
      anomalies.push({ line: row.line, field: 'lat', message: 'Latitude hors limites (-90 a 90)' });
    }
    if (longitude !== null && (longitude < -180 || longitude > 180)) {
      anomalies.push({ line: row.line, field: 'lon', message: 'Longitude hors limites (-180 a 180)' });
    }

    if (latitude === null && longitude === null && options.geocodeWithBan) {
      if (!adresse) {
        anomalies.push({ line: row.line, field: 'adresse', message: 'Adresse requise pour geocodage BAN' });
      } else {
        if (!geocodeCache.has(adresse)) {
          try {
            geocodeCache.set(adresse, await geocodeFn(adresse));
          } catch {
            geocodeCache.set(adresse, null);
          }
        }
        const geocode = geocodeCache.get(adresse) ?? null;
        if (geocode) {
          latitude = geocode.latitude;
          longitude = geocode.longitude;
        } else {
          anomalies.push({ line: row.line, field: 'adresse', message: 'Geocodage BAN impossible pour cette adresse' });
        }
      }
    }

    const addressParts = adresse.split(',').map((part) => part.trim()).filter(Boolean);
    let adresseRue = adresse || null;
    let adresseCp: string | null = null;
    let adresseVille: string | null = null;

    if (addressParts.length > 1) {
      adresseRue = addressParts[0];
      const cpVillePart = addressParts.slice(1).join(' ');
      const cpVilleMatch = cpVillePart.match(/(\d{5})\s+(.+)/);
      if (cpVilleMatch) {
        adresseCp = cpVilleMatch[1];
        adresseVille = cpVilleMatch[2].trim();
      } else {
        adresseVille = cpVillePart || null;
      }
    }

    const geocodeFromCache = adresse ? geocodeCache.get(adresse) ?? null : null;
    if (geocodeFromCache?.adresse?.trim()) {
      adresseRue = geocodeFromCache.adresse.trim();
    }
    if (geocodeFromCache?.codePostal) {
      adresseCp = geocodeFromCache.codePostal;
    }
    if (geocodeFromCache?.ville) {
      adresseVille = geocodeFromCache.ville;
    }

    let zoneId: number | undefined;
    if (zoneCode) {
      zoneId = zoneByCode.get(zoneCode);
      if (!zoneId) {
        anomalies.push({ line: row.line, field: 'zone_code', message: 'Zone inconnue' });
      }
    } else if (latitude !== null && longitude !== null) {
      zoneId = findZoneIdByPoint({ latitude, longitude }) ?? undefined;
      if (!zoneId) {
        anomalies.push({ line: row.line, field: 'zone_code', message: 'Zone introuvable pour les coordonnees' });
      }
    } else {
      anomalies.push({ line: row.line, field: 'zone_code', message: 'Zone obligatoire (zone_code ou coordonnees geolocalisees)' });
    }

    if (anomalies.some((a) => a.line === row.line)) {
      continue;
    }

    validRows.push({
      line: row.line,
      assujetti_id: assujettiId!,
      type_id: typeId!,
      zone_id: zoneId!,
      adresse_rue: adresseRue,
      adresse_cp: adresseCp,
      adresse_ville: adresseVille,
      latitude,
      longitude,
      surface: surface!,
      nombre_faces: faces!,
      date_pose: datePoseRaw || null,
      statut,
    });
  }

  return {
    total: rows.length,
    validRows,
    anomalies,
  };
}

function makeIdentifiantsGenerator(): () => string {
  const year = new Date().getFullYear();
  const prefix = `DSP-${year}-`;
  const row = db
    .prepare(
      `SELECT identifiant
       FROM dispositifs
       WHERE identifiant LIKE ?
       ORDER BY identifiant DESC
       LIMIT 1`,
    )
    .get(`${prefix}%`) as { identifiant: string } | undefined;

  const current = Number(row?.identifiant.slice(prefix.length) || 0);
  let cursor = Number.isFinite(current) ? current : 0;

  return () => {
    cursor += 1;
    return `${prefix}${String(cursor).padStart(6, '0')}`;
  };
}

export function executeDispositifsImport(rows: NormalizedDispositifImportRow[], userId: number, ip?: string | null): ImportExecutionResult {
  const insertStmt = db.prepare(
    `INSERT INTO dispositifs (
      identifiant, assujetti_id, type_id, zone_id,
      adresse_rue, adresse_cp, adresse_ville, latitude, longitude,
      surface, nombre_faces, date_pose, statut, exonere, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
  );

  let created = 0;
  const nextIdentifiant = makeIdentifiantsGenerator();

  const tx = db.transaction((items: NormalizedDispositifImportRow[]) => {
    for (const row of items) {
      insertStmt.run(
        nextIdentifiant(),
        row.assujetti_id,
        row.type_id,
        row.zone_id,
        row.adresse_rue,
        row.adresse_cp,
        row.adresse_ville,
        row.latitude,
        row.longitude,
        row.surface,
        row.nombre_faces,
        row.date_pose,
        row.statut,
      );
      created += 1;
    }
  });

  tx(rows);

  logAudit({
    userId,
    ip: ip ?? null,
    action: 'import',
    entite: 'dispositif',
    details: { total: rows.length, created },
  });

  return {
    total: rows.length,
    created,
    rejected: 0,
  };
}

export function dispositifsImportTemplateCsv(): string {
  return `${HEADERS.join(',')}\n`;
}
