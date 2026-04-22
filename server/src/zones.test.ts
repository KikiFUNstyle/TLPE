import test from 'node:test';
import assert from 'node:assert/strict';
import { db, initSchema } from './db';
import { findZoneIdByPoint, importGeoJsonZones, pointInGeometry, type GeoJsonGeometry } from './zones';

function resetTables() {
  initSchema();
  db.exec('DELETE FROM zones');
}

const simpleSquare: GeoJsonGeometry = {
  type: 'Polygon',
  coordinates: [[
    [2, 48],
    [3, 48],
    [3, 49],
    [2, 49],
    [2, 48],
  ]],
};

test('pointInGeometry detecte un point dans un polygon', () => {
  const inside = pointInGeometry({ latitude: 48.5, longitude: 2.5 }, simpleSquare);
  const outside = pointInGeometry({ latitude: 47.5, longitude: 2.5 }, simpleSquare);

  assert.equal(inside, true);
  assert.equal(outside, false);
});

test('importGeoJsonZones cree puis met a jour des zones', () => {
  resetTables();

  const first = importGeoJsonZones({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { code: 'ZONE-A', libelle: 'Zone A', coefficient: 1.2 },
        geometry: simpleSquare,
      },
    ],
  });

  assert.deepEqual(first, { imported: 1, created: 1, updated: 0 });

  const second = importGeoJsonZones({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { code: 'ZONE-A', libelle: 'Zone A+', coefficient: 1.5 },
        geometry: simpleSquare,
      },
    ],
  });

  assert.deepEqual(second, { imported: 1, created: 0, updated: 1 });

  const row = db.prepare('SELECT libelle, coefficient, geometry FROM zones WHERE code = ?').get('ZONE-A') as {
    libelle: string;
    coefficient: number;
    geometry: string;
  };

  assert.equal(row.libelle, 'Zone A+');
  assert.equal(row.coefficient, 1.5);
  assert.ok(row.geometry.includes('Polygon'));
});

test('findZoneIdByPoint retourne la zone correspondante', () => {
  resetTables();

  importGeoJsonZones({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { code: 'CENTRE', libelle: 'Centre-ville', coefficient: 2 },
        geometry: simpleSquare,
      },
    ],
  });

  const zoneInside = findZoneIdByPoint({ latitude: 48.4, longitude: 2.3 });
  const zoneOutside = findZoneIdByPoint({ latitude: 47.0, longitude: 1.5 });

  assert.ok(zoneInside);
  assert.equal(zoneOutside, null);
});