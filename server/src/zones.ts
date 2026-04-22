import { db } from './db';

export type GeoJsonGeometry = {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: unknown;
};

export interface ZoneGeometry {
  id: number;
  code: string;
  libelle: string;
  geometry: GeoJsonGeometry;
}

export interface Point {
  latitude: number;
  longitude: number;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isLngLat(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length >= 2 && isNumber(value[0]) && isNumber(value[1]);
}

function isLinearRing(value: unknown): value is [number, number][] {
  if (!Array.isArray(value) || value.length < 4) return false;
  if (!value.every((p) => isLngLat(p))) return false;
  const first = value[0];
  const last = value[value.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

function isPolygonCoordinates(value: unknown): value is [number, number][][] {
  return Array.isArray(value) && value.length > 0 && value.every((ring) => isLinearRing(ring));
}

function isMultiPolygonCoordinates(value: unknown): value is [number, number][][][] {
  return Array.isArray(value) && value.length > 0 && value.every((poly) => isPolygonCoordinates(poly));
}

export function isSupportedGeometry(value: unknown): value is GeoJsonGeometry {
  if (!value || typeof value !== 'object') return false;
  const v = value as { type?: unknown; coordinates?: unknown };
  if (v.type === 'Polygon') return isPolygonCoordinates(v.coordinates);
  if (v.type === 'MultiPolygon') return isMultiPolygonCoordinates(v.coordinates);
  return false;
}

export function normalizeGeometry(geometry: unknown): GeoJsonGeometry {
  if (!isSupportedGeometry(geometry)) {
    throw new Error('Geometrie GeoJSON invalide (Polygon ou MultiPolygon attendu)');
  }
  return geometry;
}

function pointOnSegment(point: [number, number], a: [number, number], b: [number, number], epsilon = 1e-12): boolean {
  const [px, py] = point;
  const [ax, ay] = a;
  const [bx, by] = b;

  const sqLen = (bx - ax) ** 2 + (by - ay) ** 2;
  if (sqLen <= epsilon) {
    return Math.abs(px - ax) <= epsilon && Math.abs(py - ay) <= epsilon;
  }

  const cross = (px - ax) * (by - ay) - (py - ay) * (bx - ax);
  if (Math.abs(cross) > epsilon) return false;

  const dot = (px - ax) * (bx - ax) + (py - ay) * (by - ay);
  if (dot < 0) return false;

  return dot <= sqLen + epsilon;
}

function pointInRing(point: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    if (pointOnSegment(point, ring[j], ring[i])) return true;

    const intersects = ((yi > point[1]) !== (yj > point[1]))
      && (point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point: [number, number], polygon: [number, number][][]): boolean {
  if (!pointInRing(point, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i += 1) {
    if (pointInRing(point, polygon[i])) return false;
  }
  return true;
}

export function pointInGeometry(point: Point, geometry: GeoJsonGeometry): boolean {
  const pt: [number, number] = [point.longitude, point.latitude];
  if (geometry.type === 'Polygon') {
    return pointInPolygon(pt, geometry.coordinates as [number, number][][]);
  }

  const multi = geometry.coordinates as [number, number][][][];
  return multi.some((polygon) => pointInPolygon(pt, polygon));
}

export function findZoneIdByPoint(point: Point): number | null {
  const zones = db
    .prepare(
      `SELECT id, geometry
       FROM zones
       WHERE geometry IS NOT NULL`,
    )
    .all() as Array<{ id: number; geometry: string | null }>;

  for (const zone of zones) {
    if (!zone.geometry) continue;
    try {
      const geometry = normalizeGeometry(JSON.parse(zone.geometry));
      if (pointInGeometry(point, geometry)) return zone.id;
    } catch {
      continue;
    }
  }

  return null;
}

export function importGeoJsonZones(input: unknown): { imported: number; updated: number; created: number } {
  if (!input || typeof input !== 'object') {
    throw new Error('GeoJSON invalide');
  }

  const root = input as { type?: unknown; features?: unknown };
  if (root.type !== 'FeatureCollection' || !Array.isArray(root.features)) {
    throw new Error('GeoJSON invalide: FeatureCollection attendue');
  }

  const selectByCode = db.prepare('SELECT id FROM zones WHERE code = ?');
  const insertZone = db.prepare(
    `INSERT INTO zones (code, libelle, coefficient, description, geometry)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const updateZone = db.prepare(
    `UPDATE zones
     SET libelle = ?, coefficient = ?, description = ?, geometry = ?
     WHERE id = ?`,
  );

  let created = 0;
  let updated = 0;

  const tx = db.transaction((features: unknown[]) => {
    for (let index = 0; index < features.length; index += 1) {
      const feature = features[index] as { type?: unknown; properties?: unknown; geometry?: unknown };
      if (!feature || feature.type !== 'Feature') {
        throw new Error(`Feature ${index + 1}: format invalide`);
      }

      const props = (feature.properties ?? {}) as Record<string, unknown>;
      const codeRaw = props.code ?? props.CODE ?? props.zone_code;
      const libelleRaw = props.libelle ?? props.nom ?? props.name ?? codeRaw;
      const coefficientRaw = props.coefficient ?? props.coeff ?? props.coeff_zone ?? 1;
      const descriptionRaw = props.description ?? null;

      const code = typeof codeRaw === 'string' ? codeRaw.trim() : '';
      if (!code) throw new Error(`Feature ${index + 1}: code zone manquant`);

      const libelle = typeof libelleRaw === 'string' ? libelleRaw.trim() : '';
      if (!libelle) throw new Error(`Feature ${index + 1}: libelle zone manquant`);

      const coefficient = Number(coefficientRaw);
      if (!Number.isFinite(coefficient) || coefficient <= 0) {
        throw new Error(`Feature ${index + 1}: coefficient invalide`);
      }

      const geometry = normalizeGeometry(feature.geometry);
      const geometryJson = JSON.stringify(geometry);
      const description = typeof descriptionRaw === 'string' && descriptionRaw.trim().length > 0
        ? descriptionRaw.trim()
        : null;

      const existing = selectByCode.get(code) as { id: number } | undefined;
      if (existing) {
        updateZone.run(libelle, coefficient, description, geometryJson, existing.id);
        updated += 1;
      } else {
        insertZone.run(code, libelle, coefficient, description, geometryJson);
        created += 1;
      }
    }
  });

  tx(root.features);
  return {
    imported: created + updated,
    created,
    updated,
  };
}
