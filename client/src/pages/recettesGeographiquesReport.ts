export type RecettesGeographiquesZoneColorScale = 'montant_recouvre' | 'taux_recouvrement' | 'reste_a_recouvrer';
export type RecettesGeographiquesApiExportFormat = 'pdf';
export type RecettesGeographiquesExportFormat = RecettesGeographiquesApiExportFormat | 'png';

export type RecettesGeographiquesFiltersForm = {
  annee: string;
  color_scale: RecettesGeographiquesZoneColorScale;
};

type RecettesGeographiquesSvgGeometry = {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: unknown;
};

type RecettesGeographiquesSvgZone = {
  zone_id: number;
  zone_code: string;
  zone_label: string;
  value: number;
  fillColor: string;
  geometry: RecettesGeographiquesSvgGeometry;
};

type RecettesGeographiquesSvgDocumentParams = {
  width: number;
  height: number;
  title: string;
  legendLabel: string;
  thresholds: number[];
  selectedZoneId: number | null;
  zones: RecettesGeographiquesSvgZone[];
};

type BoundingBox = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export function defaultRecettesGeographiquesFilters(year: number): RecettesGeographiquesFiltersForm {
  return {
    annee: String(year),
    color_scale: 'montant_recouvre',
  };
}

export function canExportRecettesGeographiques(params: { annee: string; canManage: boolean }) {
  return params.canManage && /^\d{4}$/.test(params.annee);
}

export function buildRecettesGeographiquesReportPath(
  filters: RecettesGeographiquesFiltersForm,
  format: 'json' | RecettesGeographiquesApiExportFormat = 'json',
) {
  const params = new URLSearchParams();
  params.set('annee', filters.annee);
  params.set('color_scale', filters.color_scale);
  params.set('format', format);
  return `/api/rapports/recettes-geographiques?${params.toString()}`;
}

export function buildRecettesGeographiquesExportFilename(annee: string, format: RecettesGeographiquesExportFormat) {
  return `recettes-geographiques-${annee}.${format}`;
}

type RecettesGeographiquesCanvasContextLike = {
  drawImage: (image: unknown, dx: number, dy: number, dw?: number, dh?: number) => void;
};

type RecettesGeographiquesCanvasLike = {
  width: number;
  height: number;
  getContext: (contextId: '2d') => RecettesGeographiquesCanvasContextLike | null;
  toBlob: (callback: (blob: Blob | null) => void, type?: string) => void;
};

type RecettesGeographiquesImageLike = {
  onload: (() => void) | null;
  onerror: ((error?: unknown) => void) | null;
  src: string;
};

type RecettesGeographiquesPngDeps = {
  createCanvas: (width: number, height: number) => RecettesGeographiquesCanvasLike;
  createImage: () => RecettesGeographiquesImageLike;
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  createSvgBlob: (markup: string) => Blob;
};

export async function renderRecettesGeographiquesPngBlob(
  svgMarkup: string,
  width: number,
  height: number,
  deps?: Partial<RecettesGeographiquesPngDeps>,
): Promise<Blob> {
  const createCanvas = deps?.createCanvas ?? ((targetWidth: number, targetHeight: number) => {
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    return canvas;
  });
  const createImage = deps?.createImage ?? (() => new Image());
  const createObjectUrl = deps?.createObjectUrl ?? ((blob: Blob) => window.URL.createObjectURL(blob));
  const revokeObjectUrl = deps?.revokeObjectUrl ?? ((url: string) => window.URL.revokeObjectURL(url));
  const createSvgBlob = deps?.createSvgBlob ?? ((markup: string) => new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));

  const svgBlob = createSvgBlob(svgMarkup);
  const objectUrl = createObjectUrl(svgBlob);

  try {
    const image = createImage();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = (error: unknown) => reject(error instanceof Error ? error : new Error('Impossible de charger le SVG à exporter'));
      image.src = objectUrl;
    });

    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Contexte canvas indisponible pour exporter le PNG');
    }
    context.drawImage(image as CanvasImageSource, 0, 0, width, height);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Impossible de générer le PNG')); 
          return;
        }
        resolve(blob);
      }, 'image/png');
    });
  } finally {
    revokeObjectUrl(objectUrl);
  }
}

export function shouldApplyRecettesGeographiquesRequestResult(latestRequestId: number, completedRequestId: number): boolean {
  return latestRequestId === completedRequestId;
}

export function shouldAutoLoadRecettesGeographiques(annee: string): boolean {
  return /^\d{4}$/.test(annee);
}

export function buildRecettesGeographiquesColorSteps(maxValue: number, steps = 5): number[] {
  if (!Number.isFinite(maxValue) || maxValue <= 0 || steps <= 0) return [];
  const thresholdStep = maxValue / steps;
  return Array.from({ length: steps }, (_, index) => Number(((index + 1) * thresholdStep).toFixed(2)));
}

