import test from 'node:test';
import assert from 'node:assert/strict';
import { db, initSchema } from './db';
import {
  enrichAssujettiPayloadWithSirene,
  fetchSiretData,
  type SireneData,
} from './services/apiEntreprise';

function resetTables() {
  initSchema();
  db.exec('DELETE FROM api_entreprise_cache');
}

test('fetchSiretData - utilise le cache valide meme si token manquant', async () => {
  resetTables();
  delete process.env.API_ENTREPRISE_TOKEN;

  db.prepare(
    `INSERT INTO api_entreprise_cache (
      siret, raison_sociale, forme_juridique, adresse_rue, adresse_cp, adresse_ville, adresse_pays,
      est_radie, source_statut, fetched_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+10 day'))`,
  ).run(
    '73282932000074',
    'SOCIETE CACHED',
    'SARL',
    '1 rue Cachee',
    '75001',
    'Paris',
    'France',
    0,
    'A',
  );

  const result = await fetchSiretData('73282932000074');

  assert.equal(result.status, 'cache');
  assert.equal(result.data?.raisonSociale, 'SOCIETE CACHED');
});

test('fetchSiretData - mode degrade si token manquant et cache absent', async () => {
  resetTables();
  delete process.env.API_ENTREPRISE_TOKEN;

  const result = await fetchSiretData('73282932000100');

  assert.equal(result.status, 'degraded');
  assert.ok(result.message?.includes('API_ENTREPRISE_TOKEN manquant'));
  assert.equal(result.data, null);
});

test('fetchSiretData - mode degrade avec fallback cache si le cache est expiré et le token manque', async () => {
  resetTables();
  delete process.env.API_ENTREPRISE_TOKEN;

  db.prepare(
    `INSERT INTO api_entreprise_cache (
      siret, raison_sociale, forme_juridique, adresse_rue, adresse_cp, adresse_ville, adresse_pays,
      est_radie, source_statut, fetched_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-40 day'), datetime('now', '-1 day'))`,
  ).run(
    '73282932000075',
    'SOCIETE EXPIREE',
    'SAS',
    '2 rue Expiree',
    '69001',
    'Lyon',
    'France',
    0,
    'A',
  );

  const result = await fetchSiretData('73282932000075');

  assert.equal(result.status, 'degraded');
  assert.equal(result.data?.raisonSociale, 'SOCIETE EXPIREE');
  assert.match(result.message ?? '', /API_ENTREPRISE_TOKEN manquant/);
});

