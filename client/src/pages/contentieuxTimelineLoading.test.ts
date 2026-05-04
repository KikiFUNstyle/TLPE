import test from 'node:test';
import assert from 'node:assert/strict';
import { clearContentieuxActionState, clearTimelineLoadingState } from './Contentieux';

test('clearTimelineLoadingState conserve le chargement quand une autre timeline termine en retard', () => {
  assert.equal(clearTimelineLoadingState(42, 7), 42);
});

test('clearTimelineLoadingState réinitialise le chargement quand la timeline courante se termine', () => {
  assert.equal(clearTimelineLoadingState(42, 42), null);
});

test('clearContentieuxActionState conserve l’état décision quand une autre ligne termine en retard', () => {
  assert.equal(clearContentieuxActionState(42, 7), 42);
});

test('clearContentieuxActionState réinitialise l’état décision quand la ligne courante se termine', () => {
  assert.equal(clearContentieuxActionState(42, 42), null);
});
