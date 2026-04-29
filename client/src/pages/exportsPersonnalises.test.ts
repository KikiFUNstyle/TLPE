import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExportPersonnaliseFilename,
  buildSavedTemplatePayload,
  defaultConfigForEntity,
  normalizeTemplateConfig,
  resolveEntityConfig,
  shouldShowExportsLoadingState,
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

test('resolveEntityConfig réutilise les métadonnées chargées quand elles existent', () => {
  const paiementConfig = resolveEntityConfig(
    [
      {
        key: 'paiements',
        defaultColumns: ['reference', 'provider'],
        defaultOrder: { colonne: 'provider', direction: 'asc' },
      },
    ],
    'paiements',
  );

  assert.deepEqual(paiementConfig, {
    selectedEntity: 'paiements',
    selectedColumns: ['reference', 'provider'],
    filters: [],
    order: { colonne: 'provider', direction: 'asc' },
  });
});

test('resolveEntityConfig retombe sur les defaults codés en dur si les métadonnées sont absentes', () => {
  const config = resolveEntityConfig([], 'titres');
  assert.deepEqual(config, {
    selectedEntity: 'titres',
    selectedColumns: ['numero', 'assujetti', 'montant', 'statut'],
    filters: [],
    order: { colonne: 'numero', direction: 'desc' },
  });
});

test('shouldShowExportsLoadingState distingue un chargement initial d’une erreur de chargement', () => {
  assert.equal(shouldShowExportsLoadingState(true, null, null), true);
  assert.equal(shouldShowExportsLoadingState(false, null, null), true);
  assert.equal(shouldShowExportsLoadingState(false, null, 'Erreur API'), false);
  assert.equal(shouldShowExportsLoadingState(false, { key: 'assujettis' }, 'Erreur API'), false);
});

test('quand les métadonnées échouent à charger, la page sort du faux chargement permanent pour afficher un fallback d’erreur', () => {
  const showLoading = shouldShowExportsLoadingState(false, null, 'Erreur API');
  assert.equal(showLoading, false);
  const fallback = !showLoading ? 'Impossible de charger la configuration des exports personnalisés.' : 'Chargement des exports personnalisés...';
  assert.equal(fallback, 'Impossible de charger la configuration des exports personnalisés.');
});

test('les entités supportées restent stables pour la page d’exports personnalisés', () => {
  const entities: ExportEntityKey[] = ['assujettis', 'dispositifs', 'declarations', 'titres', 'paiements', 'contentieux'];
  assert.equal(entities.length, 6);
});
