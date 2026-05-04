import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContentieuxExportFilename,
  buildContentieuxReportPath,
  canExportContentieux,
  defaultContentieuxReportFilters,
  defaultDegrevementAmount,
  shouldApplyContentieuxRequestResult,
  shouldShowDegrevementAmount,
} from './contentieuxReport';

test('defaultContentieuxReportFilters initialise la date de référence attendue', () => {
  assert.deepEqual(defaultContentieuxReportFilters('2026-06-30'), { date_reference: '2026-06-30' });
});

test('buildContentieuxReportPath construit la requête API attendue', () => {
  assert.equal(
    buildContentieuxReportPath({ date_reference: '2026-06-30' }, 'xlsx'),
    '/api/rapports/contentieux?date_reference=2026-06-30&format=xlsx',
  );
  assert.equal(buildContentieuxReportPath('xlsx'), '/api/rapports/contentieux?format=xlsx');
});

test('buildContentieuxExportFilename conserve la date de référence et le format', () => {
  assert.equal(buildContentieuxExportFilename('2026-06-30', 'pdf'), 'synthese-contentieux-2026-06-30.pdf');
});

test('canExportContentieux exige une date de référence valide et un rôle autorisé', () => {
  assert.equal(canExportContentieux({ dateReference: '2026-06-30', canManage: false }), false);
  assert.equal(canExportContentieux({ dateReference: '2026-06-30', canManage: true }), true);
  assert.equal(canExportContentieux({ dateReference: '2026/06/30', canManage: true }), false);
});

test('shouldApplyContentieuxRequestResult ignore les réponses périmées', () => {
  assert.equal(shouldApplyContentieuxRequestResult(3, 3), true);
  assert.equal(shouldApplyContentieuxRequestResult(4, 3), false);
});

test('shouldShowDegrevementAmount affiche le champ seulement pour les statuts de dégrèvement', () => {
  assert.equal(shouldShowDegrevementAmount('instruction'), false);
  assert.equal(shouldShowDegrevementAmount('degrevement_partiel'), true);
  assert.equal(shouldShowDegrevementAmount('degrevement_total'), true);
});

test('defaultDegrevementAmount préremplit le montant total pour un dégrèvement total', () => {
  assert.equal(defaultDegrevementAmount('degrevement_total', 450), '450');
  assert.equal(defaultDegrevementAmount('degrevement_partiel', 450), '');
  assert.equal(defaultDegrevementAmount('degrevement_total', null), '');
});
