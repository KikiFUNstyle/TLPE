import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  acquireControleSyncLock,
  canAccessControles,
  canGenerateControleReport,
  countSelectedControleEcarts,
  controleSubmissionMode,
  downloadControleReportFile,
  readNavigatorOnline,
  selectAllControles,
  shouldQueueControleOffline,
  syncQueuedControles,
  toggleControleSelection,
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

test('canGenerateControleReport réserve le rapport aux rôles gestionnaire/admin', () => {
  assert.equal(canGenerateControleReport('admin'), true);
  assert.equal(canGenerateControleReport('gestionnaire'), true);
  assert.equal(canGenerateControleReport('controleur'), false);
  assert.equal(canGenerateControleReport('financier'), false);
  assert.equal(canGenerateControleReport(null), false);
});

test('countSelectedControleEcarts compte uniquement les constats sélectionnés avec anomalie', () => {
  const rows = [
    { id: 10, ecart_detecte: true },
    { id: 11, ecart_detecte: false },
    { id: 12, ecart_detecte: true },
  ];
  assert.equal(countSelectedControleEcarts(rows, new Set<number>([10, 11])), 1);
  assert.equal(countSelectedControleEcarts(rows, new Set<number>([11])), 0);
  assert.equal(countSelectedControleEcarts(rows, new Set<number>([10, 12])), 2);
});

test('toggleControleSelection ajoute ou retire un contrôle de la sélection', () => {
  const initial = new Set<number>([10]);
  const added = toggleControleSelection(initial, 11);
  assert.deepEqual(Array.from<number>(added).sort((a: number, b: number) => a - b), [10, 11]);

  const removed = toggleControleSelection(added, 10);
  assert.deepEqual(Array.from<number>(removed), [11]);
});

test('selectAllControles sélectionne toutes les lignes visibles', () => {
  const selected = selectAllControles([{ id: 3 }, { id: 7 }, { id: 9 }]);
  assert.deepEqual(Array.from<number>(selected).sort((a: number, b: number) => a - b), [3, 7, 9]);
});

test('downloadControleReportFile conserve le nom renvoyé par le serveur et déclenche le téléchargement', async () => {
  const clicks: string[] = [];
  const appended: string[] = [];
  const removed: string[] = [];
  const revoked: string[] = [];
  const anchor = {
    href: '',
    download: '',
    click() {
      clicks.push(anchor.download);
    },
    remove() {
      removed.push(anchor.download);
    },
  } as unknown as HTMLAnchorElement;

  const filename = await downloadControleReportFile(
    '/api/controles/report',
    { controle_ids: [10], format: 'pdf' },
    'fallback.pdf',
    {
      request: async () => ({
        blob: new Blob(['pdf']),
        filename: 'rapport-controles-2026-05-12.pdf',
      }),
      createObjectUrl: () => 'blob:controle-report',
      revokeObjectUrl: (url) => revoked.push(url),
      createAnchor: () => anchor,
      appendAnchor: (nextAnchor) => appended.push(nextAnchor.download),
      removeAnchor: (nextAnchor) => nextAnchor.remove(),
    },
  );

  assert.equal(filename, 'rapport-controles-2026-05-12.pdf');
  assert.equal(anchor.href, 'blob:controle-report');
  assert.equal(anchor.download, 'rapport-controles-2026-05-12.pdf');
  assert.deepEqual(appended, ['rapport-controles-2026-05-12.pdf']);
  assert.deepEqual(clicks, ['rapport-controles-2026-05-12.pdf']);
  assert.deepEqual(removed, ['rapport-controles-2026-05-12.pdf']);
  assert.deepEqual(revoked, ['blob:controle-report']);
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

test('le service worker ne met en cache que les réponses GET same-origin valides', () => {
  const swPath = path.resolve(process.cwd(), 'public/sw.js');
  const source = fs.readFileSync(swPath, 'utf8');

  assert.match(source, /request\.method !== 'GET'/);
  assert.match(source, /url\.origin !== self\.location\.origin/);
  assert.match(source, /response\.ok && request\.destination !== 'document'/);
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
