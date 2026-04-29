import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { api, apiBlobWithMetadata } from '../api';
import { formatEuro, formatPct } from '../format';
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
  type RecettesGeographiquesExportFormat,
  type RecettesGeographiquesZoneColorScale,
} from './recettesGeographiquesReport';

type GeoJsonGeometry = {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: unknown;
};

type RecettesGeographiquesAssujetti = {
  assujetti_id: number;
  label: string;
  montant_emis: number;
  montant_recouvre: number;
  reste_a_recouvrer: number;
  titres_count: number;
};

type RecettesGeographiquesTitre = {
  titre_id: number;
  numero_titre: string;
  assujetti_id: number;
  assujetti_label: string;
  montant_emis: number;
  montant_recouvre: number;
  reste_a_recouvrer: number;
};

type RecettesGeographiquesZone = {
  zone_id: number;
  zone_code: string;
  zone_label: string;
  geometry: GeoJsonGeometry;
  montant_emis: number;
  montant_recouvre: number;
  reste_a_recouvrer: number;
  taux_recouvrement: number;
  assujettis_count: number;
  titres_count: number;
  assujettis: RecettesGeographiquesAssujetti[];
  titres: RecettesGeographiquesTitre[];
};

type RecettesGeographiquesPayload = {
  annee: number;
  color_scale: RecettesGeographiquesZoneColorScale;
  generatedAt: string;
  hash: string;
  totals: {
    montant_emis: number;
    montant_recouvre: number;
    reste_a_recouvrer: number;
    taux_recouvrement: number;
  };
  zones: RecettesGeographiquesZone[];
};

const colorScaleOptions: Array<{ value: RecettesGeographiquesZoneColorScale; label: string }> = [
  { value: 'montant_recouvre', label: 'Montant recouvré' },
  { value: 'taux_recouvrement', label: 'Taux de recouvrement' },
  { value: 'reste_a_recouvrer', label: 'Reste à recouvrer' },
];

const colorScaleLegendLabel: Record<RecettesGeographiquesZoneColorScale, string> = {
  montant_recouvre: 'Montant recouvré',
  taux_recouvrement: 'Taux de recouvrement',
  reste_a_recouvrer: 'Reste à recouvrer',
};

function zoneMetricValue(zone: RecettesGeographiquesZone, colorScale: RecettesGeographiquesZoneColorScale): number {
  if (colorScale === 'taux_recouvrement') return Number((zone.taux_recouvrement * 100).toFixed(2));
  if (colorScale === 'reste_a_recouvrer') return zone.reste_a_recouvrer;
  return zone.montant_recouvre;
}

function zoneMetricLabel(zone: RecettesGeographiquesZone, colorScale: RecettesGeographiquesZoneColorScale): string {
  if (colorScale === 'taux_recouvrement') return formatPct(zone.taux_recouvrement);
  if (colorScale === 'reste_a_recouvrer') return formatEuro(zone.reste_a_recouvrer);
  return formatEuro(zone.montant_recouvre);
}

