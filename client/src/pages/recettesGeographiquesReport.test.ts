import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRecettesGeographiquesColorSteps,
  buildRecettesGeographiquesExportFilename,
  buildRecettesGeographiquesReportPath,
  buildRecettesGeographiquesSvgDocument,
  canExportRecettesGeographiques,
  defaultRecettesGeographiquesFilters,
  hasFreshRecettesGeographiquesData,
  renderRecettesGeographiquesPngBlob,
  resolveRecettesGeographiquesFillColor,
  shouldApplyRecettesGeographiquesRequestResult,
  shouldAutoLoadRecettesGeographiques,
} from './recettesGeographiquesReport';

test('defaultRecettesGeographiquesFilters initialise l\'année et l\'échelle de couleur par défaut', () => {
  assert.deepEqual(defaultRecettesGeographiquesFilters(2026), {
    annee: '2026',
    color_scale: 'montant_recouvre',
  });
});

test('canExportRecettesGeographiques exige une année valide et un rôle autorisé', () => {
  assert.equal(canExportRecettesGeographiques({ annee: '', canManage: true }), false);
  assert.equal(canExportRecettesGeographiques({ annee: '2026', canManage: false }), false);
  assert.equal(canExportRecettesGeographiques({ annee: '2026', canManage: true }), true);
});

test('buildRecettesGeographiquesReportPath construit la requête API attendue', () => {
  assert.equal(
    buildRecettesGeographiquesReportPath({ annee: '2026', color_scale: 'taux_recouvrement' }, 'pdf'),
    '/api/rapports/recettes-geographiques?annee=2026&color_scale=taux_recouvrement&format=pdf',
  );
});

test('buildRecettesGeographiquesExportFilename conserve l\'année et le format', () => {
  assert.equal(buildRecettesGeographiquesExportFilename('2026', 'pdf'), 'recettes-geographiques-2026.pdf');
  assert.equal(buildRecettesGeographiquesExportFilename('2026', 'png'), 'recettes-geographiques-2026.png');
});

test('shouldApplyRecettesGeographiquesRequestResult ignore les réponses obsolètes', () => {
  assert.equal(shouldApplyRecettesGeographiquesRequestResult(2, 1), false);
  assert.equal(shouldApplyRecettesGeographiquesRequestResult(2, 2), true);
});

test('hasFreshRecettesGeographiquesData détecte si les données affichées correspondent aux filtres actifs', () => {
  assert.equal(
    hasFreshRecettesGeographiquesData(
      { annee: '2026', color_scale: 'montant_recouvre' },
      { annee: 2026, color_scale: 'montant_recouvre' },
    ),
    true,
  );
  assert.equal(
    hasFreshRecettesGeographiquesData(
      { annee: '2026', color_scale: 'reste_a_recouvrer' },
      { annee: 2026, color_scale: 'montant_recouvre' },
    ),
    false,
  );
  assert.equal(
    hasFreshRecettesGeographiquesData(
      { annee: '2027', color_scale: 'montant_recouvre' },
      { annee: 2026, color_scale: 'montant_recouvre' },
    ),
    false,
  );
  assert.equal(hasFreshRecettesGeographiquesData({ annee: '2026', color_scale: 'montant_recouvre' }, null), false);
});

test('shouldAutoLoadRecettesGeographiques attend une année complète avant auto-chargement', () => {
  assert.equal(shouldAutoLoadRecettesGeographiques(''), false);
  assert.equal(shouldAutoLoadRecettesGeographiques('202'), false);
  assert.equal(shouldAutoLoadRecettesGeographiques('2026'), true);
  assert.equal(shouldAutoLoadRecettesGeographiques('20260'), false);
});

test('buildRecettesGeographiquesColorSteps calcule des seuils réguliers pour la légende', () => {
  assert.deepEqual(buildRecettesGeographiquesColorSteps(1000), [200, 400, 600, 800, 1000]);
  assert.deepEqual(buildRecettesGeographiquesColorSteps(0), []);
});

test('resolveRecettesGeographiquesFillColor mappe les seuils vers une palette croissante', () => {
  const thresholds = [200, 400, 600, 800, 1000];
  assert.equal(resolveRecettesGeographiquesFillColor(0, thresholds), '#dbeafe');
  assert.equal(resolveRecettesGeographiquesFillColor(350, thresholds), '#93c5fd');
  assert.equal(resolveRecettesGeographiquesFillColor(550, thresholds), '#60a5fa');
  assert.equal(resolveRecettesGeographiquesFillColor(750, thresholds), '#2563eb');
  assert.equal(resolveRecettesGeographiquesFillColor(1001, thresholds), '#1d4ed8');
});

test('buildRecettesGeographiquesSvgDocument produit un SVG avec les zones, la légende et la sélection active', () => {
  const svg = buildRecettesGeographiquesSvgDocument({
    width: 640,
    height: 320,
    title: 'Répartition géographique 2026',
    legendLabel: 'Montant recouvré',
    thresholds: [100, 200, 300, 400, 500],
    selectedZoneId: 2,
    zones: [
      {
        zone_id: 1,
        zone_code: 'ZC',
        zone_label: 'Zone Centre',
        value: 240,
        fillColor: '#60a5fa',
        geometry: {
          type: 'Polygon',
          coordinates: [[[2, 48], [3, 48], [3, 49], [2, 49], [2, 48]]],
        },
      },
      {
        zone_id: 2,
        zone_code: 'ZP',
        zone_label: 'Zone Périphérie',
        value: 420,
        fillColor: '#1d4ed8',
        geometry: {
          type: 'Polygon',
          coordinates: [[[3, 48], [4, 48], [4, 49], [3, 49], [3, 48]]],
        },
      },
    ],
  });

  assert.match(svg, /<svg[^>]+viewBox="0 0 640 320"/);
  assert.match(svg, /Répartition géographique 2026/);
  assert.match(svg, /Zone Centre \(ZC\)/);
  assert.match(svg, /Zone Périphérie \(ZP\)/);
  assert.match(svg, /data-selected="true"/);
  assert.match(svg, /Montant recouvré/);
  assert.match(svg, /≤ 100/);
  assert.match(svg, /&gt;400</);
});

test('renderRecettesGeographiquesPngBlob rasterise le SVG en PNG exploitable', async () => {
  let revokedUrl: string | null = null;
  let drawnSource: unknown = null;

  const image = {
    onload: null as (() => void) | null,
    onerror: null as ((error?: unknown) => void) | null,
    _src: '',
    set src(value: string) {
      this._src = value;
      this.onload?.();
    },
    get src() {
      return this._src;
    },
  };

  const blob = await renderRecettesGeographiquesPngBlob('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 320, 180, {
    createSvgBlob: (markup) => new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }),
    createObjectUrl: () => 'blob:test-recettes-geographiques',
    revokeObjectUrl: (url) => {
      revokedUrl = url;
    },
    createImage: () => image,
    createCanvas: (width, height) => ({
      width,
      height,
      getContext: () => ({
        drawImage: (source) => {
          drawnSource = source;
        },
      }),
      toBlob: (callback) => {
        callback(new Blob(['png-data'], { type: 'image/png' }));
      },
    }),
  });

  assert.equal(blob.type, 'image/png');
  assert.equal(revokedUrl, 'blob:test-recettes-geographiques');
  assert.equal(drawnSource, image);
});
