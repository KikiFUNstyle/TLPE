import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRecouvrementExportFilename,
  buildRecouvrementReportPath,
  canExportRecouvrement,
  defaultRecouvrementFilters,
  shouldApplyRecouvrementRequestResult,
} from './recouvrementReport';

test('defaultRecouvrementFilters initialise les filtres métier attendus', () => {
  assert.deepEqual(defaultRecouvrementFilters(2026), {
    annee: '2026',
    zone: '',
    categorie: '',
    statut_paiement: '',
    ventilation: 'assujetti',
  });
});

test('canExportRecouvrement exige une année valide et un rôle autorisé', () => {
  assert.equal(canExportRecouvrement({ annee: '', canManage: true }), false);
  assert.equal(canExportRecouvrement({ annee: '2026', canManage: false }), false);
  assert.equal(canExportRecouvrement({ annee: '2026', canManage: true }), true);
});

test('buildRecouvrementReportPath construit la requête API complète', () => {
  assert.equal(
    buildRecouvrementReportPath(
      {
        annee: '2026',
        zone: '2',
        categorie: 'enseigne',
        statut_paiement: 'paye_partiel',
        ventilation: 'zone',
      },
      'xlsx',
    ),
    '/api/rapports/recouvrement?annee=2026&zone=2&categorie=enseigne&statut_paiement=paye_partiel&ventilation=zone&format=xlsx',
  );
});

test('buildRecouvrementExportFilename conserve la ventilation et le format', () => {
  assert.equal(buildRecouvrementExportFilename('2026', 'categorie', 'pdf'), 'etat-recouvrement-categorie-2026.pdf');
});

test('shouldApplyRecouvrementRequestResult ignore les réponses obsolètes quand un filtre plus récent a été demandé', () => {
  assert.equal(shouldApplyRecouvrementRequestResult(3, 2), false);
  assert.equal(shouldApplyRecouvrementRequestResult(3, 3), true);
});
