export type NotificationRow = {
  id: number;
  created_at: string;
  assujetti_id: number;
  campagne_id: number | null;
  email_destinataire: string;
  objet: string;
  template_code: string;
  statut: string;
  statut_label: string;
  sent_at: string | null;
  erreur: string | null;
  tentatives: number;
  mode: string;
  relance_niveau: string | null;
  assujetti_siret: string | null;
  assujetti_denomination: string | null;
};

export type NotificationsOptionStatus = {
  value: string;
  label: string;
};

export type NotificationsOptions = {
  statuses: NotificationsOptionStatus[];
  templates: string[];
};

export type NotificationsPayload = {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  rows: NotificationRow[];
  options: NotificationsOptions;
};

export type NotificationsFiltersForm = {
  statut: string;
  email_destinataire: string;
  template_code: string;
  q: string;
  date_debut: string;
  date_fin: string;
  page_size: number;
};

export function defaultNotificationsFilters(): NotificationsFiltersForm {
  return {
    statut: '',
    email_destinataire: '',
    template_code: '',
    q: '',
    date_debut: '',
    date_fin: '',
    page_size: 25,
  };
}

export function canExportNotifications(params: { canManage: boolean }) {
  return params.canManage;
}

export function buildNotificationsPath(
  filters: NotificationsFiltersForm,
  options: { page?: number; format?: 'json' | 'csv' } = {},
) {
  const params = new URLSearchParams();
  params.set('page', String(options.page ?? 1));
  params.set('page_size', String(filters.page_size));
  if (filters.statut) params.set('statut', filters.statut);
  if (filters.email_destinataire) params.set('email_destinataire', filters.email_destinataire);
  if (filters.template_code) params.set('template_code', filters.template_code);
  if (filters.q) params.set('q', filters.q);
  if (filters.date_debut) params.set('date_debut', filters.date_debut);
  if (filters.date_fin) params.set('date_fin', filters.date_fin);
  params.set('format', options.format ?? 'json');
  return `/api/notifications?${params.toString()}`;
}

export function buildNotificationsExportFilename(filters: Pick<NotificationsFiltersForm, 'date_debut' | 'date_fin'>) {
  if (filters.date_debut && filters.date_fin) {
    return `notifications-${filters.date_debut}_${filters.date_fin}.csv`;
  }
  return 'notifications.csv';
}

export function shouldApplyNotificationsRequestResult(latestRequestId: number, completedRequestId: number): boolean {
  return latestRequestId === completedRequestId;
}
