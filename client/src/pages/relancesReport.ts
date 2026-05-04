export type RelancesReportType =
  | 'relance_declaration'
  | 'mise_en_demeure_declaration'
  | 'relance_impaye'
  | 'mise_en_demeure_impaye';

export type RelancesReportStatus = 'pending' | 'envoye' | 'echec' | 'transmis' | 'classe';
export type RelancesExportFormat = 'pdf' | 'xlsx';

export type RelancesFiltersForm = {
  date_debut: string;
  date_fin: string;
  type: string;
  statut: string;
};

export function defaultRelancesFilters(referenceDate = new Date()): RelancesFiltersForm {
  const year = referenceDate.getFullYear();
  return {
    date_debut: `${year}-01-01`,
    date_fin: `${year}-12-31`,
    type: '',
    statut: '',
  };
}

export function canExportRelances(params: { dateDebut: string; dateFin: string; canManage: boolean }) {
  return params.canManage && /^\d{4}-\d{2}-\d{2}$/.test(params.dateDebut) && /^\d{4}-\d{2}-\d{2}$/.test(params.dateFin);
}

export function buildRelancesReportPath(
  filters: RelancesFiltersForm,
  format: 'json' | RelancesExportFormat = 'json',
) {
  const params = new URLSearchParams();
  params.set('date_debut', filters.date_debut);
  params.set('date_fin', filters.date_fin);
  if (filters.type) params.set('type', filters.type);
  if (filters.statut) params.set('statut', filters.statut);
  params.set('format', format);
  return `/api/rapports/relances?${params.toString()}`;
}

export function buildRelancesExportFilename(
  dateDebut: string,
  dateFin: string,
  format: RelancesExportFormat,
) {
  return `suivi-relances-${dateDebut}_${dateFin}.${format}`;
}

export function shouldApplyRelancesRequestResult(latestRequestId: number, completedRequestId: number): boolean {
  return latestRequestId === completedRequestId;
}
