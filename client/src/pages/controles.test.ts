import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canAccessControles,
  controleSubmissionMode,
  readNavigatorOnline,
  shouldQueueControleOffline,
  type ControleDraftInput,
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
