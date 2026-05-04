import test from 'node:test';
import assert from 'node:assert/strict';
import { db, initSchema } from './db';
import { findZoneIdByPoint, importGeoJsonZones, isSupportedGeometry, normalizeGeometry, pointInGeometry, type GeoJsonGeometry } from './zones';

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

// ─── isSupportedGeometry ──────────────────────────────────────────────────────

test('isSupportedGeometry accepte un Polygon et un MultiPolygon valides', () => {
  assert.equal(isSupportedGeometry(simpleSquare), true);

  const multiPoly: GeoJsonGeometry = {
    type: 'MultiPolygon',
    coordinates: [simpleSquare.coordinates],
  };
  assert.equal(isSupportedGeometry(multiPoly), true);
});

test('isSupportedGeometry rejette les geometries invalides', () => {
  assert.equal(isSupportedGeometry(null), false);
  assert.equal(isSupportedGeometry('Polygon'), false);
  assert.equal(isSupportedGeometry({ type: 'Point', coordinates: [2, 48] }), false);
  assert.equal(isSupportedGeometry({ type: 'Polygon', coordinates: [] }), false);
  assert.equal(isSupportedGeometry({ type: 'Polygon', coordinates: [[]] }), false);
  // Anneau insuffisant (< 4 points)
  assert.equal(isSupportedGeometry({ type: 'Polygon', coordinates: [[[2, 48], [3, 48], [2, 48]]] }), false);
});

// ─── normalizeGeometry ────────────────────────────────────────────────────────

test('normalizeGeometry lance une erreur pour une geometrie invalide', () => {
  assert.throws(
    () => normalizeGeometry({ type: 'Point', coordinates: [2, 48] }),
    /GeoJSON invalide/,
  );
  assert.throws(
    () => normalizeGeometry(null),
    /GeoJSON invalide/,
  );
});

test('normalizeGeometry retourne la geometrie inchangee si valide', () => {
  const result = normalizeGeometry(simpleSquare);
  assert.deepEqual(result, simpleSquare);
});

// ─── pointInGeometry avec MultiPolygon ───────────────────────────────────────

test('pointInGeometry detecte un point dans un MultiPolygon', () => {
  const secondSquare: GeoJsonGeometry = {
    type: 'Polygon',
    coordinates: [[
      [10, 48],
      [11, 48],
      [11, 49],
      [10, 49],
      [10, 48],
    ]],
  };

  const multi: GeoJsonGeometry = {
    type: 'MultiPolygon',
    coordinates: [
      simpleSquare.coordinates as [number, number][][],
      secondSquare.coordinates as [number, number][][],
    ],
  };

  assert.equal(pointInGeometry({ latitude: 48.5, longitude: 2.5 }, multi), true);
  assert.equal(pointInGeometry({ latitude: 48.5, longitude: 10.5 }, multi), true);
  assert.equal(pointInGeometry({ latitude: 48.5, longitude: 6.0 }, multi), false);
});

// ─── importGeoJsonZones – chemins d'erreur ────────────────────────────────────

test('importGeoJsonZones rejette une entree non-FeatureCollection', () => {
  resetTables();
  assert.throws(
    () => importGeoJsonZones(null),
    /GeoJSON invalide/,
  );
  assert.throws(
    () => importGeoJsonZones({ type: 'Feature', geometry: simpleSquare }),
    /FeatureCollection/,
  );
});

test('importGeoJsonZones rejette une Feature sans code zone', () => {
  resetTables();
  assert.throws(
    () => importGeoJsonZones({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { libelle: 'Sans code', coefficient: 1 },
          geometry: simpleSquare,
        },
      ],
    }),
    /code zone manquant/,
  );
});

test('importGeoJsonZones rejette un coefficient invalide', () => {
  resetTables();
  assert.throws(
    () => importGeoJsonZones({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { code: 'TEST', libelle: 'Test', coefficient: -1 },
          geometry: simpleSquare,
        },
      ],
    }),
    /coefficient invalide/,
  );
});

test('importGeoJsonZones rejette une Feature mal formatee', () => {
  resetTables();
  assert.throws(
    () => importGeoJsonZones({
      type: 'FeatureCollection',
      features: [{ type: 'invalid', properties: {}, geometry: simpleSquare }],
    }),
    /format invalide/,
  );
});

test('importGeoJsonZones accepte les proprietes alternatives CODE / nom / coeff', () => {
  resetTables();

  const result = importGeoJsonZones({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { CODE: 'ALT-ZONE', nom: 'Zone Alternative', coeff: 1.3, description: 'Une description' },
        geometry: simpleSquare,
      },
    ],
  });

  assert.deepEqual(result, { imported: 1, created: 1, updated: 0 });

  const row = db
    .prepare('SELECT code, libelle, coefficient, description FROM zones WHERE code = ?')
    .get('ALT-ZONE') as { code: string; libelle: string; coefficient: number; description: string | null };

  assert.equal(row.code, 'ALT-ZONE');
  assert.equal(row.libelle, 'Zone Alternative');
  assert.equal(row.coefficient, 1.3);
  assert.equal(row.description, 'Une description');
});