import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TITRE_STATUS_OPTIONS,
  canAdmettreNonValeur,
  canRendreExecutoire,
  canViewRecouvrementHistory,
  getTitreStatusBadgeVariant,
  getTitreStatusLabel,
} from './titreStatut';

test('les statuts de titres exposent les nouveaux états métier US5.9', () => {
  assert.ok(TITRE_STATUS_OPTIONS.some((option) => option.value === 'transmis_comptable'));
  assert.ok(TITRE_STATUS_OPTIONS.some((option) => option.value === 'admis_en_non_valeur'));
  assert.equal(getTitreStatusLabel('transmis_comptable'), 'Transmis comptable');
  assert.equal(getTitreStatusLabel('admis_en_non_valeur'), 'Admis en non-valeur');
});

test('les variantes d affichage et actions UI respectent le workflow titre exécutoire', () => {
  assert.equal(getTitreStatusBadgeVariant('transmis_comptable'), 'primary');
  assert.equal(getTitreStatusBadgeVariant('admis_en_non_valeur'), 'info');
  assert.equal(canRendreExecutoire('mise_en_demeure', true), true);
  assert.equal(canRendreExecutoire('impaye', true), false);
  assert.equal(canAdmettreNonValeur('transmis_comptable', true), true);
  assert.equal(canAdmettreNonValeur('mise_en_demeure', true), false);
  assert.equal(canAdmettreNonValeur('transmis_comptable', false), false);
  assert.equal(canViewRecouvrementHistory('transmis_comptable', false), true);
  assert.equal(canViewRecouvrementHistory('admis_en_non_valeur', false), true);
  assert.equal(canViewRecouvrementHistory('paye', false), false);
  assert.equal(canViewRecouvrementHistory('paye', true), true);
});