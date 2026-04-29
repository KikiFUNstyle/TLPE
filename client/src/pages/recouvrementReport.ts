export type RecouvrementVentilation = 'assujetti' | 'zone' | 'categorie';
export type RecouvrementExportFormat = 'pdf' | 'xlsx';

type RecouvrementFiltersForm = {
  annee: string;
  zone: string;
  categorie: string;
  statut_paiement: string;
  ventilation: RecouvrementVentilation;
};

export type { RecouvrementFiltersForm };

export function defaultRecouvrementFilters(year: number): RecouvrementFiltersForm {
  return {
    annee: String(year),
    zone: '',
    categorie: '',
    statut_paiement: '',
    ventilation: 'assujetti',
  };
}

export function canExportRecouvrement(params: { annee: string; canManage: boolean }) {
  return params.canManage && /^\d{4}$/.test(params.annee);
}

export function buildRecouvrementReportPath(filters: RecouvrementFiltersForm, format: 'json' | RecouvrementExportFormat = 'json') {
  const params = new URLSearchParams();
  params.set('annee', filters.annee);
  if (filters.zone) params.set('zone', filters.zone);
  if (filters.categorie) params.set('categorie', filters.categorie);
  if (filters.statut_paiement) params.set('statut_paiement', filters.statut_paiement);
  params.set('ventilation', filters.ventilation);
  params.set('format', format);
  return `/api/rapports/recouvrement?${params.toString()}`;
}

export function buildRecouvrementExportFilename(
  annee: string,
  ventilation: RecouvrementVentilation,
  format: RecouvrementExportFormat,
) {
  return `etat-recouvrement-${ventilation}-${annee}.${format}`;
}

export function shouldApplyRecouvrementRequestResult(latestRequestId: number, completedRequestId: number): boolean {
  return latestRequestId === completedRequestId;
}
