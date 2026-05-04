import { Router, type Response } from 'express';
import XLSX from 'xlsx';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../auth';
import { db, logAudit } from '../db';

export const exportsPersonnalisesRouter = Router();

exportsPersonnalisesRouter.use(authMiddleware);
exportsPersonnalisesRouter.use(requireRole('admin', 'gestionnaire', 'financier'));

type ExportEntityKey = 'assujettis' | 'dispositifs' | 'declarations' | 'titres' | 'paiements' | 'contentieux';
type ExportFilterOperator = 'eq' | 'contains' | 'gte' | 'lte';
type ColumnType = 'text' | 'number' | 'date' | 'boolean';

type FilterConfig = {
  colonne: string;
  operateur: ExportFilterOperator;
  valeur: string;
};

type ExportConfig = {
  entite: ExportEntityKey;
  colonnes: string[];
  filtres: FilterConfig[];
  ordre?: {
    colonne: string;
    direction: 'asc' | 'desc';
  } | null;
};

type EntityColumnDefinition = {
  key: string;
  label: string;
  sql: string;
  type: ColumnType;
  filterOperators: ExportFilterOperator[];
};

type EntityDefinition = {
  key: ExportEntityKey;
  label: string;
  fromSql: string;
  defaultColumns: string[];
  defaultOrder: {
    colonne: string;
    direction: 'asc' | 'desc';
  };
  columns: EntityColumnDefinition[];
};

class ExportValidationError extends Error {}

function isExportValidationError(error: unknown): error is ExportValidationError {
  return error instanceof ExportValidationError;
}

function handleExportRouteError(res: Response, error: unknown, action: string) {
  if (isExportValidationError(error)) {
    return res.status(400).json({ error: error.message });
  }
  console.error(`[TLPE] Erreur ${action} exports personnalisés`, error);
  return res.status(500).json({ error: 'Erreur interne export personnalisé' });
}

const FILTER_OPERATORS: Array<{ value: ExportFilterOperator; label: string }> = [
  { value: 'eq', label: 'Égal à' },
  { value: 'contains', label: 'Contient' },
  { value: 'gte', label: 'Supérieur ou égal' },
  { value: 'lte', label: 'Inférieur ou égal' },
];

const exportFormatSchema = z.object({
  format: z.enum(['csv', 'xlsx']),
});

const filterSchema = z.object({
  colonne: z.string().min(1),
  operateur: z.enum(['eq', 'contains', 'gte', 'lte']),
  valeur: z.string().min(1),
});

const exportConfigSchema = z.object({
  entite: z.enum(['assujettis', 'dispositifs', 'declarations', 'titres', 'paiements', 'contentieux']),
  colonnes: z.array(z.string().min(1)).min(1).max(20),
  filtres: z.array(filterSchema).max(10).default([]),
  ordre: z
    .object({
      colonne: z.string().min(1),
      direction: z.enum(['asc', 'desc']),
    })
    .optional()
    .nullable(),
});

const templateSchema = z.object({
  nom: z.string().trim().min(1).max(100),
  entite: z.enum(['assujettis', 'dispositifs', 'declarations', 'titres', 'paiements', 'contentieux']),
  configuration: z.object({
    colonnes: z.array(z.string().min(1)).min(1).max(20),
    filtres: z.array(filterSchema).max(10).default([]),
    ordre: z
      .object({
        colonne: z.string().min(1),
        direction: z.enum(['asc', 'desc']),
      })
      .optional()
      .nullable(),
  }),
});

