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
