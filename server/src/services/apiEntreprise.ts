import { db } from '../db';

const API_ENTREPRISE_BASE_URL = 'https://entreprise.api.gouv.fr/v3/insee/sirene/etablissements';
const THIRTY_DAYS_IN_MS = 30 * 24 * 60 * 60 * 1000;

export interface SireneData {
  siret: string;
  raisonSociale: string | null;
  formeJuridique: string | null;
  adresseRue: string | null;
  adresseCp: string | null;
  adresseVille: string | null;
  adressePays: string | null;
  estRadie: boolean;
  sourceStatut: string | null;
  fetchedAt: string;
  expiresAt: string;
}

export type SireneFetchStatus = 'ok' | 'cache' | 'radie' | 'degraded';

export interface SireneFetchResult {
  status: SireneFetchStatus;
  data: SireneData | null;
  message?: string;
}

function normalizeValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function toIsoDate(value: Date): string {
  return value.toISOString();
}

function fromApiToSireneData(siret: string, payload: unknown): SireneData {
  const body = payload as Record<string, unknown>;
  const etablissement = (body.etablissement as Record<string, unknown> | undefined)
    ?? (body.data as Record<string, unknown> | undefined)
    ?? {};

  const uniteLegale = (etablissement.unite_legale as Record<string, unknown> | undefined)
    ?? (etablissement.uniteLegale as Record<string, unknown> | undefined)
    ?? {};

  const adresse = (etablissement.adresse as Record<string, unknown> | undefined)
    ?? (etablissement.adresse_etablissement as Record<string, unknown> | undefined)
    ?? (etablissement.adresseEtablissement as Record<string, unknown> | undefined)
    ?? {};

  const numeroVoie = normalizeValue(adresse.numero_voie ?? adresse.numeroVoie);
  const typeVoie = normalizeValue(adresse.type_voie ?? adresse.typeVoie);
  const libelleVoie = normalizeValue(adresse.libelle_voie ?? adresse.libelleVoie);
  const adresseRue = [numeroVoie, typeVoie, libelleVoie].filter(Boolean).join(' ').trim() || null;

  const raisonSociale = normalizeValue(
    uniteLegale.denomination ??
      uniteLegale.denomination_usuelle ??
      uniteLegale.raison_sociale ??
      etablissement.denomination ??
      etablissement.raison_sociale,
  );

  const formeJuridique = normalizeValue(
    uniteLegale.forme_juridique ??
      uniteLegale.libelle_forme_juridique ??
      uniteLegale.categorie_juridique,
  );

  const rawStatut = normalizeValue(
    uniteLegale.etat_administratif ?? etablissement.etat_administratif,
  );
  const estRadie = rawStatut ? rawStatut.toLowerCase() !== 'a' : false;

  const fetchedAtDate = new Date();
  const expiresAtDate = new Date(fetchedAtDate.getTime() + THIRTY_DAYS_IN_MS);

  return {
    siret,
    raisonSociale,
    formeJuridique,
    adresseRue,
    adresseCp: normalizeValue(adresse.code_postal ?? adresse.codePostal),
    adresseVille: normalizeValue(adresse.localite ?? adresse.libelle_commune ?? adresse.ville),
    adressePays: normalizeValue(adresse.pays ?? 'France'),
    estRadie,
    sourceStatut: rawStatut,
    fetchedAt: toIsoDate(fetchedAtDate),
    expiresAt: toIsoDate(expiresAtDate),
  };
}

function rowToSireneData(row: Record<string, unknown>): SireneData {
  return {
    siret: String(row.siret),
    raisonSociale: normalizeValue(row.raison_sociale),
    formeJuridique: normalizeValue(row.forme_juridique),
    adresseRue: normalizeValue(row.adresse_rue),
    adresseCp: normalizeValue(row.adresse_cp),
    adresseVille: normalizeValue(row.adresse_ville),
    adressePays: normalizeValue(row.adresse_pays),
    estRadie: Number(row.est_radie) === 1,
    sourceStatut: normalizeValue(row.source_statut),
    fetchedAt: String(row.fetched_at),
    expiresAt: String(row.expires_at),
  };
}

