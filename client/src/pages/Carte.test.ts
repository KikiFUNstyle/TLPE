import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGeoJson, getStatusStyle, type DispositifMapItem } from './carteUtils';

test('getStatusStyle retourne les libellés attendus', () => {
  assert.deepEqual(getStatusStyle('declare'), { color: '#0063cb', label: 'Déclaré' });
  assert.deepEqual(getStatusStyle('controle'), { color: '#18753c', label: 'Contrôlé' });
  assert.deepEqual(getStatusStyle('litigieux'), { color: '#b34000', label: 'Litigieux' });
  assert.deepEqual(getStatusStyle('depose'), { color: '#6a6f7f', label: 'Déposé' });
  assert.deepEqual(getStatusStyle('exonere'), { color: '#7a40bf', label: 'Exonéré' });
});

test('getStatusStyle fallback sur statut inconnu', () => {
  assert.deepEqual(getStatusStyle('inconnu'), { color: '#5d6887', label: 'inconnu' });
});

test('buildGeoJson construit une FeatureCollection avec coordonnées lon/lat', () => {
  const items: DispositifMapItem[] = [
    {
      id: 12,
      identifiant: 'DSP-2026-000012',
      statut: 'declare',
      latitude: 48.8566,
      longitude: 2.3522,
      adresse_rue: '12 rue de la Paix',
      adresse_cp: '75001',
      adresse_ville: 'Paris',
      zone_id: 1,
      zone_libelle: 'Zone centrale',
      type_id: 2,
      type_libelle: 'Enseigne à plat',
      assujetti_raison_sociale: 'Société Exemple',
    },
  ];

  const json = buildGeoJson(items);
  const parsed = JSON.parse(json) as {
    type: string;
    features: Array<{
      type: string;
      geometry: { type: string; coordinates: [number, number] };
      properties: Record<string, unknown>;
    }>;
  };

  assert.equal(parsed.type, 'FeatureCollection');
  assert.equal(parsed.features.length, 1);
  assert.equal(parsed.features[0].type, 'Feature');
  assert.equal(parsed.features[0].geometry.type, 'Point');
  assert.deepEqual(parsed.features[0].geometry.coordinates, [2.3522, 48.8566]);
  assert.equal(parsed.features[0].properties.identifiant, 'DSP-2026-000012');
  assert.equal(parsed.features[0].properties.statut, 'declare');
});
