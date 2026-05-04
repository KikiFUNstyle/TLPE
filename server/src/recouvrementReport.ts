export type RecouvrementVentilation = 'assujetti' | 'zone' | 'categorie';
export type RecouvrementFormat = 'json' | 'pdf' | 'xlsx';

export type RecouvrementFilters = {
  annee: number;
  zoneId: number | null;
  categorie: 'enseigne' | 'publicitaire' | 'preenseigne' | null;
  statutPaiement:
    | 'emis'
    | 'paye_partiel'
    | 'paye'
    | 'impaye'
    | 'mise_en_demeure'
    | 'transmis_comptable'
    | 'admis_en_non_valeur'
    | null;
  ventilation: RecouvrementVentilation;
};

export type RecouvrementSummaryRow = {
  key: string;
  label: string;
  montant_emis: number;
  montant_recouvre: number;
  reste_a_recouvrer: number;
  taux_recouvrement: number;
};

export type RecouvrementReportPayload = {
  generatedAt: string;
  hash: string;
  titresCount: number;
  filters: {
    annee: number;
    zone: { id: number; label: string } | null;
    categorie: string | null;
    statut_paiement: string | null;
    ventilation: RecouvrementVentilation;
  };
  totals: {
    montant_emis: number;
    montant_recouvre: number;
    reste_a_recouvrer: number;
    taux_recouvrement: number;
  };
  breakdowns: {
    assujetti: RecouvrementSummaryRow[];
    zone: RecouvrementSummaryRow[];
    categorie: RecouvrementSummaryRow[];
  };
  chart: RecouvrementSummaryRow[];
};

export function roundCurrency(value: number): number {
  return Number(value.toFixed(2));
}

export function roundRate(value: number): number {
  return Number(value.toFixed(4));
}

export function computeRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return roundRate(numerator / denominator);
}

export function buildRecouvrementFilename(
  annee: string,
  ventilation: RecouvrementVentilation,
  format: Exclude<RecouvrementFormat, 'json'>,
) {
  return `etat-recouvrement-${ventilation}-${annee}.${format}`;
}