test('fetchSiretData - appelle l’API Entreprise, normalise la réponse et met le cache à jour', async () => {
  resetTables();
  process.env.API_ENTREPRISE_TOKEN = 'token-test';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        etablissement: {
          unite_legale: {
            denomination: 'SOCIETE API',
            libelle_forme_juridique: 'SARL',
            etat_administratif: 'A',
          },
          adresse_etablissement: {
            numero_voie: '10',
            type_voie: 'Rue',
            libelle_voie: 'des Tests',
            code_postal: '33000',
            libelle_commune: 'Bordeaux',
          },
        },
      }),
    }) as Response) as typeof fetch;

  try {
    const result = await fetchSiretData('73282932000076');

    assert.equal(result.status, 'ok');
    assert.equal(result.data?.raisonSociale, 'SOCIETE API');
    assert.equal(result.data?.formeJuridique, 'SARL');
    assert.equal(result.data?.adresseRue, '10 Rue des Tests');
    assert.equal(result.data?.adresseCp, '33000');
    assert.equal(result.data?.adresseVille, 'Bordeaux');
    assert.equal(result.data?.adressePays, 'France');
    assert.equal(result.data?.estRadie, false);

    const cached = db.prepare(
      'SELECT raison_sociale, forme_juridique, adresse_rue, adresse_cp, adresse_ville, adresse_pays, est_radie FROM api_entreprise_cache WHERE siret = ?',
    ).get('73282932000076') as
      | { raison_sociale: string; forme_juridique: string; adresse_rue: string; adresse_cp: string; adresse_ville: string; adresse_pays: string; est_radie: number }
      | undefined;
    assert.ok(cached);
    assert.equal(cached?.raison_sociale, 'SOCIETE API');
    assert.equal(cached?.forme_juridique, 'SARL');
    assert.equal(cached?.adresse_rue, '10 Rue des Tests');
    assert.equal(cached?.adresse_cp, '33000');
    assert.equal(cached?.adresse_ville, 'Bordeaux');
    assert.equal(cached?.adresse_pays, 'France');
    assert.equal(cached?.est_radie, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchSiretData - retourne radie quand l’API remonte un établissement fermé', async () => {
  resetTables();
  process.env.API_ENTREPRISE_TOKEN = 'token-test';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        data: {
          uniteLegale: {
            denomination_usuelle: 'SOCIETE RADIEE',
            categorie_juridique: '5498',
            etat_administratif: 'F',
          },
          adresseEtablissement: {
            numeroVoie: '5',
            typeVoie: 'avenue',
            libelleVoie: 'du Repli',
            codePostal: '13000',
            ville: 'Marseille',
            pays: 'France',
          },
        },
      }),
    }) as Response) as typeof fetch;

  try {
    const result = await fetchSiretData('73282932000077');

    assert.equal(result.status, 'radie');
    assert.equal(result.data?.estRadie, true);
    assert.match(result.message ?? '', /radié/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchSiretData - retombe sur un cache expiré si l’API est indisponible', async () => {
  resetTables();
  process.env.API_ENTREPRISE_TOKEN = 'token-test';

  db.prepare(
    `INSERT INTO api_entreprise_cache (
      siret, raison_sociale, forme_juridique, adresse_rue, adresse_cp, adresse_ville, adresse_pays,
      est_radie, source_statut, fetched_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-40 day'), datetime('now', '-1 day'))`,
  ).run(
    '73282932000078',
    'SOCIETE STALE',
    'SASU',
    '3 rue Stale',
    '44000',
    'Nantes',
    'France',
    0,
    'A',
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 503 }) as Response) as typeof fetch;

  try {
    const result = await fetchSiretData('73282932000078');

    assert.equal(result.status, 'degraded');
    assert.equal(result.data?.raisonSociale, 'SOCIETE STALE');
    assert.match(result.message ?? '', /503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchSiretData - retourne radie quand le cache valide contient un établissement fermé', async () => {
  resetTables();
  delete process.env.API_ENTREPRISE_TOKEN;

  db.prepare(
    `INSERT INTO api_entreprise_cache (
      siret, raison_sociale, forme_juridique, adresse_rue, adresse_cp, adresse_ville, adresse_pays,
      est_radie, source_statut, fetched_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+10 day'))`,
  ).run(
    '73282932000079',
    'SOCIETE RADIEE CACHE',
    'SAS',
    '9 rue Fermee',
    '75002',
    'Paris',
    'France',
    1,
    'F',
  );

  const result = await fetchSiretData('73282932000079');

  assert.equal(result.status, 'radie');
  assert.equal(result.data?.estRadie, true);
  assert.match(result.message ?? '', /radié/i);
});

