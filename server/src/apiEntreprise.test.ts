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
