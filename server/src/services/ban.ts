export interface BanSuggestion {
  label: string;
  adresse: string;
  codePostal: string | null;
  ville: string | null;
  latitude: number;
  longitude: number;
}

interface BanFeatureProperties {
  label?: string;
  name?: string;
  postcode?: string;
  city?: string;
}

interface BanFeature {
  properties?: BanFeatureProperties;
  geometry?: {
    coordinates?: [number, number];
  };
}

interface BanApiResponse {
  features?: BanFeature[];
}

function normalizeSuggestion(feature: BanFeature): BanSuggestion | null {
  const coordinates = feature.geometry?.coordinates;
  if (!coordinates || coordinates.length < 2) return null;

  const longitude = Number(coordinates[0]);
  const latitude = Number(coordinates[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const label = feature.properties?.label?.trim() || feature.properties?.name?.trim() || '';
  if (!label) return null;

  return {
    label,
    adresse: label,
    codePostal: feature.properties?.postcode?.trim() || null,
    ville: feature.properties?.city?.trim() || null,
    latitude,
    longitude,
  };
}

export async function searchBanAddresses(query: string, limit = 5): Promise<BanSuggestion[]> {
  const q = query.trim();
  if (q.length < 3) return [];

  const endpoint = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=${Math.min(Math.max(limit, 1), 10)}`;
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`BAN HTTP ${response.status}`);
  }

  const payload = (await response.json()) as BanApiResponse;
  const features = payload.features ?? [];

  return features.map(normalizeSuggestion).filter((s): s is BanSuggestion => s !== null);
}