function readCache(siret: string): SireneData | null {
  const row = db
    .prepare(
      `SELECT siret, raison_sociale, forme_juridique, adresse_rue, adresse_cp, adresse_ville, adresse_pays,
              est_radie, source_statut, fetched_at, expires_at
       FROM api_entreprise_cache
       WHERE siret = ?`,
    )
    .get(siret) as Record<string, unknown> | undefined;

  if (!row) return null;
  return rowToSireneData(row);
}

function isCacheValid(entry: SireneData): boolean {
  return new Date(entry.expiresAt).getTime() > Date.now();
}

function saveCache(entry: SireneData): void {
  db.prepare(
    `INSERT INTO api_entreprise_cache (
      siret, raison_sociale, forme_juridique, adresse_rue, adresse_cp, adresse_ville, adresse_pays,
      est_radie, source_statut, fetched_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(siret) DO UPDATE SET
      raison_sociale = excluded.raison_sociale,
      forme_juridique = excluded.forme_juridique,
      adresse_rue = excluded.adresse_rue,
      adresse_cp = excluded.adresse_cp,
      adresse_ville = excluded.adresse_ville,
      adresse_pays = excluded.adresse_pays,
      est_radie = excluded.est_radie,
      source_statut = excluded.source_statut,
      fetched_at = excluded.fetched_at,
      expires_at = excluded.expires_at`,
  ).run(
    entry.siret,
    entry.raisonSociale,
    entry.formeJuridique,
    entry.adresseRue,
    entry.adresseCp,
    entry.adresseVille,
    entry.adressePays,
    entry.estRadie ? 1 : 0,
    entry.sourceStatut,
    entry.fetchedAt,
    entry.expiresAt,
  );
}

async function fetchSireneApi(siret: string, token: string): Promise<SireneData> {
  const response = await fetch(`${API_ENTREPRISE_BASE_URL}/${siret}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'TLPE-Manager/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`API Entreprise indisponible (${response.status})`);
  }

  const payload = (await response.json()) as unknown;
  return fromApiToSireneData(siret, payload);
}

export async function fetchSiretData(siret: string): Promise<SireneFetchResult> {
  const cached = readCache(siret);
  if (cached && isCacheValid(cached)) {
    return {
      status: cached.estRadie ? 'radie' : 'cache',
      data: cached,
      message: cached.estRadie ? 'SIRET radié (cache)' : undefined,
    };
  }

  const token = process.env.API_ENTREPRISE_TOKEN;
  if (!token) {
    return {
      status: 'degraded',
      data: cached,
      message: 'Mode dégradé: API_ENTREPRISE_TOKEN manquant',
    };
  }

  try {
    const fresh = await fetchSireneApi(siret, token);
    saveCache(fresh);
    return {
      status: fresh.estRadie ? 'radie' : 'ok',
      data: fresh,
      message: fresh.estRadie ? 'SIRET radié (API Entreprise)' : undefined,
    };
  } catch (error) {
    const fallback = readCache(siret);
    return {
      status: 'degraded',
      data: fallback,
      message: error instanceof Error ? `Mode dégradé: ${error.message}` : 'Mode dégradé: erreur réseau API Entreprise',
    };
  }
}

export function enrichAssujettiPayloadWithSirene<T extends {
  raison_sociale?: string;
  forme_juridique?: string | null;
  adresse_rue?: string | null;
  adresse_cp?: string | null;
  adresse_ville?: string | null;
  adresse_pays?: string | null;
}>(payload: T, sireneData: SireneData): T {
  return {
    ...payload,
    raison_sociale: sireneData.raisonSociale ?? payload.raison_sociale,
    forme_juridique: sireneData.formeJuridique ?? payload.forme_juridique ?? null,
    adresse_rue: sireneData.adresseRue ?? payload.adresse_rue ?? null,
    adresse_cp: sireneData.adresseCp ?? payload.adresse_cp ?? null,
    adresse_ville: sireneData.adresseVille ?? payload.adresse_ville ?? null,
    adresse_pays: sireneData.adressePays ?? payload.adresse_pays ?? 'France',
  };
}
