import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../auth';
import { db, logAudit } from '../db';

export const auditLogRouter = Router();

auditLogRouter.use(authMiddleware);
auditLogRouter.use(requireRole('admin'));

function isValidIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return !Number.isNaN(date.getTime())
    && date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

const isoCalendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => isValidIsoCalendarDate(value), 'Date calendrier invalide');

const auditLogQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional().default(1),
    page_size: z.coerce.number().int().min(1).max(200).optional().default(25),
    user_id: z.coerce.number().int().positive().optional(),
    entite: z.string().trim().min(1).max(120).optional(),
    action: z.string().trim().min(1).max(120).optional(),
    q: z.string().trim().min(1).max(200).optional(),
    date_debut: isoCalendarDateSchema.optional(),
    date_fin: isoCalendarDateSchema.optional(),
    format: z.enum(['json', 'csv']).optional().default('json'),
  })
  .refine((value) => {
    if (!value.date_debut || !value.date_fin) return true;
    return value.date_debut <= value.date_fin;
  }, {
    message: 'La date de début doit être antérieure ou égale à la date de fin',
    path: ['date_fin'],
  });

type AuditLogFilters = z.infer<typeof auditLogQuerySchema>;

type AuditLogRow = {
  id: number;
  created_at: string;
  user_id: number | null;
  user_email: string | null;
  user_display: string;
  action: string;
  entite: string;
  entite_id: number | null;
  details: string | null;
  ip: string | null;
};

function buildAuditWhere(filters: AuditLogFilters) {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (filters.user_id) {
    clauses.push('a.user_id = ?');
    params.push(filters.user_id);
  }
  if (filters.entite) {
    clauses.push('a.entite = ?');
    params.push(filters.entite);
  }
  if (filters.action) {
    clauses.push('a.action = ?');
    params.push(filters.action);
  }
  if (filters.date_debut) {
    clauses.push('date(a.created_at) >= date(?)');
    params.push(filters.date_debut);
  }
  if (filters.date_fin) {
    clauses.push('date(a.created_at) <= date(?)');
    params.push(filters.date_fin);
  }
  if (filters.q) {
    clauses.push(`(
      LOWER(COALESCE(a.details, '')) LIKE LOWER(?)
      OR LOWER(COALESCE(a.action, '')) LIKE LOWER(?)
      OR LOWER(COALESCE(a.entite, '')) LIKE LOWER(?)
      OR LOWER(COALESCE(u.email, '')) LIKE LOWER(?)
      OR LOWER(COALESCE(u.prenom || ' ' || u.nom, '')) LIKE LOWER(?)
    )`);
    const q = `%${filters.q}%`;
    params.push(q, q, q, q, q);
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function selectAuditRows(filters: AuditLogFilters, withPagination: boolean) {
  const where = buildAuditWhere(filters);
  const total = (
    db.prepare(`
      SELECT COUNT(*) AS c
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id
      ${where.sql}
    `).get(...where.params) as { c: number }
  ).c;

  const page = filters.page;
  const pageSize = filters.page_size;
  const offset = (page - 1) * pageSize;
  const paginationSql = withPagination ? 'LIMIT ? OFFSET ?' : '';
  const paginationParams = withPagination ? [pageSize, offset] : [];

  const rows = db.prepare(`
    SELECT
      a.id,
      a.created_at,
      a.user_id,
      u.email AS user_email,
      CASE
        WHEN u.id IS NOT NULL THEN trim(COALESCE(u.prenom, '') || ' ' || COALESCE(u.nom, ''))
        ELSE ''
      END AS user_name,
      a.action,
      a.entite,
      a.entite_id,
      a.details,
      a.ip
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.user_id
    ${where.sql}
    ORDER BY a.created_at DESC, a.id DESC
    ${paginationSql}
  `).all(...where.params, ...paginationParams) as Array<{
    id: number;
    created_at: string;
    user_id: number | null;
    user_email: string | null;
    user_name: string;
    action: string;
    entite: string;
    entite_id: number | null;
    details: string | null;
    ip: string | null;
  }>;

  const normalizedRows: AuditLogRow[] = rows.map((row) => ({
    id: row.id,
    created_at: row.created_at,
    user_id: row.user_id,
    user_email: row.user_email,
    user_display: row.user_name || row.user_email || 'Système',
    action: row.action,
    entite: row.entite,
    entite_id: row.entite_id,
    details: row.details,
    ip: row.ip,
  }));

  return {
    total,
    rows: normalizedRows,
  };
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

function buildCsvBuffer(rows: AuditLogRow[]) {
  const columns = [
    { key: 'created_at', label: 'Horodatage' },
    { key: 'user_display', label: 'Utilisateur' },
    { key: 'action', label: 'Action' },
    { key: 'entite', label: 'Entité' },
    { key: 'details', label: 'Détails' },
    { key: 'ip', label: 'IP' },
  ] as const;

  const lines = [
    columns.map((column) => csvEscape(column.label)).join(';'),
    ...rows.map((row) => columns.map((column) => csvEscape((row[column.key] ?? '') as string | number)).join(';')),
  ];
  return Buffer.from(`\uFEFF${lines.join('\n')}`, 'utf8');
}

function buildExportFilename(filters: AuditLogFilters) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (filters.date_debut && filters.date_fin) {
    return `audit-log-${filters.date_debut}_${filters.date_fin}.csv`;
  }
  return `audit-log-${timestamp}.csv`;
}

function readOptions() {
  const users = db.prepare(`
    SELECT id, email, trim(COALESCE(prenom, '') || ' ' || COALESCE(nom, '')) AS user_name
    FROM users
    WHERE actif = 1
    ORDER BY lower(email) ASC
  `).all() as Array<{ id: number; email: string; user_name: string }>;

  const actions = db.prepare(`SELECT DISTINCT action FROM audit_log ORDER BY lower(action) ASC`).all() as Array<{ action: string }>;
  const entites = db.prepare(`SELECT DISTINCT entite FROM audit_log ORDER BY lower(entite) ASC`).all() as Array<{ entite: string }>;

  return {
    users: users.map((user) => ({
      id: user.id,
      label: user.user_name || user.email,
      email: user.email,
    })),
    actions: actions.map((row) => row.action),
    entites: entites.map((row) => row.entite),
  };
}

auditLogRouter.get('/', (req, res) => {
  const parsed = auditLogQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const filters = parsed.data;
  const dataset = selectAuditRows(filters, filters.format !== 'csv');

  if (filters.format === 'csv') {
    const filename = buildExportFilename(filters);
    const buffer = buildCsvBuffer(dataset.rows);
    logAudit({
      userId: req.user!.id,
      action: 'export-audit-log',
      entite: 'audit_log',
      details: {
        format: 'csv',
        rows_count: dataset.total,
        filtres: {
          user_id: filters.user_id ?? null,
          entite: filters.entite ?? null,
          action: filters.action ?? null,
          q: filters.q ?? null,
          date_debut: filters.date_debut ?? null,
          date_fin: filters.date_fin ?? null,
        },
      },
      ip: req.ip ?? null,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buffer);
  }

  return res.json({
    page: filters.page,
    page_size: filters.page_size,
    total: dataset.total,
    total_pages: Math.max(1, Math.ceil(dataset.total / filters.page_size)),
    rows: dataset.rows,
    options: readOptions(),
  });
});
