import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRelancesExportFilename,
  buildRelancesReportPath,
  canExportRelances,
  defaultRelancesFilters,
  shouldApplyRelancesRequestResult,
} from './relancesReport';

test('defaultRelancesFilters initialise une période calendaire annuelle', () => {
  assert.deepEqual(defaultRelancesFilters(new Date('2026-09-30T12:00:00Z')), {
    date_debut: '2026-01-01',
    date_fin: '2026-12-31',
    type: '',
    statut: '',
  });
});

test('canExportRelances exige des dates ISO et un rôle autorisé', () => {
  assert.equal(canExportRelances({ dateDebut: '', dateFin: '2026-09-30', canManage: true }), false);
  assert.equal(canExportRelances({ dateDebut: '2026-03-01', dateFin: '2026-09-30', canManage: false }), false);
  assert.equal(canExportRelances({ dateDebut: '2026-03-01', dateFin: '2026-09-30', canManage: true }), true);
});

test('buildRelancesReportPath construit la requête API complète', () => {
  assert.equal(
    buildRelancesReportPath(
      {
        date_debut: '2026-03-01',
        date_fin: '2026-09-30',
        type: 'mise_en_demeure_impaye',
        statut: 'echec',
      },
      'xlsx',
    ),
    '/api/rapports/relances?date_debut=2026-03-01&date_fin=2026-09-30&type=mise_en_demeure_impaye&statut=echec&format=xlsx',
  );
});

test('buildRelancesExportFilename conserve la période et le format', () => {
  assert.equal(buildRelancesExportFilename('2026-03-01', '2026-09-30', 'pdf'), 'suivi-relances-2026-03-01_2026-09-30.pdf');
});

test('shouldApplyRelancesRequestResult ignore les réponses obsolètes', () => {
  assert.equal(shouldApplyRelancesRequestResult(4, 3), false);
  assert.equal(shouldApplyRelancesRequestResult(4, 4), true);
});
