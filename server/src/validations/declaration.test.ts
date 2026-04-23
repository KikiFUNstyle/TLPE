import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeclarationSubmission } from './declaration';

function makeLine(overrides: Partial<Parameters<typeof validateDeclarationSubmission>[0]['lignes'][number]> = {}) {
  return {
    id: 1,
    dispositif_id: 100,
    surface_declaree: 12,
    nombre_faces: 1,
    date_pose: '2025-01-01',
    date_depose: null,
    type_id: 10,
    categorie: 'publicitaire' as const,
    adresse_rue: '12 rue Victor Hugo',
    adresse_cp: '75001',
    adresse_ville: 'Paris',
    ...overrides,
  };
}

test('bloque si aucune ligne déclarée', () => {
  const result = validateDeclarationSubmission({ lignes: [], previousYearSurfaceTotal: 0 });

  assert.equal(result.hasManagerAlert, false);
  assert.equal(result.warnings.length, 0);
  assert.ok(result.blockingErrors.some((e) => e.includes('Aucun dispositif')));
});

test('bloque sur complétude et cohérence des dates', () => {
  const result = validateDeclarationSubmission({
    lignes: [
      makeLine({ id: 1, surface_declaree: 0 }),
      makeLine({ id: 2, type_id: null, categorie: null }),
      makeLine({ id: 3, date_pose: '2025-13-40' }),
      makeLine({ id: 4, date_pose: '2025-02-01', date_depose: '2025-01-10' }),
    ],
    previousYearSurfaceTotal: 0,
  });

  assert.ok(result.blockingErrors.some((e) => e.includes('surface déclarée invalide')));
  assert.ok(result.blockingErrors.some((e) => e.includes('type de dispositif manquant')));
  assert.ok(result.blockingErrors.some((e) => e.includes('date de pose invalide')));
  assert.ok(result.blockingErrors.some((e) => e.includes('antérieure ou égale')));
});

test('bloque sur doublon adresse + type', () => {
  const first = makeLine({ id: 11, type_id: 4, adresse_rue: '1 place de la mairie', adresse_cp: '33000', adresse_ville: 'Bordeaux' });
  const second = makeLine({ id: 12, type_id: 4, adresse_rue: ' 1 PLACE   DE LA MAIRIE ', adresse_cp: '33000', adresse_ville: 'bordeaux' });

  const result = validateDeclarationSubmission({
    lignes: [first, second],
    previousYearSurfaceTotal: 0,
  });

  assert.ok(result.blockingErrors.some((e) => e.includes('Doublon détecté')));
});

test('déclenche une alerte non bloquante si variation N/N-1 > 30%', () => {
  const result = validateDeclarationSubmission({
    lignes: [makeLine({ id: 20, surface_declaree: 200 })],
    previousYearSurfaceTotal: 100,
  });

  assert.equal(result.blockingErrors.length, 0);
  assert.equal(result.hasManagerAlert, true);
  assert.ok(result.warnings.some((w) => w.includes('supérieure à 30%')));
});

test('n’active pas l’alerte si variation <= 30%', () => {
  const result = validateDeclarationSubmission({
    lignes: [makeLine({ id: 30, surface_declaree: 130 })],
    previousYearSurfaceTotal: 100,
  });

  assert.equal(result.blockingErrors.length, 0);
  assert.equal(result.hasManagerAlert, false);
  assert.equal(result.warnings.length, 0);
});
