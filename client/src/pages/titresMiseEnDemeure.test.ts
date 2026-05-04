import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canGenerateMiseEnDemeure,
  getBatchEligibleTitreIds,
  getMiseEnDemeureActionLabel,
} from './titresMiseEnDemeure';

test('canGenerateMiseEnDemeure réserve l’action aux rôles admin/financier avec solde restant dû', () => {
  const titre = { id: 10, statut: 'impaye', montant: 1200, montant_paye: 200 };
  assert.equal(canGenerateMiseEnDemeure(titre, false), false);
  assert.equal(canGenerateMiseEnDemeure(titre, true), true);
  assert.equal(canGenerateMiseEnDemeure({ ...titre, montant_paye: 1200, statut: 'paye' }, true), false);
});

test('getMiseEnDemeureActionLabel adapte le libellé pour un titre déjà escaladé', () => {
  assert.equal(getMiseEnDemeureActionLabel({ id: 1, statut: 'impaye', montant: 100, montant_paye: 0 }), 'Générer mise en demeure');
  assert.equal(
    getMiseEnDemeureActionLabel({ id: 2, statut: 'mise_en_demeure', montant: 100, montant_paye: 0 }),
    'Télécharger mise en demeure',
  );
});

test('getBatchEligibleTitreIds ne retient que les titres générables et borne le lot à 100', () => {
  const titres = [
    { id: 1, statut: 'impaye', montant: 100, montant_paye: 0 },
    { id: 2, statut: 'paye', montant: 100, montant_paye: 100 },
    { id: 3, statut: 'paye_partiel', montant: 300, montant_paye: 50 },
  ];
  assert.deepEqual(getBatchEligibleTitreIds(titres, true), [1, 3]);

  const many = Array.from({ length: 105 }, (_value, index) => ({
    id: index + 1,
    statut: 'impaye',
    montant: 100,
    montant_paye: 0,
  }));
  assert.equal(getBatchEligibleTitreIds(many, true).length, 100);
});