test('fetchSiretData - retourne un message générique quand fetch échoue hors objet Error', async () => {
  resetTables();
  process.env.API_ENTREPRISE_TOKEN='***';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw 'panic';
  }) as typeof fetch;

  try {
    const result = await fetchSiretData('73282932000080');

    assert.equal(result.status, 'degraded');
    assert.equal(result.data, null);
    assert.match(result.message ?? '', /erreur réseau API Entreprise/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchSiretData - remonte un timeout explicite quand API Entreprise ne répond pas', async () => {
  resetTables();
  process.env.API_ENTREPRISE_TOKEN='***';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) {
          const error = new Error('aborted') as Error & { name: string };
          error.name = 'AbortError';
          reject(error);
          return;
        }
        signal.addEventListener('abort', () => {
          const error = new Error('aborted') as Error & { name: string };
          error.name = 'AbortError';
          reject(error);
        });
      }
      void resolve;
    })) as typeof fetch;

  try {
    const result = await fetchSiretData('73282932000082');

    assert.equal(result.status, 'degraded');
    assert.equal(result.data, null);
    assert.match(result.message ?? '', /API Entreprise timeout/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchSiretData - utilise les champs top-level quand unite legale et adresse détaillée sont absentes', async () => {
  resetTables();
  process.env.API_ENTREPRISE_TOKEN='***';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        data: {
          denomination: 'SOCIETE TOP LEVEL',
          raison_sociale: 'SOCIETE TOP LEVEL ALT',
          etat_administratif: 'A',
          adresse: {
            numero_voie: '20',
            type_voie: 'boulevard',
            libelle_voie: 'des Fallbacks',
            code_postal: '59000',
            localite: 'Lille',
          },
        },
      }),
    }) as Response) as typeof fetch;

  try {
    const result = await fetchSiretData('73282932000083');

    assert.equal(result.status, 'ok');
    assert.equal(result.data?.raisonSociale, 'SOCIETE TOP LEVEL');
    assert.equal(result.data?.adresseRue, '20 boulevard des Fallbacks');
    assert.equal(result.data?.adresseCp, '59000');
    assert.equal(result.data?.adresseVille, 'Lille');
    assert.equal(result.data?.adressePays, 'France');
    assert.equal(result.data?.estRadie, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchSiretData - normalise une réponse vide en valeurs nulles par défaut', async () => {
  resetTables();
  process.env.API_ENTREPRISE_TOKEN='***';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({}),
    }) as Response) as typeof fetch;

  try {
    const result = await fetchSiretData('73282932000084');

    assert.equal(result.status, 'ok');
    assert.equal(result.data?.raisonSociale, null);
    assert.equal(result.data?.formeJuridique, null);
    assert.equal(result.data?.adresseRue, null);
    assert.equal(result.data?.adresseCp, null);
    assert.equal(result.data?.adresseVille, null);
    assert.equal(result.data?.adressePays, 'France');
    assert.equal(result.data?.sourceStatut, null);
    assert.equal(result.data?.estRadie, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('enrichAssujettiPayloadWithSirene - conserve payload quand data manquante', () => {
  const payload = {
    raison_sociale: 'Nom saisi manuellement',
    forme_juridique: 'Autre',
    adresse_rue: null,
    adresse_cp: null,
    adresse_ville: null,
    adresse_pays: null,
  };

  const sirene: SireneData = {
    siret: '73282932000074',
    raisonSociale: null,
    formeJuridique: 'SARL',
    adresseRue: '5 avenue des Tests',
    adresseCp: '31000',
    adresseVille: 'Toulouse',
    adressePays: 'France',
    estRadie: false,
    sourceStatut: 'A',
    fetchedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };

  const enriched = enrichAssujettiPayloadWithSirene(payload, sirene);
  assert.equal(enriched.raison_sociale, 'Nom saisi manuellement');
  assert.equal(enriched.forme_juridique, 'SARL');
  assert.equal(enriched.adresse_rue, '5 avenue des Tests');
});

test('fetchSiretData - récupère API Entreprise, marque les établissements radiés et persiste le cache', async () => {
  resetTables();
  process.env.API_ENTREPRISE_TOKEN = 'token-test';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      etablissement: {
        unite_legale: {
          denomination: 'SOCIETE RADIEE',
          forme_juridique: 'SAS',
          etat_administratif: 'F',
        },
        adresse_etablissement: {
          numero_voie: '12',
          type_voie: 'Rue',
          libelle_voie: 'des Lilas',
          code_postal: '33000',
          libelle_commune: 'Bordeaux',
          pays: 'France',
        },
      },
    }),
  }) as Response) as typeof fetch;

  try {
    const result = await fetchSiretData('73282932000074');
    assert.equal(result.status, 'radie');
    assert.equal(result.data?.raisonSociale, 'SOCIETE RADIEE');
    assert.equal(result.data?.formeJuridique, 'SAS');
    assert.equal(result.data?.adresseRue, '12 Rue des Lilas');
    assert.equal(result.data?.adresseVille, 'Bordeaux');
    assert.equal(result.data?.estRadie, true);

    const cached = db.prepare(
      `SELECT raison_sociale, forme_juridique, adresse_rue, est_radie, source_statut
       FROM api_entreprise_cache
       WHERE siret = ?`,
    ).get('73282932000074') as {
      raison_sociale: string;
      forme_juridique: string;
      adresse_rue: string;
      est_radie: number;
      source_statut: string;
    };
    assert.equal(cached.raison_sociale, 'SOCIETE RADIEE');
    assert.equal(cached.forme_juridique, 'SAS');
    assert.equal(cached.adresse_rue, '12 Rue des Lilas');
    assert.equal(cached.est_radie, 1);
    assert.equal(cached.source_statut, 'F');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.API_ENTREPRISE_TOKEN;
  }
});

test('fetchSiretData - retombe sur le cache expiré quand l’API échoue', async () => {
  resetTables();
  process.env.API_ENTREPRISE_TOKEN = 'token-test';
  db.prepare(
    `INSERT INTO api_entreprise_cache (
      siret, raison_sociale, forme_juridique, adresse_rue, adresse_cp, adresse_ville, adresse_pays,
      est_radie, source_statut, fetched_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-40 day'), datetime('now', '-1 day'))`,
  ).run(
    '73282932000999',
    'CACHE EXPIRE',
    'SARL',
    '9 rue expiree',
    '31000',
    'Toulouse',
    'France',
    0,
    'A',
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('reseau coupe');
  }) as typeof fetch;

  try {
    const result = await fetchSiretData('73282932000999');
    assert.equal(result.status, 'degraded');
    assert.equal(result.data?.raisonSociale, 'CACHE EXPIRE');
    assert.match(result.message ?? '', /reseau coupe/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.API_ENTREPRISE_TOKEN;
  }
});

test('fetchSiretData - retourne un mode dégradé quand l’API répond non-OK sans cache', async () => {
  resetTables();
  process.env.API_ENTREPRISE_TOKEN='***';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 503 }) as Response) as typeof fetch;

  try {
    const result = await fetchSiretData('73282932000123');
    assert.equal(result.status, 'degraded');
    assert.equal(result.data, null);
    assert.match(result.message ?? '', /503/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.API_ENTREPRISE_TOKEN;
  }
});

