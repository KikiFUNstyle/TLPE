import * as crypto from 'node:crypto';

export type StatementFormat = 'csv' | 'ofx' | 'mt940';

export interface CsvImportConfig {
  delimiter?: string;
  dateColumn?: string;
  labelColumn?: string;
  amountColumn?: string;
  referenceColumn?: string;
  transactionIdColumn?: string;
  debitColumn?: string;
  creditColumn?: string;
  dateFormat?: 'auto' | 'yyyy-mm-dd' | 'dd/mm/yyyy' | 'yyyymmdd';
}

export interface ParsedStatementLine {
  date: string;
  libelle: string;
  montant: number;
  reference: string | null;
  transaction_id: string;
  raw_data: string;
}

export interface ParsedStatement {
  format: StatementFormat;
  fileName: string;
  accountId: string | null;
  dateDebut: string | null;
  dateFin: string | null;
  lignes: ParsedStatementLine[];
}

export class StatementImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatementImportValidationError';
  }
}

function invalidStatement(message: string): never {
  throw new StatementImportValidationError(message);
}

function sha1(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeTextContent(contentBase64: string): string {
  return Buffer.from(contentBase64, 'base64').toString('utf-8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

function detectFormat(fileName: string, explicitFormat?: StatementFormat): StatementFormat {
  if (explicitFormat) return explicitFormat;
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.ofx')) return 'ofx';
  if (lower.endsWith('.mt940') || lower.endsWith('.sta') || lower.endsWith('.940')) return 'mt940';
  return 'csv';
}

function parseSignedAmount(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\s+/g, '').replace(/€|eur/gi, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const value = Number(normalized);
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function parseDate(raw: string, format: CsvImportConfig['dateFormat'] = 'auto'): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const tryIso = (value: string) => {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const [, y, m, d] = match;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return date.getUTCFullYear() === Number(y) && date.getUTCMonth() + 1 === Number(m) && date.getUTCDate() === Number(d)
      ? `${y}-${m}-${d}`
      : null;
  };

  const tryDmy = (value: string) => {
    const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) return null;
    const [, d, m, y] = match;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return date.getUTCFullYear() === Number(y) && date.getUTCMonth() + 1 === Number(m) && date.getUTCDate() === Number(d)
      ? `${y}-${m}-${d}`
      : null;
  };

  const tryCompact = (value: string) => {
    const digits = value.replace(/\D/g, '');
    if (digits.length < 8) return null;
    const y = digits.slice(0, 4);
    const m = digits.slice(4, 6);
    const d = digits.slice(6, 8);
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return date.getUTCFullYear() === Number(y) && date.getUTCMonth() + 1 === Number(m) && date.getUTCDate() === Number(d)
      ? `${y}-${m}-${d}`
      : null;
  };

  if (format === 'yyyy-mm-dd') return tryIso(trimmed);
  if (format === 'dd/mm/yyyy') return tryDmy(trimmed);
  if (format === 'yyyymmdd') return tryCompact(trimmed);
  return tryIso(trimmed) ?? tryDmy(trimmed) ?? tryCompact(trimmed);
}

function detectDelimiter(line: string): string {
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = -1;
  for (const candidate of candidates) {
    const count = line.split(candidate).length;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function parseDelimitedRows(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        currentCell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      currentRow.push(currentCell.trim());
      currentCell = '';
      continue;
    }

    if (!inQuotes && char === '\n') {
      currentRow.push(currentCell.trim());
      rows.push(currentRow);
      currentRow = [];
      currentCell = '';
      continue;
    }

    currentCell += char;
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    rows.push(currentRow);
  }

  return rows.filter((row) => row.some((cell) => cell.length > 0));
}

function resolveColumnIndex(header: string[], configuredName: string | undefined, defaults: string[]): number {
  const candidates = [configuredName, ...defaults]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => normalizeHeader(value));

  for (const candidate of candidates) {
    const index = header.indexOf(candidate);
    if (index >= 0) return index;
  }

  return -1;
}

function buildTransactionId(prefix: StatementFormat, input: {
  date: string;
  libelle: string;
  montant: number;
  reference: string | null;
  candidate?: string | null;
}) {
  const explicit = input.candidate?.trim();
  if (explicit) return `${prefix}:${explicit}`;
  return `${prefix}:${sha1(`${input.date}|${input.libelle}|${input.montant.toFixed(2)}|${input.reference ?? ''}`)}`;
}

function parseCsvStatement(content: string, fileName: string, config: CsvImportConfig = {}): ParsedStatement {
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    invalidStatement('Le fichier CSV doit contenir un en-tête et au moins une ligne');
  }

  const delimiter = config.delimiter && config.delimiter.length > 0 ? config.delimiter : detectDelimiter(lines[0]);
  const rows = parseDelimitedRows(content, delimiter);
  if (rows.length < 2) {
    invalidStatement('Le fichier CSV ne contient aucune ligne exploitable');
  }

  const header = rows[0].map((cell) => normalizeHeader(cell));
  const dateIndex = resolveColumnIndex(header, config.dateColumn, ['date', 'date_operation', 'booking_date', 'operation_date']);
  const labelIndex = resolveColumnIndex(header, config.labelColumn, ['libelle', 'label', 'description', 'operation']);
  const amountIndex = resolveColumnIndex(header, config.amountColumn, ['montant', 'amount']);
  const referenceIndex = resolveColumnIndex(header, config.referenceColumn, ['reference', 'ref', 'reference_operation']);
  const transactionIdIndex = resolveColumnIndex(header, config.transactionIdColumn, ['transaction_id', 'id_transaction', 'fitid', 'bank_id']);
  const debitIndex = resolveColumnIndex(header, config.debitColumn, ['debit']);
  const creditIndex = resolveColumnIndex(header, config.creditColumn, ['credit']);

  if (dateIndex < 0) invalidStatement('Colonne date introuvable dans le CSV');
  if (labelIndex < 0) invalidStatement('Colonne libellé introuvable dans le CSV');
  if (amountIndex < 0 && debitIndex < 0 && creditIndex < 0) {
    invalidStatement('Configurer une colonne montant ou des colonnes débit/crédit pour le CSV');
  }

  const parsedLines: ParsedStatementLine[] = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const date = parseDate(row[dateIndex] ?? '', config.dateFormat ?? 'auto');
    const libelle = (row[labelIndex] ?? '').trim();
    const reference = referenceIndex >= 0 ? ((row[referenceIndex] ?? '').trim() || null) : null;

    let montant: number | null = null;
    if (amountIndex >= 0) {
      montant = parseSignedAmount(row[amountIndex] ?? '');
    } else {
      const credit = creditIndex >= 0 ? parseSignedAmount(row[creditIndex] ?? '') ?? 0 : 0;
      const debit = debitIndex >= 0 ? parseSignedAmount(row[debitIndex] ?? '') ?? 0 : 0;
      montant = Number((credit - debit).toFixed(2));
    }

    if (!date || !libelle || montant === null || montant === 0) continue;

    const explicitTransactionId = transactionIdIndex >= 0 ? (row[transactionIdIndex] ?? '').trim() : null;
    const transaction_id = buildTransactionId('csv', {
      date,
      libelle,
      montant,
      reference,
      candidate: explicitTransactionId || reference,
    });

    parsedLines.push({
      date,
      libelle,
      montant,
      reference,
      transaction_id,
      raw_data: JSON.stringify(Object.fromEntries(header.map((name, index) => [name, row[index] ?? '']))),
    });
  }

  return {
    format: 'csv',
    fileName,
    accountId: null,
    dateDebut: parsedLines[0]?.date ?? null,
    dateFin: parsedLines[parsedLines.length - 1]?.date ?? null,
    lignes: parsedLines,
  };
}

function extractOfxTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}>([^<\n\r]+)`, 'i'));
  return match ? match[1].trim() : null;
}

function parseOfxDate(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  return parseDate(digits, 'yyyymmdd');
}

function parseOfxStatement(content: string, fileName: string): ParsedStatement {
  const normalized = content.replace(/\r/g, '');
  const blocks = [...normalized.matchAll(/<STMTTRN>([\s\S]*?)(?=<STMTTRN>|<\/BANKTRANLIST>|$)/gi)].map((match) => match[1]);
  const lignes = blocks
    .map((block) => {
      const date = parseOfxDate(extractOfxTag(block, 'DTPOSTED'));
      const libelle = extractOfxTag(block, 'NAME') ?? extractOfxTag(block, 'MEMO') ?? 'Opération OFX';
      const montant = parseSignedAmount(extractOfxTag(block, 'TRNAMT') ?? '');
      const reference = extractOfxTag(block, 'MEMO');
      const fitid = extractOfxTag(block, 'FITID');
      if (!date || montant === null) return null;
      return {
        date,
        libelle,
        montant,
        reference,
        transaction_id: buildTransactionId('ofx', { date, libelle, montant, reference, candidate: fitid }),
        raw_data: JSON.stringify({
          trntype: extractOfxTag(block, 'TRNTYPE'),
          dtposted: extractOfxTag(block, 'DTPOSTED'),
          trnamt: extractOfxTag(block, 'TRNAMT'),
          fitid,
          name: extractOfxTag(block, 'NAME'),
          memo: extractOfxTag(block, 'MEMO'),
        }),
      } satisfies ParsedStatementLine;
    })
    .filter((line): line is ParsedStatementLine => Boolean(line));

  return {
    format: 'ofx',
    fileName,
    accountId: extractOfxTag(normalized, 'ACCTID'),
    dateDebut: parseOfxDate(extractOfxTag(normalized, 'DTSTART')),
    dateFin: parseOfxDate(extractOfxTag(normalized, 'DTEND')),
    lignes,
  };
}

function parseMt940ValueDate(raw: string): string | null {
  const match = raw.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, yy, mm, dd] = match;
  const year = Number(yy) >= 70 ? `19${yy}` : `20${yy}`;
  return parseDate(`${year}${mm}${dd}`, 'yyyymmdd');
}

function parseMt940References(rest: string) {
  const delimiterIndex = rest.indexOf('//');
  const customerSegment = delimiterIndex >= 0 ? rest.slice(0, delimiterIndex) : rest;
  const bankSegment = delimiterIndex >= 0 ? rest.slice(delimiterIndex + 2) : '';
  const customerReference = customerSegment.slice(4).trim();
  return {
    customerReference: customerReference || null,
    bankReference: bankSegment.trim() || null,
  };
}

function parseMt940Statement(content: string, fileName: string): ParsedStatement {
  const lines = content.replace(/\r/g, '').split('\n');
  const parsedLines: ParsedStatementLine[] = [];
  let accountId: string | null = null;
  let dateDebut: string | null = null;
  let dateFin: string | null = null;
  let current:
    | {
        date: string;
        montant: number;
        reference: string | null;
        transactionId: string | null;
        libelle: string;
        raw61: string;
      }
    | null = null;

  const flushCurrent = () => {
    if (!current) return;
    parsedLines.push({
      date: current.date,
      libelle: current.libelle,
      montant: current.montant,
      reference: current.reference,
      transaction_id: buildTransactionId('mt940', {
        date: current.date,
        libelle: current.libelle,
        montant: current.montant,
        reference: current.reference,
        candidate: current.transactionId ?? current.reference,
      }),
      raw_data: JSON.stringify({ line61: current.raw61, libelle: current.libelle }),
    });
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith(':25:')) {
      accountId = line.slice(4).trim() || null;
      continue;
    }
    if (line.startsWith(':60F:') || line.startsWith(':60M:')) {
      dateDebut = parseMt940ValueDate(line.slice(6, 12));
      continue;
    }
    if (line.startsWith(':62F:') || line.startsWith(':62M:')) {
      dateFin = parseMt940ValueDate(line.slice(6, 12));
      continue;
    }
    if (line.startsWith(':61:')) {
      flushCurrent();
      const payload = line.slice(4).trim();
      const valueDate = parseMt940ValueDate(payload.slice(0, 6));
      if (!valueDate) continue;
      let rest = payload.slice(6);
      if (/^\d{4}/.test(rest)) rest = rest.slice(4);

      let sign = 1;
      if (rest.startsWith('R')) {
        rest = rest.slice(1);
        sign = -1;
      }
      const dc = rest[0];
      if (dc === 'D') sign *= -1;
      rest = rest.slice(1);
      if (/^[A-Z]/.test(rest)) rest = rest.slice(1);
      const amountMatch = rest.match(/^([0-9,]+)/);
      if (!amountMatch) continue;
      const amount = parseSignedAmount(amountMatch[1]);
      if (amount === null) continue;
      rest = rest.slice(amountMatch[1].length);
      const { customerReference, bankReference } = parseMt940References(rest);
      current = {
        date: valueDate,
        montant: Number((amount * sign).toFixed(2)),
        reference: customerReference,
        transactionId: bankReference,
        libelle: customerReference ?? 'Opération MT940',
        raw61: payload,
      };
      continue;
    }
    if (line.startsWith(':86:') && current) {
      current.libelle = line.slice(4).trim() || current.libelle;
      continue;
    }
  }

  flushCurrent();

  return {
    format: 'mt940',
    fileName,
    accountId,
    dateDebut,
    dateFin,
    lignes: parsedLines,
  };
}

export function parseStatementFile(input: {
  fileName: string;
  contentBase64: string;
  format?: StatementFormat;
  csvConfig?: CsvImportConfig;
}): ParsedStatement {
  const format = detectFormat(input.fileName, input.format);
  const content = normalizeTextContent(input.contentBase64);

  const parsed =
    format === 'ofx'
      ? parseOfxStatement(content, input.fileName)
      : format === 'mt940'
        ? parseMt940Statement(content, input.fileName)
        : parseCsvStatement(content, input.fileName, input.csvConfig);

  if (parsed.lignes.length === 0) {
    invalidStatement(`Aucune ligne exploitable détectée dans le fichier ${input.fileName}`);
  }

  return parsed;
}
