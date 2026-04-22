import test from 'node:test';
import assert from 'node:assert/strict';
import { searchBanAddresses } from './ban';

test('searchBanAddresses - retourne des suggestions normalisées', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        features: [
          {
            properties: {
              label: '10 Rue de Rivoli 75004 Paris',
              postcode: '75004',
              city: 'Paris',
            },
            geometry: { coordinates: [2.3522, 48.8566] },
          },
        ],
      }),
    }) as Response) as typeof fetch;

  try {
    const suggestions = await searchBanAddresses('10 rue de rivoli', 5);
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].adresse, '10 Rue de Rivoli 75004 Paris');
    assert.equal(suggestions[0].codePostal, '75004');
    assert.equal(suggestions[0].ville, 'Paris');
    assert.equal(suggestions[0].latitude, 48.8566);
    assert.equal(suggestions[0].longitude, 2.3522);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('searchBanAddresses - renvoie [] pour une requête trop courte', async () => {
  const suggestions = await searchBanAddresses('ab');
  assert.deepEqual(suggestions, []);
});

test('searchBanAddresses - lève une erreur quand BAN répond non-OK', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 503 }) as Response) as typeof fetch;

  try {
    await assert.rejects(() => searchBanAddresses('adresse test'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
