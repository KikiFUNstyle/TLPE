import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../auth';
import { db, logAudit } from '../db';

export const notificationsRouter = Router();

notificationsRouter.use(authMiddleware);
notificationsRouter.use(requireRole('admin', 'gestionnaire'));

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

const validStatuses = ['pending', 'envoye', 'echec'] as const;

const notificationsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional().default(1),
    page_size: z.coerce.number().int().min(1).max(200).optional().default(25),
    statut: z.enum(validStatuses).optional(),
    email_destinataire: z.string().trim().min(1).max(320).optional(),
    template_code: z.string().trim().min(1).max(120).optional(),
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

type NotificationsFilters = z.infer<typeof notificationsQuerySchema>;

type NotificationRow = {
  id: number;
  created_at: string;
  assujetti_id: number;
  email_destinataire: string;
  objet: string;
  template_code: string;
  statut: string;
  sent_at: string | null;
  erreur: string | null;
  tentatives: number;
  mode: string;
  relance_niveau: string | null;
  campagne_id: number | null;
  assujetti_siret: string | null;
  assujetti_denomination: string | null;
};

const STATUT_LABELS: Record<string, string> = {
  pending: 'En attente',
  envoye: 'Envoyé',
  echec: 'Échec',
};

function buildStatusLabel(statut: string): string {
  return STATUT_LABELS[statut] ?? statut;
}

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (char) => `\\${char}`);
}

function buildWhere(filters: NotificationsFilters) {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (filters.statut) {
    clauses.push('n.statut = ?');
    params.push(filters.statut);
  }
  if (filters.email_destinataire) {
    clauses.push("LOWER(n.email_destinataire) LIKE LOWER(?) ESCAPE '\\'");
    params.push(`%${escapeLike(filters.email_destinataire)}%`);
  }
  if (filters.template_code) {
    clauses.push('n.template_code = ?');
    params.push(filters.template_code);
  }
  if (filters.date_debut) {
    clauses.push('date(COALESCE(n.sent_at, n.created_at)) >= date(?)');
    params.push(filters.date_debut);
  }
  if (filters.date_fin) {
    clauses.push('date(COALESCE(n.sent_at, n.created_at)) <= date(?)');
    params.push(filters.date_fin);
  }
  if (filters.q) {
    clauses.push(`(
      LOWER(COALESCE(n.email_destinataire, '')) LIKE LOWER(?) ESCAPE '\\'
      OR LOWER(COALESCE(n.objet, '')) LIKE LOWER(?) ESCAPE '\\'
      OR LOWER(COALESCE(a.raison_sociale, '')) LIKE LOWER(?) ESCAPE '\\'
      OR LOWER(COALESCE(a.siret, '')) LIKE LOWER(?) ESCAPE '\\'
      OR LOWER(COALESCE(n.template_code, '')) LIKE LOWER(?) ESCAPE '\\'
    )`);
    const q = `%${escapeLike(filters.q)}%`;
    params.push(q, q, q, q, q);
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function selectRows(filters: NotificationsFilters, withPagination: boolean) {
  const where = buildWhere(filters);
  const total = (
    db.prepare(`
      SELECT COUNT(*) AS c
      FROM notifications_email n
      LEFT JOIN assujettis a ON a.id = n.assujetti_id
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
      n.id,
      n.created_at,
      n.assujetti_id,
      n.campagne_id,
      n.email_destinataire,
      n.objet,
      n.template_code,
      n.statut,
      n.sent_at,
      n.erreur,
      n.tentatives,
      n.mode,
      n.relance_niveau,
      a.siret AS assujetti_siret,
      a.raison_sociale AS assujetti_denomination
    FROM notifications_email n
    LEFT JOIN assujettis a ON a.id = n.assujetti_id
    ${where.sql}
    ORDER BY n.created_at DESC, n.id DESC
    ${paginationSql}
  `).all(...where.params, ...paginationParams) as NotificationRow[];

  return {
    total,
    rows,
  };
}

function sanitizeCsvFormulaInjection(value: string): string {
  return /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
}

function csvEscape(value: string | number | null): string {
  const text = sanitizeCsvFormulaInjection(value == null ? '' : String(value));
  if (/[";\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildCsvBuffer(rows: NotificationRow[]) {
  const columns = [
    { key: 'created_at', label: 'Date' },
    { key: 'email_destinataire', label: 'Destinataire' },
    { key: 'objet', label: 'Sujet' },
    { key: 'statut', label: 'Statut' },
    { key: 'template_code', label: 'Template' },
    { key: 'mode', label: 'Mode' },
    { key: 'sent_at', label: 'Envoyé le' },
    { key: 'erreur', label: 'Erreur' },
    { key: 'tentatives', label: 'Tentatives' },
    { key: 'assujetti_siret', label: 'SIRET assujetti' },
    { key: 'assujetti_denomination', label: 'Assujetti' },
  ] as const;

  const lines = [
    columns.map((column) => csvEscape(column.label)).join(';'),
    ...rows.map((row) =>
      columns.map((column) =>
        csvEscape(column.key === 'statut' ? buildStatusLabel((row as Record<string, unknown>)[column.key] as string) : (row as Record<string, unknown>)[column.key] as string | number | null),
      ).join(';'),
    ),
  ];
  return Buffer.from(`\uFEFF${lines.join('\n')}`, 'utf8');
}

function buildExportFilename(filters: NotificationsFilters) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (filters.date_debut && filters.date_fin) {
    return `notifications-${filters.date_debut}_${filters.date_fin}.csv`;
  }
  return `notifications-${timestamp}.csv`;
}

function readOptions() {
  const statuses = validStatuses.map((s) => ({ value: s, label: buildStatusLabel(s) }));
  const templates = db.prepare(
    `SELECT DISTINCT template_code FROM notifications_email ORDER BY template_code ASC`,
  ).all() as Array<{ template_code: string }>;

  return {
    statuses,
    templates: templates.map((t) => t.template_code),
  };
}

notificationsRouter.get('/', (req, res) => {
  const parsed = notificationsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const filters = parsed.data;
  const dataset = selectRows(filters, filters.format !== 'csv');

  if (filters.format === 'csv') {
    const filename = buildExportFilename(filters);
    const buffer = buildCsvBuffer(dataset.rows);
    logAudit({
      userId: req.user!.id,
      action: 'export-notifications',
      entite: 'notification_email',
      details: {
        format: 'csv',
        rows_count: dataset.total,
        filtres: {
          statut: filters.statut ?? null,
          email_destinataire: filters.email_destinataire ?? null,
          template_code: filters.template_code ?? null,
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
    rows: dataset.rows.map((row) => ({
      ...row,
      statut_label: buildStatusLabel(row.statut),
    })),
    options: readOptions(),
  });
});

notificationsRouter.post('/:id/resend', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'ID de notification invalide' });
  }

  const notification = db.prepare(
    `SELECT id, statut FROM notifications_email WHERE id = ?`,
  ).get(id) as { id: number; statut: string } | undefined;

  if (!notification) {
    return res.status(404).json({ error: 'Notification introuvable' });
  }

  if (notification.statut !== 'echec') {
    return res.status(400).json({ error: 'Seules les notifications en échec peuvent être renvoyées' });
  }

  db.prepare(`
    UPDATE notifications_email
    SET statut = 'pending',
        tentatives = 0,
        erreur = NULL,
        prochain_essai_at = NULL
    WHERE id = ?
  `).run(id);

  logAudit({
    userId: req.user!.id,
    action: 'resend-notification',
    entite: 'notification_email',
    entiteId: id,
    details: {},
    ip: req.ip ?? null,
  });

  return res.json({ success: true });
});
