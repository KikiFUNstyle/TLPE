export type ComparatifExportFormat = 'pdf' | 'xlsx';

export type ComparatifFiltersForm = {
  annee: string;
};

export function defaultComparatifFilters(year: number): ComparatifFiltersForm {
  return { annee: String(year) };
}

export function canExportComparatif(params: { annee: string; canManage: boolean }) {
  return params.canManage && /^\d{4}$/.test(params.annee);
}

export function buildComparatifReportPath(
  filters: ComparatifFiltersForm,
  format: 'json' | ComparatifExportFormat = 'json',
) {
  const params = new URLSearchParams();
  params.set('annee', filters.annee);
  params.set('format', format);
  return `/api/rapports/comparatif?${params.toString()}`;
}

export function buildComparatifExportFilename(annee: string, format: ComparatifExportFormat) {
  return `comparatif-pluriannuel-${annee}.${format}`;
}

export function shouldApplyComparatifRequestResult(latestRequestId: number, completedRequestId: number): boolean {
  return latestRequestId === completedRequestId;
}

export function shouldAutoLoadComparatif(annee: string): boolean {
  return /^\d{4}$/.test(annee);
}
