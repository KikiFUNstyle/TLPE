import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachmentPreviewKind,
  attachmentTypeOptionsForRole,
  canUploadContentieuxAttachments,
  canViewContentieuxAttachments,
  clearAttachmentLoadingState,
  defaultAttachmentTypeForRole,
} from './Contentieux';

test('attachmentTypeOptionsForRole limite le contribuable au courrier contribuable', () => {
  assert.deepEqual(attachmentTypeOptionsForRole('contribuable').map((option) => option.value), ['courrier-contribuable']);
  assert.deepEqual(attachmentTypeOptionsForRole('gestionnaire').map((option) => option.value), [
    'courrier-admin',
    'courrier-contribuable',
    'decision',
    'jugement',
  ]);
});

test('defaultAttachmentTypeForRole choisit un type cohérent selon le rôle', () => {
  assert.equal(defaultAttachmentTypeForRole('contribuable'), 'courrier-contribuable');
  assert.equal(defaultAttachmentTypeForRole('admin'), 'courrier-admin');
});

test('attachmentPreviewKind détecte PDF, images et fallback', () => {
  assert.equal(attachmentPreviewKind('application/pdf'), 'pdf');
  assert.equal(attachmentPreviewKind('image/png'), 'image');
  assert.equal(attachmentPreviewKind('text/plain'), 'unsupported');
});

test('droits pièces jointes contentieux autorisent la lecture sauf financier', () => {
  assert.equal(canViewContentieuxAttachments({ role: 'gestionnaire' }), true);
  assert.equal(canViewContentieuxAttachments({ role: 'contribuable' }), true);
  assert.equal(canViewContentieuxAttachments({ role: 'financier' }), false);
  assert.equal(canViewContentieuxAttachments(null), false);
});

test('droits upload pièces jointes contentieux autorisent admin, gestionnaire et contribuable lié', () => {
  assert.equal(canUploadContentieuxAttachments({ role: 'admin', assujetti_id: null }), true);
  assert.equal(canUploadContentieuxAttachments({ role: 'gestionnaire', assujetti_id: null }), true);
  assert.equal(canUploadContentieuxAttachments({ role: 'contribuable', assujetti_id: 12 }), true);
  assert.equal(canUploadContentieuxAttachments({ role: 'contribuable', assujetti_id: null }), false);
  assert.equal(canUploadContentieuxAttachments({ role: 'financier', assujetti_id: null }), false);
});

test('clearAttachmentLoadingState conserve le chargement quand une autre ligne termine en retard', () => {
  assert.equal(clearAttachmentLoadingState(42, 7), 42);
  assert.equal(clearAttachmentLoadingState(42, 42), null);
});

test('sélectionner une autre pièce doit invalider l’aperçu courant', () => {
  let selectedId = 1;
  let previewUrl = 'blob:old-preview';

  const resetAttachmentPreview = () => {
    previewUrl = '';
  };

  const handleSelect = (nextId: number) => {
    resetAttachmentPreview();
    selectedId = nextId;
  };

  handleSelect(2);
  assert.equal(selectedId, 2);
  assert.equal(previewUrl, '');
});

test('canViewContentieuxAttachments ne suffit pas à télécharger anonymement: le téléchargement passe par apiBlob authentifié', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
  let capturedHeaders: HeadersInit | undefined;
  (globalThis as { localStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }).localStorage = {
    getItem: () => 'jwt-test',
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = init?.headers;
    return new Response(new Blob(['%PDF-1.4']), { status: 200 });
  }) as typeof fetch;

  try {
    const { apiBlob } = await import('../api');
    await apiBlob('/api/pieces-jointes/12');
    const headers = capturedHeaders as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer jwt-test');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocalStorage) {
      (globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage;
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }
});
