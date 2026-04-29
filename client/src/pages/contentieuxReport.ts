export type ContentieuxExportFormat = 'pdf' | 'xlsx';

export type ContentieuxReportFiltersForm = {
  date_reference: string;
};

export function defaultContentieuxReportFilters(dateReference: string): ContentieuxReportFiltersForm {
  return { date_reference: dateReference };
}

export function buildContentieuxReportPath(
  filtersOrFormat: ContentieuxReportFiltersForm | ('json' | ContentieuxExportFormat) = 'json',
  formatOrDateReference?: 'json' | ContentieuxExportFormat | string,
) {
  const params = new URLSearchParams();

  if (typeof filtersOrFormat === 'object') {
    if (filtersOrFormat.date_reference) params.set('date_reference', filtersOrFormat.date_reference);
    params.set('format', (formatOrDateReference as 'json' | ContentieuxExportFormat | undefined) ?? 'json');
    return `/api/rapports/contentieux?${params.toString()}`;
  }

  if (typeof formatOrDateReference === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(formatOrDateReference)) {
    params.set('date_reference', formatOrDateReference);
  }
  params.set('format', filtersOrFormat);
  return `/api/rapports/contentieux?${params.toString()}`;
}

export function buildContentieuxExportFilename(dateReference: string, format: ContentieuxExportFormat) {
  return `synthese-contentieux-${dateReference}.${format}`;
}

export function canExportContentieux(params: { dateReference: string; canManage: boolean }) {
  return params.canManage && /^\d{4}-\d{2}-\d{2}$/.test(params.dateReference);
}

export function shouldApplyContentieuxRequestResult(latestRequestId: number, completedRequestId: number): boolean {
  return latestRequestId === completedRequestId;
}

export function shouldShowDegrevementAmount(statut: string) {
  return statut === 'degrevement_partiel' || statut === 'degrevement_total';
}

export function defaultDegrevementAmount(statut: string, montantLitige: number | null | undefined) {
  if (statut !== 'degrevement_total') return '';
  if (montantLitige === null || montantLitige === undefined) return '';
  return String(montantLitige);
}