const ENTITIES: EntityDefinition[] = [
  {
    key: 'assujettis',
    label: 'Assujettis',
    fromSql: 'FROM assujettis a',
    defaultColumns: ['raison_sociale', 'siret', 'statut'],
    defaultOrder: { colonne: 'raison_sociale', direction: 'asc' },
    columns: [
      { key: 'identifiant_tlpe', label: 'Identifiant TLPE', sql: 'a.identifiant_tlpe', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'raison_sociale', label: 'Raison sociale', sql: 'a.raison_sociale', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'siret', label: 'SIRET', sql: 'a.siret', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'adresse_ville', label: 'Ville', sql: 'a.adresse_ville', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'email', label: 'Email', sql: 'a.email', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'portail_actif', label: 'Portail actif', sql: 'a.portail_actif', type: 'boolean', filterOperators: ['eq'] },
      { key: 'statut', label: 'Statut', sql: 'a.statut', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'created_at', label: 'Créé le', sql: 'a.created_at', type: 'date', filterOperators: ['eq', 'gte', 'lte', 'contains'] },
    ],
  },
  {
    key: 'dispositifs',
    label: 'Dispositifs',
    fromSql: `FROM dispositifs d
      LEFT JOIN assujettis a ON a.id = d.assujetti_id
      LEFT JOIN types_dispositifs td ON td.id = d.type_id
      LEFT JOIN zones z ON z.id = d.zone_id`,
    defaultColumns: ['identifiant', 'assujetti', 'categorie', 'statut'],
    defaultOrder: { colonne: 'identifiant', direction: 'asc' },
    columns: [
      { key: 'identifiant', label: 'Identifiant', sql: 'd.identifiant', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'assujetti', label: 'Assujetti', sql: 'a.raison_sociale', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'categorie', label: 'Catégorie', sql: 'td.categorie', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'type_dispositif', label: 'Type de dispositif', sql: 'td.libelle', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'zone', label: 'Zone', sql: 'z.libelle', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'surface', label: 'Surface (m²)', sql: 'd.surface', type: 'number', filterOperators: ['eq', 'gte', 'lte'] },
      { key: 'nombre_faces', label: 'Nombre de faces', sql: 'd.nombre_faces', type: 'number', filterOperators: ['eq', 'gte', 'lte'] },
      { key: 'adresse_ville', label: 'Ville', sql: 'd.adresse_ville', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'statut', label: 'Statut', sql: 'd.statut', type: 'text', filterOperators: ['eq', 'contains'] },
    ],
  },
  {
    key: 'declarations',
    label: 'Déclarations',
    fromSql: `FROM declarations d
      LEFT JOIN assujettis a ON a.id = d.assujetti_id`,
    defaultColumns: ['numero', 'assujetti', 'annee', 'statut'],
    defaultOrder: { colonne: 'numero', direction: 'desc' },
    columns: [
      { key: 'numero', label: 'Numéro', sql: 'd.numero', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'assujetti', label: 'Assujetti', sql: 'a.raison_sociale', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'annee', label: 'Année', sql: 'd.annee', type: 'number', filterOperators: ['eq', 'gte', 'lte'] },
      { key: 'statut', label: 'Statut', sql: 'd.statut', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'date_soumission', label: 'Date de soumission', sql: 'd.date_soumission', type: 'date', filterOperators: ['eq', 'gte', 'lte', 'contains'] },
      { key: 'date_validation', label: 'Date de validation', sql: 'd.date_validation', type: 'date', filterOperators: ['eq', 'gte', 'lte', 'contains'] },
      { key: 'montant_total', label: 'Montant total', sql: 'd.montant_total', type: 'number', filterOperators: ['eq', 'gte', 'lte'] },
      { key: 'alerte_gestionnaire', label: 'Alerte gestionnaire', sql: 'd.alerte_gestionnaire', type: 'boolean', filterOperators: ['eq'] },
    ],
  },
  {
    key: 'titres',
    label: 'Titres',
    fromSql: `FROM titres t
      LEFT JOIN assujettis a ON a.id = t.assujetti_id`,
    defaultColumns: ['numero', 'assujetti', 'montant', 'statut'],
    defaultOrder: { colonne: 'numero', direction: 'desc' },
    columns: [
      { key: 'numero', label: 'Numéro', sql: 't.numero', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'assujetti', label: 'Assujetti', sql: 'a.raison_sociale', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'annee', label: 'Année', sql: 't.annee', type: 'number', filterOperators: ['eq', 'gte', 'lte'] },
      { key: 'montant', label: 'Montant', sql: 't.montant', type: 'number', filterOperators: ['eq', 'gte', 'lte'] },
      { key: 'montant_paye', label: 'Montant payé', sql: 't.montant_paye', type: 'number', filterOperators: ['eq', 'gte', 'lte'] },
      { key: 'date_emission', label: 'Date d’émission', sql: 't.date_emission', type: 'date', filterOperators: ['eq', 'gte', 'lte', 'contains'] },
      { key: 'date_echeance', label: 'Date d’échéance', sql: 't.date_echeance', type: 'date', filterOperators: ['eq', 'gte', 'lte', 'contains'] },
      { key: 'statut', label: 'Statut', sql: 't.statut', type: 'text', filterOperators: ['eq', 'contains'] },
    ],
  },
  {
    key: 'paiements',
    label: 'Paiements',
    fromSql: `FROM paiements p
      LEFT JOIN titres t ON t.id = p.titre_id
      LEFT JOIN assujettis a ON a.id = t.assujetti_id`,
    defaultColumns: ['reference', 'titre_numero', 'assujetti', 'montant'],
    defaultOrder: { colonne: 'date_paiement', direction: 'desc' },
    columns: [
      { key: 'reference', label: 'Référence', sql: 'p.reference', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'titre_numero', label: 'Titre', sql: 't.numero', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'assujetti', label: 'Assujetti', sql: 'a.raison_sociale', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'montant', label: 'Montant', sql: 'p.montant', type: 'number', filterOperators: ['eq', 'gte', 'lte'] },
      { key: 'date_paiement', label: 'Date de paiement', sql: 'p.date_paiement', type: 'date', filterOperators: ['eq', 'gte', 'lte', 'contains'] },
      { key: 'modalite', label: 'Modalité', sql: 'p.modalite', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'provider', label: 'Canal', sql: 'p.provider', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'statut', label: 'Statut', sql: 'p.statut', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'transaction_id', label: 'Transaction', sql: 'p.transaction_id', type: 'text', filterOperators: ['eq', 'contains'] },
    ],
  },
  {
    key: 'contentieux',
    label: 'Contentieux',
    fromSql: `FROM contentieux c
      LEFT JOIN assujettis a ON a.id = c.assujetti_id
      LEFT JOIN titres t ON t.id = c.titre_id`,
    defaultColumns: ['numero', 'assujetti', 'type', 'statut'],
    defaultOrder: { colonne: 'date_ouverture', direction: 'desc' },
    columns: [
      { key: 'numero', label: 'Numéro', sql: 'c.numero', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'assujetti', label: 'Assujetti', sql: 'a.raison_sociale', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'titre_numero', label: 'Titre lié', sql: 't.numero', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'type', label: 'Type', sql: 'c.type', type: 'text', filterOperators: ['eq', 'contains'] },
      { key: 'montant_litige', label: 'Montant litigé', sql: 'c.montant_litige', type: 'number', filterOperators: ['eq', 'gte', 'lte'] },
      { key: 'montant_degreve', label: 'Montant dégrevé', sql: 'c.montant_degreve', type: 'number', filterOperators: ['eq', 'gte', 'lte'] },
      { key: 'date_ouverture', label: 'Date d’ouverture', sql: 'c.date_ouverture', type: 'date', filterOperators: ['eq', 'gte', 'lte', 'contains'] },
      { key: 'date_limite_reponse', label: 'Date limite de réponse', sql: 'c.date_limite_reponse', type: 'date', filterOperators: ['eq', 'gte', 'lte', 'contains'] },
      { key: 'statut', label: 'Statut', sql: 'c.statut', type: 'text', filterOperators: ['eq', 'contains'] },
    ],
  },
];

