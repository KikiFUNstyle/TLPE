import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExportPersonnaliseFilename,
  buildSavedTemplatePayload,
  defaultConfigForEntity,
  normalizeTemplateConfig,
  type ExportEntityKey,
} from './exportsPersonnalises';

test('defaultConfigForEntity initialise des colonnes par défaut par entité', () => {
  assert.deepEqual(defaultConfigForEntity('assujettis').colonnes, ['raison_sociale', 'siret', 'statut']);
  assert.deepEqual(defaultConfigForEntity('paiements').colonnes, ['reference', 'titre_numero', 'assujetti', 'montant']);
});

test('normalizeTemplateConfig retire les filtres incomplets et conserve un ordre valide', () => {
  const config = normalizeTemplateConfig({
    colonnes: ['numero', 'montant'],
    filtres: [
      { colonne: 'statut', operateur: 'eq', valeur: 'paye' },
      { colonne: '', operateur: 'contains', valeur: 'inutile' },
      { colonne: 'assujetti', operateur: 'contains', valeur: '' },
    ],
    ordre: { colonne: 'montant', direction: 'desc' },
  });

  assert.deepEqual(config.filtres, [{ colonne: 'statut', operateur: 'eq', valeur: 'paye' }]);
  assert.deepEqual(config.ordre, { colonne: 'montant', direction: 'desc' });
});

test('buildSavedTemplatePayload formate le payload attendu par l’API', () => {
  const payload = buildSavedTemplatePayload('Mon modèle', 'titres', {
    colonnes: ['numero', 'assujetti'],
    filtres: [],
    ordre: { colonne: 'numero', direction: 'asc' },
  });

  assert.equal(payload.nom, 'Mon modèle');
  assert.equal(payload.entite, 'titres');
  assert.deepEqual(payload.configuration.colonnes, ['numero', 'assujetti']);
});

test('buildExportPersonnaliseFilename produit un nom cohérent avec l’entité et le format', () => {
  assert.equal(buildExportPersonnaliseFilename('contentieux', 'csv'), 'export-contentieux.csv');
  assert.equal(buildExportPersonnaliseFilename('declarations', 'xlsx'), 'export-declarations.xlsx');
});

test('les entités supportées restent stables pour la page d’exports personnalisés', () => {
  const entities: ExportEntityKey[] = ['assujettis', 'dispositifs', 'declarations', 'titres', 'paiements', 'contentieux'];
  assert.equal(entities.length, 6);
});