export default function RecettesGeographiques() {
  const currentYear = new Date().getFullYear();
  const [filters, setFilters] = useState(() => defaultRecettesGeographiquesFilters(currentYear));
  const [data, setData] = useState<RecettesGeographiquesPayload | null>(null);
  const [selectedZoneId, setSelectedZoneId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState<RecettesGeographiquesExportFormat | null>(null);
  const requestIdRef = useRef(0);

  const load = async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setErr(null);
    try {
      const payload = await api<RecettesGeographiquesPayload>(buildRecettesGeographiquesReportPath(filters));
      if (!shouldApplyRecettesGeographiquesRequestResult(requestIdRef.current, requestId)) {
        return;
      }
      setData(payload);
      setSelectedZoneId((current) => (current && payload.zones.some((zone) => zone.zone_id === current) ? current : payload.zones[0]?.zone_id ?? null));
    } catch (error) {
      if (!shouldApplyRecettesGeographiquesRequestResult(requestIdRef.current, requestId)) {
        return;
      }
      setErr((error as Error).message);
    } finally {
      if (shouldApplyRecettesGeographiquesRequestResult(requestIdRef.current, requestId)) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!shouldAutoLoadRecettesGeographiques(filters.annee)) {
      return;
    }
    void load();
  }, [filters.annee, filters.color_scale]);

  const canExport = canExportRecettesGeographiques({ annee: filters.annee, canManage: true });
  const hasFreshData = hasFreshRecettesGeographiquesData(filters, data);

  const zoneValues = useMemo(() => {
    if (!data) return [];
    return data.zones.map((zone) => zoneMetricValue(zone, data.color_scale));
  }, [data]);

  const thresholds = useMemo(() => {
    const maxValue = zoneValues.reduce((max, value) => Math.max(max, value), 0);
    return buildRecettesGeographiquesColorSteps(maxValue);
  }, [zoneValues]);

  const zonesWithColors = useMemo(() => {
    if (!data) return [];
    return data.zones.map((zone) => ({
      ...zone,
      choroplethValue: zoneMetricValue(zone, data.color_scale),
      fillColor: resolveRecettesGeographiquesFillColor(zoneMetricValue(zone, data.color_scale), thresholds),
    }));
  }, [data, thresholds]);

  const selectedZone = useMemo(
    () => zonesWithColors.find((zone) => zone.zone_id === selectedZoneId) ?? zonesWithColors[0] ?? null,
    [selectedZoneId, zonesWithColors],
  );

  const svgMarkup = useMemo(() => {
    if (!data || zonesWithColors.length === 0) return null;
    return buildRecettesGeographiquesSvgDocument({
      width: 960,
      height: 520,
      title: `Carte choroplèthe TLPE ${data.annee}`,
      legendLabel: colorScaleLegendLabel[data.color_scale],
      thresholds,
      selectedZoneId,
      zones: zonesWithColors.map((zone) => ({
        zone_id: zone.zone_id,
        zone_code: zone.zone_code,
        zone_label: zone.zone_label,
        value: zone.choroplethValue,
        fillColor: zone.fillColor,
        geometry: zone.geometry,
      })),
    });
  }, [data, selectedZoneId, thresholds, zonesWithColors]);

  const canExportPng = canExport && hasFreshData && !loading && !!svgMarkup;

  const handleMapClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const zoneElement = target.closest('[data-zone-id]');
    if (!zoneElement) return;
    const zoneId = Number(zoneElement.getAttribute('data-zone-id'));
    if (Number.isFinite(zoneId)) {
      setSelectedZoneId(zoneId);
    }
  };

  const exportReport = async (format: RecettesGeographiquesExportFormat) => {
    if (!canExport) return;
    setExporting(format);
    setErr(null);
    setInfo(null);
    try {
      if (format === 'png') {
        if (!canExportPng || !svgMarkup) {
          throw new Error('Attendez le chargement des données correspondant aux filtres actifs avant d’exporter le PNG');
        }
        const blob = await renderRecettesGeographiquesPngBlob(svgMarkup, 960, 520);
        const href = window.URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.download = buildRecettesGeographiquesExportFilename(filters.annee, 'png');
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.URL.revokeObjectURL(href);
        setInfo('Carte des recettes PNG téléchargée.');
        return;
      }

      const { blob, filename } = await apiBlobWithMetadata(buildRecettesGeographiquesReportPath(filters, 'pdf'));
      const href = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = filename || buildRecettesGeographiquesExportFilename(filters.annee, 'pdf');
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(href);
      setInfo('Carte des recettes PDF téléchargée.');
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setExporting(null);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Carte des recettes</h1>
          <p>Visualisation choroplèthe des montants TLPE recouvrés, du taux de recouvrement et du reste à recouvrer par zone.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn secondary" disabled={!canExportPng || exporting !== null} onClick={() => void exportReport('png')}>
            {exporting === 'png' ? 'Export PNG...' : 'Export PNG'}
          </button>
          <button className="btn secondary" disabled={!canExport || exporting !== null} onClick={() => void exportReport('pdf')}>
            {exporting === 'pdf' ? 'Export PDF...' : 'Export PDF'}
          </button>
        </div>
      </div>

      {err && <div className="alert error">{err}</div>}
      {info && <div className="alert success">{info}</div>}

      <div className="card form" style={{ marginBottom: 16 }}>
        <div className="form-row cols-3">
          <div>
            <label>Année</label>
            <input value={filters.annee} onChange={(event) => setFilters((prev) => ({ ...prev, annee: event.target.value }))} />
          </div>
          <div>
            <label>Échelle de couleur</label>
            <select value={filters.color_scale} onChange={(event) => setFilters((prev) => ({ ...prev, color_scale: event.target.value as RecettesGeographiquesZoneColorScale }))}>
              {colorScaleOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'end' }}>
            <button className="btn" type="button" disabled={loading} onClick={() => void load()}>{loading ? 'Chargement...' : 'Actualiser'}</button>
          </div>
        </div>
      </div>

      {data && (
        <>
          <div className="grid cols-4" style={{ marginBottom: 16 }}>
            <div className="card kpi">
              <div className="label">Montant émis</div>
              <div className="value">{formatEuro(data.totals.montant_emis)}</div>
            </div>
            <div className="card kpi success">
              <div className="label">Montant recouvré</div>
              <div className="value">{formatEuro(data.totals.montant_recouvre)}</div>
            </div>
            <div className="card kpi warning">
              <div className="label">Reste à recouvrer</div>
              <div className="value">{formatEuro(data.totals.reste_a_recouvrer)}</div>
            </div>
            <div className="card kpi accent">
              <div className="label">Taux</div>
              <div className="value">{formatPct(data.totals.taux_recouvrement)}</div>
            </div>
          </div>

          <div className="grid cols-2" style={{ alignItems: 'start' }}>
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Carte choroplèthe</h3>
              {svgMarkup ? (
                <div
                  role="img"
                  aria-label={`Carte choroplèthe TLPE ${data.annee}`}
                  onClick={handleMapClick}
                  style={{ width: '100%', overflow: 'hidden', borderRadius: 12, background: '#f8fafc', cursor: 'pointer' }}
                  dangerouslySetInnerHTML={{ __html: svgMarkup }}
                />
              ) : (
                <div className="empty">Aucune zone disponible pour ces filtres.</div>
              )}
              {zonesWithColors.length > 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                  {zonesWithColors.map((zone) => (
                    <button
                      key={zone.zone_id}
                      type="button"
                      className="btn secondary"
                      style={{ borderColor: zone.zone_id === selectedZoneId ? '#1d4ed8' : undefined }}
                      onClick={() => setSelectedZoneId(zone.zone_id)}
                    >
                      {zone.zone_label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="card">
              <h3 style={{ marginTop: 0 }}>Détail de la zone sélectionnée</h3>
              {selectedZone ? (
                <>
                  <dl className="calc-detail" style={{ marginTop: 12 }}>
                    <dt>Zone</dt>
                    <dd>{selectedZone.zone_label} ({selectedZone.zone_code})</dd>
                    <dt>Échelle active</dt>
                    <dd>{colorScaleLegendLabel[data.color_scale]} : {zoneMetricLabel(selectedZone, data.color_scale)}</dd>
                    <dt>Montant émis</dt>
                    <dd>{formatEuro(selectedZone.montant_emis)}</dd>
                    <dt>Montant recouvré</dt>
                    <dd>{formatEuro(selectedZone.montant_recouvre)}</dd>
                    <dt>Reste à recouvrer</dt>
                    <dd>{formatEuro(selectedZone.reste_a_recouvrer)}</dd>
                    <dt>Taux de recouvrement</dt>
                    <dd>{formatPct(selectedZone.taux_recouvrement)}</dd>
                    <dt>Contribuables</dt>
                    <dd>{selectedZone.assujettis_count}</dd>
                    <dt>Titres</dt>
                    <dd>{selectedZone.titres_count}</dd>
                    <dt>Horodatage</dt>
                    <dd>{data.generatedAt}</dd>
                  </dl>

                  <div className="card" style={{ marginTop: 16, padding: 0 }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Contribuable</th>
                          <th>Montant recouvré</th>
                          <th>Titres</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedZone.assujettis.map((assujetti) => (
                          <tr key={assujetti.assujetti_id}>
                            <td>{assujetti.label}</td>
                            <td>{formatEuro(assujetti.montant_recouvre)}</td>
                            <td>{assujetti.titres_count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="card" style={{ marginTop: 16, padding: 0 }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Titre</th>
                          <th>Contribuable</th>
                          <th>Montant émis</th>
                          <th>Montant recouvré</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedZone.titres.map((titre) => (
                          <tr key={titre.titre_id}>
                            <td>{titre.numero_titre}</td>
                            <td>{titre.assujetti_label}</td>
                            <td>{formatEuro(titre.montant_emis)}</td>
                            <td>{formatEuro(titre.montant_recouvre)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="empty">Sélectionnez une zone pour afficher le détail.</div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
