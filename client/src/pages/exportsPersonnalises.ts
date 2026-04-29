export type ExportEntityKey = 'assujettis' | 'dispositifs' | 'declarations' | 'titres' | 'paiements' | 'contentieux';
export type ExportFilterOperator = 'eq' | 'contains' | 'gte' | 'lte';
export type ExportFileFormat = 'csv' | 'xlsx';

export type ExportFilter = {
  colonne: string;
  operateur: ExportFilterOperator;
  valeur: string;
};

export type ExportOrder = {
  colonne: string;
  direction: 'asc' | 'desc';
};

export type ExportTemplateConfig = {
  colonnes: string[];
  filtres: ExportFilter[];
  ordre: ExportOrder | null;
};

export type ExportTemplatePayload = {
  nom: string;
  entite: ExportEntityKey;
  configuration: ExportTemplateConfig;
};

export function defaultConfigForEntity(entity: ExportEntityKey): ExportTemplateConfig {
  switch (entity) {
    case 'assujettis':
      return { colonnes: ['raison_sociale', 'siret', 'statut'], filtres: [], ordre: { colonne: 'raison_sociale', direction: 'asc' } };
    case 'dispositifs':
      return { colonnes: ['identifiant', 'assujetti', 'categorie', 'statut'], filtres: [], ordre: { colonne: 'identifiant', direction: 'asc' } };
    case 'declarations':
      return { colonnes: ['numero', 'assujetti', 'annee', 'statut'], filtres: [], ordre: { colonne: 'numero', direction: 'desc' } };
    case 'titres':
      return { colonnes: ['numero', 'assujetti', 'montant', 'statut'], filtres: [], ordre: { colonne: 'numero', direction: 'desc' } };
    case 'paiements':
      return { colonnes: ['reference', 'titre_numero', 'assujetti', 'montant'], filtres: [], ordre: { colonne: 'date_paiement', direction: 'desc' } };
    case 'contentieux':
    default:
      return { colonnes: ['numero', 'assujetti', 'type', 'statut'], filtres: [], ordre: { colonne: 'date_ouverture', direction: 'desc' } };
  }
}

export function normalizeTemplateConfig(config: Partial<ExportTemplateConfig>): ExportTemplateConfig {
  const colonnes = Array.from(new Set((config.colonnes ?? []).filter((value): value is string => typeof value === 'string' && value.trim().length > 0)));
  const filtres = (config.filtres ?? []).filter(
    (filter): filter is ExportFilter => !!filter && !!filter.colonne && !!filter.operateur && !!filter.valeur,
  );
  const ordre: ExportOrder | null = config.ordre?.colonne
    ? {
        colonne: config.ordre.colonne,
        direction: config.ordre.direction === 'desc' ? 'desc' : 'asc',
      }
    : null;

  return {
    colonnes,
    filtres,
    ordre,
  };
}

export function buildSavedTemplatePayload(
  nom: string,
  entite: ExportEntityKey,
  configuration: Partial<ExportTemplateConfig>,
): ExportTemplatePayload {
  return {
    nom,
    entite,
    configuration: normalizeTemplateConfig(configuration),
  };
}

export function buildExportPersonnaliseFilename(entite: ExportEntityKey, format: ExportFileFormat) {
  return `export-${entite}.${format}`;
}