function getEntityDefinition(key: ExportEntityKey): EntityDefinition {
  const entity = ENTITIES.find((item) => item.key === key);
  if (!entity) {
    throw new ExportValidationError(`Entité d'export inconnue: ${key}`);
  }
  return entity;
}

function getColumnDefinition(entity: EntityDefinition, key: string): EntityColumnDefinition | undefined {
  return entity.columns.find((column) => column.key === key);
}

function validateExportConfig(config: ExportConfig) {
  const entity = getEntityDefinition(config.entite);
  const uniqueColumns = Array.from(new Set(config.colonnes));
  if (uniqueColumns.length === 0) {
    throw new ExportValidationError('Au moins une colonne doit être sélectionnée');
  }

  for (const columnKey of uniqueColumns) {
    if (!getColumnDefinition(entity, columnKey)) {
      throw new ExportValidationError(`Colonne inconnue pour ${entity.label}: ${columnKey}`);
    }
  }

  for (const filter of config.filtres) {
    const column = getColumnDefinition(entity, filter.colonne);
    if (!column) {
      throw new ExportValidationError(`Filtre invalide: colonne ${filter.colonne} introuvable`);
    }
    if (!column.filterOperators.includes(filter.operateur)) {
      throw new ExportValidationError(`Opérateur ${filter.operateur} non autorisé sur la colonne ${column.label}`);
    }
  }

  if (config.ordre) {
    const orderColumn = getColumnDefinition(entity, config.ordre.colonne);
    if (!orderColumn) {
      throw new ExportValidationError(`Tri invalide: colonne ${config.ordre.colonne} introuvable`);
    }
  }

  return {
    entity,
    selectedColumns: uniqueColumns.map((key) => getColumnDefinition(entity, key)!).filter(Boolean),
  };
}

