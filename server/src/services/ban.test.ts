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

test('searchBanAddresses - utilise le name de repli et ignore les features sans coordonnées exploitables', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        features: [
          {
            properties: {
              name: 'Place Bellecour',
              postcode: '69002',
              city: 'Lyon',
            },
            geometry: { coordinates: [4.832, 45.757] },
          },
          {
            properties: {
              label: 'Sans coordonnées',
              postcode: '31000',
              city: 'Toulouse',
            },
            geometry: { coordinates: [2.1] },
          },
          {
            properties: {
              label: 'Coordonnées invalides',
              postcode: '44000',
              city: 'Nantes',
            },
            geometry: { coordinates: [Number.NaN, 47.2] },
          },
        ],
      }),
    }) as Response) as typeof fetch;

  try {
    const suggestions = await searchBanAddresses('place bellecour', 5);
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].label, 'Place Bellecour');
    assert.equal(suggestions[0].codePostal, '69002');
    assert.equal(suggestions[0].ville, 'Lyon');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('searchBanAddresses - renvoie [] pour une requête trop courte', async () => {
  const suggestions = await searchBanAddresses('ab');
  assert.deepEqual(suggestions, []);
});

test('searchBanAddresses - timeout BAN quand le service ne répond pas', async () => {
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
    await assert.rejects(() => searchBanAddresses('adresse test timeout', 5, 20), /BAN timeout/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('searchBanAddresses - ignore les features sans label ni name exploitables', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        features: [
          {
            properties: {
              label: '   ',
              name: '   ',
              postcode: '75001',
              city: 'Paris',
            },
            geometry: { coordinates: [2.35, 48.85] },
          },
        ],
      }),
    }) as Response) as typeof fetch;

  try {
    const suggestions = await searchBanAddresses('adresse sans label');
    assert.deepEqual(suggestions, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('searchBanAddresses - retourne [] quand la réponse ne contient pas de features', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({}),
    }) as Response) as typeof fetch;

  try {
    const suggestions = await searchBanAddresses('adresse sans features');
    assert.deepEqual(suggestions, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('searchBanAddresses - propage une erreur réseau hors timeout', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;

  try {
    await assert.rejects(() => searchBanAddresses('adresse erreur reseau'), /network down/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
