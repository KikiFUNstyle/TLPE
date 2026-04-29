import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildComparatifExportFilename,
  buildComparatifReportPath,
  canExportComparatif,
  defaultComparatifFilters,
  shouldApplyComparatifRequestResult,
} from './comparatifReport';

test('defaultComparatifFilters initialise l\'année de référence', () => {
  assert.deepEqual(defaultComparatifFilters(2026), { annee: '2026' });
});

test('canExportComparatif exige une année valide et un rôle autorisé', () => {
  assert.equal(canExportComparatif({ annee: '', canManage: true }), false);
  assert.equal(canExportComparatif({ annee: '2026', canManage: false }), false);
  assert.equal(canExportComparatif({ annee: '2026', canManage: true }), true);
});

test('buildComparatifReportPath construit la requête API attendue', () => {
  assert.equal(buildComparatifReportPath({ annee: '2026' }, 'xlsx'), '/api/rapports/comparatif?annee=2026&format=xlsx');
});

test('buildComparatifExportFilename conserve l\'année et le format', () => {
  assert.equal(buildComparatifExportFilename('2026', 'pdf'), 'comparatif-pluriannuel-2026.pdf');
});

test('shouldApplyComparatifRequestResult ignore les réponses obsolètes', () => {
  assert.equal(shouldApplyComparatifRequestResult(2, 1), false);
  assert.equal(shouldApplyComparatifRequestResult(2, 2), true);
});