function normalizeBooleanValue(value: string): number {
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'oui', 'yes', 'actif'].includes(normalized)) return 1;
  if (['0', 'false', 'non', 'no', 'inactif'].includes(normalized)) return 0;
  throw new ExportValidationError(`Valeur booléenne invalide: ${value}`);
}

function coerceFilterValue(column: EntityColumnDefinition, value: string): string | number {
  if (column.type === 'number') {
    const numeric = Number(value);
    if (Number.isNaN(numeric)) {
      throw new ExportValidationError(`La colonne ${column.label} attend une valeur numérique`);
    }
    return numeric;
  }
  if (column.type === 'boolean') {
    return normalizeBooleanValue(value);
  }
  return value;
}

function buildWhereClause(entity: EntityDefinition, filters: FilterConfig[]) {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  for (const filter of filters) {
    const column = getColumnDefinition(entity, filter.colonne);
    if (!column) continue;

    switch (filter.operateur) {
      case 'contains':
        clauses.push(`LOWER(CAST(${column.sql} AS TEXT)) LIKE LOWER(?)`);
        params.push(`%${filter.valeur}%`);
        break;
      case 'gte':
        clauses.push(`${column.sql} >= ?`);
        params.push(coerceFilterValue(column, filter.valeur));
        break;
      case 'lte':
        clauses.push(`${column.sql} <= ?`);
        params.push(coerceFilterValue(column, filter.valeur));
        break;
      case 'eq':
      default:
        clauses.push(`${column.sql} = ?`);
        params.push(coerceFilterValue(column, filter.valeur));
        break;
    }
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function buildOrderClause(entity: EntityDefinition, order?: ExportConfig['ordre']) {
  const fallbackColumn = getColumnDefinition(entity, entity.defaultOrder.colonne)!;
  const selectedColumn = order ? getColumnDefinition(entity, order.colonne) ?? fallbackColumn : fallbackColumn;
  const direction = order?.direction === 'desc' ? 'DESC' : order?.direction === 'asc' ? 'ASC' : entity.defaultOrder.direction.toUpperCase();
  return `ORDER BY ${selectedColumn.sql} ${direction}`;
}

function executeExportQuery(config: ExportConfig, limit?: number) {
  const { entity, selectedColumns } = validateExportConfig(config);
  const where = buildWhereClause(entity, config.filtres);
  const order = buildOrderClause(entity, config.ordre);
  const selectSql = selectedColumns.map((column) => `${column.sql} AS "${column.key}"`).join(', ');
  const count = (
    db.prepare(`SELECT COUNT(*) AS c ${entity.fromSql} ${where.sql}`).get(...where.params) as { c: number }
  ).c;

  const limitClause = typeof limit === 'number' ? 'LIMIT ?' : '';
  const params = typeof limit === 'number' ? [...where.params, limit] : where.params;
  const rows = db
    .prepare(`SELECT ${selectSql} ${entity.fromSql} ${where.sql} ${order} ${limitClause}`)
    .all(...params) as Array<Record<string, string | number | null>>;

  return {
    entity,
    columns: selectedColumns.map((column) => ({
      key: column.key,
      label: column.label,
      type: column.type,
    })),
    rows,
    total: count,
  };
}

function formatCell(value: string | number | null | undefined): string | number {
  if (value === null || value === undefined) return '';
  return value;
}

function sanitizeCsvFormulaInjection(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function csvEscape(value: string | number): string {
  const text = sanitizeCsvFormulaInjection(String(value));
  if (/[";\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildCsvBuffer(columns: Array<{ key: string; label: string }>, rows: Array<Record<string, string | number | null>>) {
  const lines = [
    columns.map((column) => csvEscape(column.label)).join(';'),
    ...rows.map((row) => columns.map((column) => csvEscape(formatCell(row[column.key]))).join(';')),
  ];
  return Buffer.from(`\uFEFF${lines.join('\n')}`, 'utf8');
}

function buildXlsxBuffer(columns: Array<{ key: string; label: string }>, rows: Array<Record<string, string | number | null>>) {
  const worksheet = XLSX.utils.aoa_to_sheet([
    columns.map((column) => column.label),
    ...rows.map((row) => columns.map((column) => formatCell(row[column.key]))),
  ]);
  worksheet['!cols'] = columns.map((column) => ({ wch: Math.max(column.label.length + 2, 18) }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Export');
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
}

function sanitizeFilenamePart(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function buildExportFilename(entity: ExportEntityKey, format: 'csv' | 'xlsx') {
  return `export-${sanitizeFilenamePart(entity)}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${format}`;
}

function parseTemplateConfig(raw: string): ExportConfig {
  const parsed = JSON.parse(raw) as Omit<ExportConfig, 'entite'>;
  return {
    entite: 'assujettis',
    colonnes: parsed.colonnes,
    filtres: parsed.filtres ?? [],
    ordre: parsed.ordre ?? null,
  };
}

exportsPersonnalisesRouter.get('/meta', (_req, res) => {
  res.json({
    operators: FILTER_OPERATORS,
    entities: ENTITIES.map((entity) => ({
      key: entity.key,
      label: entity.label,
      defaultColumns: entity.defaultColumns,
      defaultOrder: entity.defaultOrder,
      columns: entity.columns.map((column) => ({
        key: column.key,
        label: column.label,
        type: column.type,
        filterOperators: column.filterOperators,
      })),
    })),
  });
});

exportsPersonnalisesRouter.post('/preview', (req, res) => {
  const parsed = exportConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const config: ExportConfig = {
    entite: parsed.data.entite,
    colonnes: [...parsed.data.colonnes],
    filtres: [...parsed.data.filtres],
    ordre: parsed.data.ordre ?? null,
  };

  try {
    const preview = executeExportQuery(config, 50);
    return res.json(preview);
  } catch (error) {
    return handleExportRouteError(res, error, 'preview');
  }
});

exportsPersonnalisesRouter.post('/export', (req, res) => {
  const parsedConfig = exportConfigSchema.safeParse(req.body);
  const parsedFormat = exportFormatSchema.safeParse(req.query);
  if (!parsedConfig.success || !parsedFormat.success) {
    return res.status(400).json({ error: 'Configuration d’export invalide' });
  }

  const config: ExportConfig = {
    entite: parsedConfig.data.entite,
    colonnes: [...parsedConfig.data.colonnes],
    filtres: [...parsedConfig.data.filtres],
    ordre: parsedConfig.data.ordre ?? null,
  };

  try {
    const dataset = executeExportQuery(config);
    const filename = buildExportFilename(config.entite, parsedFormat.data.format);
    const buffer = parsedFormat.data.format === 'csv'
      ? buildCsvBuffer(dataset.columns, dataset.rows)
      : buildXlsxBuffer(dataset.columns, dataset.rows);

    logAudit({
      userId: req.user!.id,
      action: 'export-personnalise',
      entite: 'export_personnalise',
      details: {
        entite: config.entite,
        format: parsedFormat.data.format,
        colonnes: config.colonnes,
        filtres: config.filtres,
        ordre: config.ordre,
        rows_count: dataset.total,
      },
      ip: req.ip ?? null,
    });

    res.setHeader(
      'Content-Type',
      parsedFormat.data.format === 'csv'
        ? 'text/csv; charset=utf-8'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buffer);
  } catch (error) {
    return handleExportRouteError(res, error, 'export');
  }
});

exportsPersonnalisesRouter.get('/templates', (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, nom, entite, configuration, created_at, updated_at
       FROM exports_sauvegardes
       WHERE user_id = ?
       ORDER BY updated_at DESC, id DESC`,
    )
    .all(req.user!.id) as Array<{
      id: number;
      nom: string;
      entite: ExportEntityKey;
      configuration: string;
      created_at: string;
      updated_at: string;
    }>;

  return res.json(
    rows.map((row) => ({
      id: row.id,
      nom: row.nom,
      entite: row.entite,
      configuration: {
        ...parseTemplateConfig(row.configuration),
        entite: row.entite,
      },
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
  );
});

exportsPersonnalisesRouter.post('/templates', (req, res) => {
  const parsed = templateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const config: ExportConfig = {
    entite: parsed.data.entite,
    colonnes: [...parsed.data.configuration.colonnes],
    filtres: [...parsed.data.configuration.filtres],
    ordre: parsed.data.configuration.ordre ?? null,
  };

  try {
    validateExportConfig(config);
  } catch (error) {
    return handleExportRouteError(res, error, 'validation');
  }

  db.prepare(
    `INSERT INTO exports_sauvegardes (user_id, nom, entite, configuration)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, nom)
     DO UPDATE SET entite = excluded.entite, configuration = excluded.configuration, updated_at = datetime('now')`,
  ).run(req.user!.id, parsed.data.nom, parsed.data.entite, JSON.stringify(parsed.data.configuration));

  const saved = db
    .prepare(
      `SELECT id, nom, entite, configuration, created_at, updated_at
       FROM exports_sauvegardes
       WHERE user_id = ? AND nom = ?`,
    )
    .get(req.user!.id, parsed.data.nom) as
    | { id: number; nom: string; entite: ExportEntityKey; configuration: string; created_at: string; updated_at: string }
    | undefined;

  if (!saved) {
    return res.status(500).json({ error: 'Enregistrement du modèle impossible' });
  }

  logAudit({
    userId: req.user!.id,
    action: 'save-export-template',
    entite: 'export_personnalise',
    entiteId: saved.id,
    details: {
      nom: saved.nom,
      entite: saved.entite,
    },
    ip: req.ip ?? null,
  });

  return res.status(201).json({
    id: saved.id,
    nom: saved.nom,
    entite: saved.entite,
    configuration: {
      ...parseTemplateConfig(saved.configuration),
      entite: saved.entite,
    },
    created_at: saved.created_at,
    updated_at: saved.updated_at,
  });
});

exportsPersonnalisesRouter.delete('/templates/:id', (req, res) => {
  const existing = db
    .prepare('SELECT id, nom FROM exports_sauvegardes WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user!.id) as { id: number; nom: string } | undefined;

  if (!existing) {
    return res.status(404).json({ error: 'Modèle introuvable' });
  }

  db.prepare('DELETE FROM exports_sauvegardes WHERE id = ?').run(existing.id);

  logAudit({
    userId: req.user!.id,
    action: 'delete-export-template',
    entite: 'export_personnalise',
    entiteId: existing.id,
    details: { nom: existing.nom },
    ip: req.ip ?? null,
  });

  return res.status(204).send();
});
