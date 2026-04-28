import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireControleSyncLock,
  canAccessControles,
  controleSubmissionMode,
  readNavigatorOnline,
  shouldQueueControleOffline,
  syncQueuedControles,
  type ControleDraftInput,
  type QueuedControleRecord,
  CONTROLE_FILE_ACCEPT,
} from './Controles';

test('canAccessControles ouvre le module uniquement aux rôles terrain autorisés', () => {
  assert.equal(canAccessControles('admin'), true);
  assert.equal(canAccessControles('gestionnaire'), true);
  assert.equal(canAccessControles('controleur'), true);
  assert.equal(canAccessControles('financier'), false);
  assert.equal(canAccessControles('contribuable'), false);
  assert.equal(canAccessControles(null), false);
});

test('controleSubmissionMode distingue le rattachement existant de la création d’un nouveau dispositif', () => {
  const existing: ControleDraftInput = {
    dispositif_id: 12,
    create_dispositif: null,
  };
  const created: ControleDraftInput = {
    dispositif_id: null,
    create_dispositif: { assujetti_id: 9, type_id: 4 },
  };

  assert.equal(controleSubmissionMode(existing), 'existing');
  assert.equal(controleSubmissionMode(created), 'create');
});

test('controleSubmissionMode rejette un brouillon sans rattachement ni création', () => {
  assert.throws(
    () =>
      controleSubmissionMode({
        dispositif_id: null,
        create_dispositif: null,
      }),
    /dispositif/i,
  );
});

test('shouldQueueControleOffline bascule en file locale quand le terminal est hors ligne', () => {
  assert.equal(shouldQueueControleOffline(true), false);
  assert.equal(shouldQueueControleOffline(false), true);
});

test('readNavigatorOnline lit l’état navigateur avec fallback SSR sûr', () => {
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: false },
    configurable: true,
  });
  assert.equal(readNavigatorOnline(), false);

  Object.defineProperty(globalThis, 'navigator', {
    value: undefined,
    configurable: true,
  });
  assert.equal(readNavigatorOnline(), true);

  Object.defineProperty(globalThis, 'navigator', {
    value: originalNavigator,
    configurable: true,
  });
});

test('acquireControleSyncLock empêche une double synchronisation concurrente', () => {
  const syncRef = { current: false };

  assert.equal(acquireControleSyncLock(syncRef), true);
  assert.equal(syncRef.current, true);
  assert.equal(acquireControleSyncLock(syncRef), false);
});

test('le sélecteur de fichiers terrain n’autorise que les photos jpeg/png', () => {
  assert.equal(CONTROLE_FILE_ACCEPT, 'image/jpeg,image/png');
  assert.equal(CONTROLE_FILE_ACCEPT.includes('application/pdf'), false);
});

test('syncQueuedControles retire le brouillon avant upload photo pour éviter un doublon si l’upload échoue', async () => {
  const draft: QueuedControleRecord = {
    id: 'draft-1',
    payload: {
      dispositif_id: 12,
      create_dispositif: null,
      date_controle: '2026-05-12',
      latitude: 48.8566,
      longitude: 2.3522,
      surface_mesuree: 12,
      nombre_faces_mesurees: 1,
      ecart_detecte: false,
      ecart_description: null,
      statut: 'saisi',
    },
    photos: [{ name: 'photo.jpg', type: 'image/jpeg', blob: new Blob(['jpg']) }],
    created_at: '2026-04-28T00:00:00.000Z',
  };

  const calls: string[] = [];
  let queue = [draft];

  const result = await syncQueuedControles({
    listQueuedControles: async () => queue,
    createControle: async () => {
      calls.push('create');
      return { id: 99 };
    },
    deleteQueuedControle: async (id) => {
      calls.push(`delete:${id}`);
      queue = queue.filter((item) => item.id !== id);
    },
    uploadControlePhotos: async () => {
      calls.push('upload');
      throw new Error('upload failed');
    },
  });

  assert.deepEqual(calls, ['create', 'delete:draft-1', 'upload']);
  assert.deepEqual(result, { synced: 0, remaining: 0 });
});
