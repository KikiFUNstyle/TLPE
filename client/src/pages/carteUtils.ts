export interface DispositifMapItem {
  id: number;
  identifiant: string;
  statut: 'declare' | 'controle' | 'litigieux' | 'depose' | 'exonere' | string;
  latitude: number | null;
  longitude: number | null;
  adresse_rue: string | null;
  adresse_cp: string | null;
  adresse_ville: string | null;
  zone_id: number | null;
  zone_libelle: string | null;
  type_id: number;
  type_libelle: string;
  assujetti_raison_sociale: string;
}

const statusStyles: Record<string, { color: string; label: string }> = {
  declare: { color: '#0063cb', label: 'Déclaré' },
  controle: { color: '#18753c', label: 'Contrôlé' },
  litigieux: { color: '#b34000', label: 'Litigieux' },
  depose: { color: '#6a6f7f', label: 'Déposé' },
  exonere: { color: '#7a40bf', label: 'Exonéré' },
};

export function getStatusStyle(statut: string) {
  return statusStyles[statut] ?? { color: '#5d6887', label: statut };
}

export function buildGeoJson(dispositifs: DispositifMapItem[]): string {
  const features = dispositifs.map((d) => ({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [d.longitude, d.latitude],
    },
    properties: {
      id: d.id,
      identifiant: d.identifiant,
      statut: d.statut,
      type: d.type_libelle,
      zone: d.zone_libelle,
      assujetti: d.assujetti_raison_sociale,
      adresse: [d.adresse_rue, d.adresse_cp, d.adresse_ville].filter(Boolean).join(', '),
    },
  }));

  return JSON.stringify(
    {
      type: 'FeatureCollection',
      features,
    },
    null,
    2,
  );
}

export const mapStatusStyles = statusStyles;