export function resolveRecettesGeographiquesFillColor(value: number, thresholds: number[]): string {
  if (!Number.isFinite(value) || thresholds.length === 0) return '#dbeafe';
  const palette = ['#dbeafe', '#93c5fd', '#60a5fa', '#2563eb', '#1d4ed8'];
  const index = thresholds.findIndex((threshold) => value <= threshold);
  if (index === -1) return palette[palette.length - 1];
  return palette[Math.min(index, palette.length - 1)];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function collectGeometryPoints(geometry: RecettesGeographiquesSvgGeometry): Array<[number, number]> {
  if (geometry.type === 'Polygon') {
    return (geometry.coordinates as number[][][]).flatMap((ring) => ring.map((point) => [point[0], point[1]] as [number, number]));
  }
  return (geometry.coordinates as number[][][][]).flatMap((polygon) =>
    polygon.flatMap((ring) => ring.map((point) => [point[0], point[1]] as [number, number])),
  );
}

function computeBoundingBox(zones: RecettesGeographiquesSvgZone[]): BoundingBox {
  const points = zones.flatMap((zone) => collectGeometryPoints(zone.geometry));
  if (points.length === 0) {
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  }

  return points.reduce<BoundingBox>(
    (box, [x, y]) => ({
      minX: Math.min(box.minX, x),
      minY: Math.min(box.minY, y),
      maxX: Math.max(box.maxX, x),
      maxY: Math.max(box.maxY, y),
    }),
    { minX: points[0][0], minY: points[0][1], maxX: points[0][0], maxY: points[0][1] },
  );
}

function projectPoint(
  point: [number, number],
  bounds: BoundingBox,
  width: number,
  height: number,
  padding: number,
): [number, number] {
  const drawableWidth = Math.max(width - padding * 2, 1);
  const drawableHeight = Math.max(height - padding * 2, 1);
  const spanX = Math.max(bounds.maxX - bounds.minX, 1e-9);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1e-9);
  const scale = Math.min(drawableWidth / spanX, drawableHeight / spanY);
  const projectedWidth = spanX * scale;
  const projectedHeight = spanY * scale;
  const offsetX = padding + (drawableWidth - projectedWidth) / 2;
  const offsetY = padding + (drawableHeight - projectedHeight) / 2;
  const x = offsetX + (point[0] - bounds.minX) * scale;
  const y = offsetY + projectedHeight - (point[1] - bounds.minY) * scale;
  return [Number(x.toFixed(2)), Number(y.toFixed(2))];
}

function polygonToPath(
  polygon: number[][][],
  bounds: BoundingBox,
  width: number,
  height: number,
  padding: number,
): string {
  return polygon
    .map((ring) => {
      const commands = ring.map((point, index) => {
        const [x, y] = projectPoint([point[0], point[1]], bounds, width, height, padding);
        return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
      });
      return `${commands.join(' ')} Z`;
    })
    .join(' ');
}

function buildGeometryPath(
  geometry: RecettesGeographiquesSvgGeometry,
  bounds: BoundingBox,
  width: number,
  height: number,
  padding: number,
): string {
  if (geometry.type === 'Polygon') {
    return polygonToPath(geometry.coordinates as number[][][], bounds, width, height, padding);
  }
  return (geometry.coordinates as number[][][][])
    .map((polygon) => polygonToPath(polygon, bounds, width, height, padding))
    .join(' ');
}

export function buildRecettesGeographiquesSvgDocument(params: RecettesGeographiquesSvgDocumentParams): string {
  const bounds = computeBoundingBox(params.zones);
  const mapWidth = Math.max(params.width - 180, 220);
  const mapHeight = Math.max(params.height - 60, 180);
  const mapPadding = 20;
  const legendX = mapWidth + 24;
  const legendY = 56;
  const legendSteps = params.thresholds.length > 0 ? params.thresholds : [0];

  const zoneMarkup = params.zones
    .map((zone) => {
      const path = buildGeometryPath(zone.geometry, bounds, mapWidth, mapHeight, mapPadding);
      const isSelected = zone.zone_id === params.selectedZoneId;
      const stroke = isSelected ? '#1f2937' : '#ffffff';
      const strokeWidth = isSelected ? 3 : 1.5;
      return `<path d="${path}" fill="${zone.fillColor}" stroke="${stroke}" stroke-width="${strokeWidth}" data-zone-id="${zone.zone_id}" data-selected="${isSelected ? 'true' : 'false'}"><title>${escapeXml(`${zone.zone_label} (${zone.zone_code}) — ${zone.value}`)}</title></path>`;
    })
    .join('');

  const legendMarkup = legendSteps
    .map((threshold, index) => {
      const y = legendY + index * 24;
      const lowerBound = index > 0 ? legendSteps[index - 1] : null;
      const label = index === legendSteps.length - 1 && lowerBound !== null ? `>${lowerBound}` : `≤ ${threshold}`;
      const fill = resolveRecettesGeographiquesFillColor(threshold, params.thresholds);
      return `<rect x="${legendX}" y="${y}" width="18" height="18" rx="4" fill="${fill}" /><text x="${legendX + 28}" y="${y + 13}" font-size="12" fill="#1f2937">${escapeXml(label)}</text>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${params.width}" height="${params.height}" viewBox="0 0 ${params.width} ${params.height}" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(params.title)}</title>
  <desc id="desc">Carte choroplèthe des recettes TLPE par zone</desc>
  <rect x="0" y="0" width="${params.width}" height="${params.height}" fill="#f8fafc" rx="16" />
  <text x="24" y="30" font-size="18" font-weight="700" fill="#111827">${escapeXml(params.title)}</text>
  <g transform="translate(0, 20)">
    <rect x="16" y="20" width="${mapWidth}" height="${mapHeight}" rx="14" fill="#e2e8f0" />
    ${zoneMarkup}
  </g>
  <g>
    <text x="${legendX}" y="32" font-size="14" font-weight="700" fill="#111827">${escapeXml(params.legendLabel)}</text>
    ${legendMarkup}
  </g>
</svg>`;
}