test('fetchSiretData - retourne ok avec les champs alternatifs data/uniteLegale/adresseEtablissement et applique le pays par défaut', async () => {
  resetTables();
  process.env.API_ENTREPRISE_TOKEN = '***';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      data: {
        uniteLegale: {
          denomination_usuelle: 'ACME ALT',
          categorie_juridique: 'EI',
          etat_administratif: 'A',
        },
        adresseEtablissement: {
          numeroVoie: '8',
          typeVoie: 'avenue',
          libelleVoie: 'Victor Hugo',
          codePostal: '69000',
          ville: 'Lyon',
        },
      },
    }),
  }) as Response) as typeof fetch;

  try {
    const result = await fetchSiretData('55210055400021');
    assert.equal(result.status, 'ok');
    assert.equal(result.data?.raisonSociale, 'ACME ALT');
    assert.equal(result.data?.formeJuridique, 'EI');
    assert.equal(result.data?.adresseRue, '8 avenue Victor Hugo');
    assert.equal(result.data?.adresseCp, '69000');
    assert.equal(result.data?.adresseVille, 'Lyon');
    assert.equal(result.data?.adressePays, 'France');
    assert.equal(result.data?.estRadie, false);
    assert.equal(result.message, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.API_ENTREPRISE_TOKEN;
  }
});

test('fetchSiretData - retourne radie depuis le cache valide sans appeler l’API', async () => {
  resetTables();
  delete process.env.API_ENTREPRISE_TOKEN;
  db.prepare(
    `INSERT INTO api_entreprise_cache (
      siret, raison_sociale, forme_juridique, adresse_rue, adresse_cp, adresse_ville, adresse_pays,
      est_radie, source_statut, fetched_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+3 day'))`,
  ).run(
    '55210055400022',
    'CACHE RADIE',
    'SASU',
    '2 rue du Cache',
    '44000',
    'Nantes',
    'France',
    1,
    'F',
  );

  const result = await fetchSiretData('55210055400022');
  assert.equal(result.status, 'radie');
  assert.equal(result.data?.estRadie, true);
  assert.match(result.message ?? '', /cache/i);
});

test('fetchSiretData - transforme un AbortError en message de timeout dégradé', async () => {
  resetTables();
  process.env.API_ENTREPRISE_TOKEN = '***';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  }) as typeof fetch;

  try {
    const result = await fetchSiretData('55210055400023');
    assert.equal(result.status, 'degraded');
    assert.equal(result.data, null);
    assert.match(result.message ?? '', /timeout/i);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.API_ENTREPRISE_TOKEN;
  }
});

test('enrichAssujettiPayloadWithSirene - complète les champs restants et force France par défaut', () => {
  const enriched = enrichAssujettiPayloadWithSirene(
    {
      raison_sociale: 'Nom manuel',
      forme_juridique: null,
      adresse_rue: null,
      adresse_cp: null,
      adresse_ville: null,
      adresse_pays: null,
    },
    {
      siret: '55210055400024',
      raisonSociale: null,
      formeJuridique: 'SARL',
      adresseRue: null,
      adresseCp: '13001',
      adresseVille: 'Marseille',
      adressePays: null,
      estRadie: false,
      sourceStatut: null,
      fetchedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
  );

  assert.equal(enriched.raison_sociale, 'Nom manuel');
  assert.equal(enriched.forme_juridique, 'SARL');
  assert.equal(enriched.adresse_rue, null);
  assert.equal(enriched.adresse_cp, '13001');
  assert.equal(enriched.adresse_ville, 'Marseille');
  assert.equal(enriched.adresse_pays, 'France');
});

test('enrichAssujettiPayloadWithSirene - conserve les valeurs du payload et retombe sur France par défaut', () => {
  const payload = {
    raison_sociale: 'Nom manuel',
    forme_juridique: 'SASU',
    adresse_rue: '12 rue du Portail',
    adresse_cp: '44100',
    adresse_ville: 'Nantes',
    adresse_pays: null,
  };

  const sirene: SireneData = {
    siret: '73282932000081',
    raisonSociale: null,
    formeJuridique: null,
    adresseRue: null,
    adresseCp: null,
    adresseVille: null,
    adressePays: null,
    estRadie: false,
    sourceStatut: null,
    fetchedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };

  const enriched = enrichAssujettiPayloadWithSirene(payload, sirene);
  assert.equal(enriched.raison_sociale, 'Nom manuel');
  assert.equal(enriched.forme_juridique, 'SASU');
  assert.equal(enriched.adresse_rue, '12 rue du Portail');
  assert.equal(enriched.adresse_cp, '44100');
  assert.equal(enriched.adresse_ville, 'Nantes');
  assert.equal(enriched.adresse_pays, 'France');
});
