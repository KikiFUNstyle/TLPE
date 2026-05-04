export type AuditLogExportFormat = 'csv';

export type AuditLogFiltersForm = {
  user_id: string;
  action: string;
  entite: string;
  q: string;
  date_debut: string;
  date_fin: string;
  page_size: number;
};

export function defaultAuditLogFilters(): AuditLogFiltersForm {
  return {
    user_id: '',
    action: '',
    entite: '',
    q: '',
    date_debut: '',
    date_fin: '',
    page_size: 25,
  };
}

export function canExportAuditLog(params: { canManage: boolean }) {
  return params.canManage;
}

export function buildAuditLogPath(
  filters: AuditLogFiltersForm,
  options: { page?: number; format?: 'json' | AuditLogExportFormat } = {},
) {
  const params = new URLSearchParams();
  params.set('page', String(options.page ?? 1));
  params.set('page_size', String(filters.page_size));
  if (filters.user_id) params.set('user_id', filters.user_id);
  if (filters.entite) params.set('entite', filters.entite);
  if (filters.action) params.set('action', filters.action);
  if (filters.q) params.set('q', filters.q);
  if (filters.date_debut) params.set('date_debut', filters.date_debut);
  if (filters.date_fin) params.set('date_fin', filters.date_fin);
  params.set('format', options.format ?? 'json');
  return `/api/audit-log?${params.toString()}`;
}

export function buildAuditLogExportFilename(filters: Pick<AuditLogFiltersForm, 'date_debut' | 'date_fin'>) {
  if (filters.date_debut && filters.date_fin) {
    return `audit-log-${filters.date_debut}_${filters.date_fin}.csv`;
  }
  return 'audit-log.csv';
}

export function shouldApplyAuditLogRequestResult(latestRequestId: number, completedRequestId: number): boolean {
  return latestRequestId === completedRequestId;
}
