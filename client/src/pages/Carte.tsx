import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleMarker, MapContainer, Popup, TileLayer } from 'react-leaflet';
import { api } from '../api';
import { buildGeoJson, getStatusStyle, mapStatusStyles, type DispositifMapItem } from './carteUtils';

interface ZoneRef { id: number; libelle: string }
interface TypeRef { id: number; libelle: string; categorie: string }

interface Filters {
  zone_id: string;
  type_id: string;
  annee: string;
}

const DEFAULT_CENTER: [number, number] = [46.603354, 1.888334];

function downloadGeoJson(content: string, fileName: string) {
  const blob = new Blob([content], { type: 'application/geo+json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Carte() {
  const [rows, setRows] = useState<DispositifMapItem[]>([]);
  const [zones, setZones] = useState<ZoneRef[]>([]);
  const [types, setTypes] = useState<TypeRef[]>([]);
  const [annees, setAnnees] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({ zone_id: '', type_id: '', annee: '' });

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      setErr(null);
      try {
        const params = new URLSearchParams();
        if (filters.zone_id) params.set('zone_id', filters.zone_id);
        if (filters.type_id) params.set('type_id', filters.type_id);
        if (filters.annee) params.set('annee', filters.annee);

        const [dispositifs, zonesRows, typesRows, anneesRows] = await Promise.all([
          api<DispositifMapItem[]>(`/api/dispositifs?${params}`),
          api<ZoneRef[]>('/api/referentiels/zones'),
          api<TypeRef[]>('/api/referentiels/types'),
          api<number[]>('/api/dispositifs/annees'),
        ]);

        if (cancelled) return;

        setRows(
          dispositifs.filter(
            (d) => typeof d.latitude === 'number' && typeof d.longitude === 'number' && Number.isFinite(d.latitude) && Number.isFinite(d.longitude),
          ),
        );
        setZones(zonesRows);
        setTypes(typesRows);
        setAnnees(anneesRows);
      } catch (error) {
        if (!cancelled) setErr((error as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [filters.zone_id, filters.type_id, filters.annee]);

  const center = useMemo<[number, number]>(() => {
    if (rows.length === 0) return DEFAULT_CENTER;
    const avgLat = rows.reduce((acc, row) => acc + Number(row.latitude), 0) / rows.length;
    const avgLon = rows.reduce((acc, row) => acc + Number(row.longitude), 0) / rows.length;
    return [avgLat, avgLon];
  }, [rows]);

  const geoJson = useMemo(() => buildGeoJson(rows), [rows]);

  const onFilterChange = (key: keyof Filters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Carte des dispositifs</h1>
          <p>Visualisation géographique des dispositifs avec filtres et export GeoJSON.</p>
        </div>
        <button
          className="btn secondary"
          onClick={() => {
            const suffix = [filters.zone_id || 'all-zones', filters.type_id || 'all-types', filters.annee || 'all-years'].join('-');
            downloadGeoJson(geoJson, `dispositifs-${suffix}.geojson`);
          }}
          disabled={rows.length === 0}
        >
          Export GeoJSON
        </button>
      </div>

      {err && <div className="alert error">{err}</div>}

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="toolbar">
          <label>
            Zone tarifaire
            <select value={filters.zone_id} onChange={(e) => onFilterChange('zone_id', e.target.value)}>
              <option value="">Toutes</option>
              {zones.map((z) => (
                <option key={z.id} value={String(z.id)}>
                  {z.libelle}
                </option>
              ))}
            </select>
          </label>
          <label>
            Type de dispositif
            <select value={filters.type_id} onChange={(e) => onFilterChange('type_id', e.target.value)}>
              <option value="">Tous</option>
              {types.map((t) => (
                <option key={t.id} value={String(t.id)}>
                  [{t.categorie}] {t.libelle}
                </option>
              ))}
            </select>
          </label>
          <label>
            Année de déclaration
            <select value={filters.annee} onChange={(e) => onFilterChange('annee', e.target.value)}>
              <option value="">Toutes</option>
              {annees.map((a) => (
                <option key={a} value={String(a)}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <div className="spacer" />
          <span style={{ color: 'var(--c-muted)', fontSize: 13 }}>{rows.length} point(s) affiché(s)</span>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {loading ? (
          <div className="empty">Chargement de la carte...</div>
        ) : rows.length === 0 ? (
          <div className="empty">Aucun dispositif géolocalisé pour ces filtres.</div>
        ) : (
          <MapContainer center={center} zoom={6} scrollWheelZoom style={{ height: 560, width: '100%' }}>
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {rows.map((d) => {
              const status = getStatusStyle(d.statut);
              return (
                <CircleMarker
                  key={d.id}
                  center={[Number(d.latitude), Number(d.longitude)]}
                  radius={8}
                  pathOptions={{
                    color: status.color,
                    fillColor: status.color,
                    fillOpacity: 0.8,
                    weight: 1,
                  }}
                >
                  <Popup>
                    <div style={{ minWidth: 220 }}>
                      <div style={{ fontWeight: 700 }}>{d.identifiant}</div>
                      <div style={{ marginBottom: 8 }}>
                        <span className="badge" style={{ backgroundColor: `${status.color}22`, color: status.color }}>
                          {status.label}
                        </span>
                      </div>
                      <div><strong>Type:</strong> {d.type_libelle}</div>
                      <div><strong>Zone:</strong> {d.zone_libelle ?? '-'}</div>
                      <div><strong>Assujetti:</strong> {d.assujetti_raison_sociale}</div>
                      <div><strong>Adresse:</strong> {[d.adresse_rue, d.adresse_cp, d.adresse_ville].filter(Boolean).join(', ') || '-'}</div>
                      <div style={{ marginTop: 8 }}>
                        <Link to={`/dispositifs?q=${encodeURIComponent(d.identifiant)}`}>Voir la fiche dispositif</Link>
                      </div>
                    </div>
                  </Popup>
                </CircleMarker>
              );
            })}
          </MapContainer>
        )}
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Légende des statuts</h3>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {Object.entries(mapStatusStyles).map(([key, value]) => (
            <div key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: 12,
                  height: 12,
                  borderRadius: 99,
                  background: value.color,
                }}
              />
              <span>{value.label}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
