import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBordereauFilename, buildBordereauPath, canExportBordereau } from './titresBordereau';
import {
  api,
  apiBlob,
  apiBlobWithMetadata,
  buildHeaders,
  extractFilenameFromDisposition,
  shouldSendJsonContentType,
} from '../api';

test('canExportBordereau exige une année filtrée et un rôle financier/admin', () => {
  assert.equal(canExportBordereau({ annee: '', canManage: true }), false);
  assert.equal(canExportBordereau({ annee: '2026', canManage: false }), false);
  assert.equal(canExportBordereau({ annee: '2026', canManage: true }), true);
});

test('helpers construisent le chemin et le nom de fichier attendus', () => {
  assert.equal(buildBordereauPath('2026', 'pdf'), '/api/titres/bordereau?annee=2026&format=pdf');
  assert.equal(buildBordereauFilename('2026', 'xlsx'), 'bordereau-titres-2026.xlsx');
});

test('shouldSendJsonContentType active le header JSON pour un body stringifié', () => {
  assert.equal(shouldSendJsonContentType({ body: JSON.stringify({ campagne_id: 12 }) }), true);
  assert.equal(shouldSendJsonContentType({ body: new FormData() }), false);
});

test('buildHeaders ajoute Content-Type JSON pour apiBlob POST JSON', () => {
  const headers = buildHeaders({ body: JSON.stringify({ campagne_id: 12 }) }, shouldSendJsonContentType({ body: JSON.stringify({ campagne_id: 12 }) }));
  assert.equal(headers['Content-Type'], 'application/json');
});

test('extractFilenameFromDisposition lit le nom retourné par le serveur', () => {
  assert.equal(
    extractFilenameFromDisposition('attachment; filename="pesv2-000123.xml"'),
    'pesv2-000123.xml',
  );
});

test('apiBlobWithMetadata conserve le nom de fichier serveur', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Blob(['<xml />']), {
      status: 200,
      headers: {
        'content-disposition': 'attachment; filename="pesv2-000777.xml"',
      },
    })) as typeof fetch;

  try {
    const result = await apiBlobWithMetadata('/api/titres/export-pesv2', {
      method: 'POST',
      body: JSON.stringify({ campagne_id: 12 }),
    });
    assert.equal(result.filename, 'pesv2-000777.xml');
    assert.equal(await result.blob.text(), '<xml />');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('apiBlob POST JSON envoie bien Content-Type application/json', async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders: HeadersInit | undefined;
  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = init?.headers;
    return new Response(new Blob(['ok']), { status: 200 });
  }) as typeof fetch;

  try {
    await apiBlob('/api/titres/export-pesv2', {
      method: 'POST',
      body: JSON.stringify({ campagne_id: 12 }),
    });
    const headers = capturedHeaders as Record<string, string>;
    assert.equal(headers['Content-Type'], 'application/json');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('api POST FormData ne force pas Content-Type JSON pour les uploads multipart', async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders: HeadersInit | undefined;
  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = init?.headers;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const formData = new FormData();
    formData.set('entite', 'contentieux');
    formData.set('entite_id', '12');
    await api('/api/pieces-jointes', {
      method: 'POST',
      body: formData,
    });
    const headers = (capturedHeaders ?? {}) as Record<string, string>;
    assert.equal(headers['Content-Type'], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
