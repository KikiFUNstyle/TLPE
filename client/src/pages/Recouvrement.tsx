import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, apiBlobWithMetadata } from '../api';
import { formatEuro, formatPct } from '../format';
import { buildRecouvrementExportFilename, buildRecouvrementReportPath, canExportRecouvrement, defaultRecouvrementFilters, shouldApplyRecouvrementRequestResult, type RecouvrementExportFormat, type RecouvrementFiltersForm, type RecouvrementVentilation } from './recouvrementReport';

type ZoneOption = {
  id: number;
  libelle: string;
};

type RecouvrementRow = {
  key: string;
  label: string;
  montant_emis: number;
  montant_recouvre: number;
  reste_a_recouvrer: number;
  taux_recouvrement: number;
};

type RecouvrementPayload = {
  generatedAt: string;
  hash: string;
  titresCount: number;
  filters: {
    annee: number;
    zone: { id: number; label: string } | null;
    categorie: string | null;
    statut_paiement: string | null;
    ventilation: RecouvrementVentilation;
  };
  totals: {
    montant_emis: number;
    montant_recouvre: number;
    reste_a_recouvrer: number;
    taux_recouvrement: number;
  };
  breakdowns: {
    assujetti: RecouvrementRow[];
    zone: RecouvrementRow[];
    categorie: RecouvrementRow[];
  };
  chart: RecouvrementRow[];
};

const ventilationLabels: Record<RecouvrementVentilation, string> = {
  assujetti: 'Par assujetti',
  zone: 'Par zone',
  categorie: 'Par catégorie',
};

const categorieLabels: Record<string, string> = {
  enseigne: 'Enseigne',
  publicitaire: 'Publicitaire',
  preenseigne: 'Préenseigne',
};

const statutLabels: Array<{ value: string; label: string }> = [
  { value: '', label: 'Tous statuts' },
  { value: 'emis', label: 'Émis' },
  { value: 'paye_partiel', label: 'Payé partiel' },
  { value: 'paye', label: 'Payé' },
  { value: 'impaye', label: 'Impayé' },
  { value: 'mise_en_demeure', label: 'Mise en demeure' },
  { value: 'transmis_comptable', label: 'Transmis comptable' },
  { value: 'admis_en_non_valeur', label: 'Admis en non-valeur' },
];

const categorieOptions = [
  { value: '', label: 'Toutes catégories' },
  { value: 'enseigne', label: 'Enseigne' },
  { value: 'publicitaire', label: 'Publicitaire' },
  { value: 'preenseigne', label: 'Préenseigne' },
];

export default function Recouvrement() {
  const currentYear = new Date().getFullYear();
  const [filters, setFilters] = useState<RecouvrementFiltersForm>(() => defaultRecouvrementFilters(currentYear));
  const [zones, setZones] = useState<ZoneOption[]>([]);
  const [data, setData] = useState<RecouvrementPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState<RecouvrementExportFormat | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    api<ZoneOption[]>('/api/referentiels/zones')
      .then(setZones)
      .catch(() => undefined);
  }, []);

  const load = async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setErr(null);
    try {
      const payload = await api<RecouvrementPayload>(buildRecouvrementReportPath(filters));
      if (!shouldApplyRecouvrementRequestResult(requestIdRef.current, requestId)) {
        return;
      }
      setData(payload);
    } catch (error) {
      if (!shouldApplyRecouvrementRequestResult(requestIdRef.current, requestId)) {
        return;
      }
      setErr((error as Error).message);
    } finally {
      if (shouldApplyRecouvrementRequestResult(requestIdRef.current, requestId)) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void load();
  }, [filters.annee, filters.zone, filters.categorie, filters.statut_paiement, filters.ventilation]);

  const canExport = canExportRecouvrement({ annee: filters.annee, canManage: true });
  const visibleRows = useMemo(() => {
    if (!data) return [];
    return data.chart;
  }, [data]);

  const exportReport = async (format: RecouvrementExportFormat) => {
    if (!canExport) return;
    setExporting(format);
    setErr(null);
    setInfo(null);
    try {
      const { blob, filename } = await apiBlobWithMetadata(buildRecouvrementReportPath(filters, format));
      const href = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = filename || buildRecouvrementExportFilename(filters.annee, filters.ventilation, format);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(href);
      setInfo(`État de recouvrement ${format.toUpperCase()} téléchargé.`);
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setExporting(null);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void load();
  };

  return (
    <>
      <div className="page-header recouvrement-page-header">
        <div>
          <h1>État de recouvrement</h1>
          <p>Ventilation des montants émis, recouvrés et restants par assujetti, zone ou catégorie.</p>
        </div>
        <div className="recouvrement-export-actions">
          <button className="btn secondary" disabled={!canExport || exporting !== null} onClick={() => void exportReport('pdf')}>
            {exporting === 'pdf' ? 'Export PDF...' : 'Export PDF'}
          </button>
          <button className="btn secondary" disabled={!canExport || exporting !== null} onClick={() => void exportReport('xlsx')}>
            {exporting === 'xlsx' ? 'Export Excel...' : 'Export Excel'}
          </button>
        </div>
      </div>

      {err && <div className="alert error">{err}</div>}
      {info && <div className="alert success">{info}</div>}

      <form className="card form" onSubmit={onSubmit} style={{ marginBottom: 16 }}>
        <div className="form-row cols-3">
          <div>
            <label>Année</label>
            <input value={filters.annee} onChange={(event) => setFilters((prev) => ({ ...prev, annee: event.target.value }))} />
          </div>
          <div>
            <label>Zone</label>
            <select value={filters.zone} onChange={(event) => setFilters((prev) => ({ ...prev, zone: event.target.value }))}>
              <option value="">Toutes zones</option>
              {zones.map((zone) => (
                <option key={zone.id} value={String(zone.id)}>{zone.libelle}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Catégorie</label>
            <select value={filters.categorie} onChange={(event) => setFilters((prev) => ({ ...prev, categorie: event.target.value }))}>
              {categorieOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="form-row cols-3">
          <div>
            <label>Statut paiement</label>
            <select value={filters.statut_paiement} onChange={(event) => setFilters((prev) => ({ ...prev, statut_paiement: event.target.value }))}>
              {statutLabels.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Ventilation</label>
            <select value={filters.ventilation} onChange={(event) => setFilters((prev) => ({ ...prev, ventilation: event.target.value as RecouvrementVentilation }))}>
              {Object.entries(ventilationLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'end' }}>
            <button className="btn" type="submit" disabled={loading}>{loading ? 'Chargement...' : 'Actualiser'}</button>
          </div>
        </div>
      </form>

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

          <div className="grid cols-2">
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Graphique de recouvrement</h3>
              {visibleRows.length === 0 ? (
                <div className="empty">Aucune donnée pour ces filtres.</div>
              ) : (
                <div style={{ width: '100%', height: 320 }}>
                  <ResponsiveContainer>
                    <BarChart data={visibleRows} margin={{ top: 10, right: 20, left: 0, bottom: 50 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="label" angle={-20} textAnchor="end" interval={0} height={70} />
                      <YAxis />
                      <Tooltip formatter={(value: number) => formatEuro(value)} />
                      <Legend />
                      <Bar dataKey="montant_recouvre" stackId="a" name="Montant recouvré" fill="#18753c" />
                      <Bar dataKey="reste_a_recouvrer" stackId="a" name="Reste à recouvrer" fill="#b34000" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            <div className="card">
              <h3 style={{ marginTop: 0 }}>Filtres appliqués</h3>
              <dl className="calc-detail" style={{ marginTop: 12 }}>
                <dt>Année</dt>
                <dd>{data.filters.annee}</dd>
                <dt>Zone</dt>
                <dd>{data.filters.zone?.label || 'Toutes zones'}</dd>
                <dt>Catégorie</dt>
                <dd>{data.filters.categorie ? categorieLabels[data.filters.categorie] || data.filters.categorie : 'Toutes catégories'}</dd>
                <dt>Statut paiement</dt>
                <dd>{statutLabels.find((option) => option.value === (data.filters.statut_paiement || ''))?.label || 'Tous statuts'}</dd>
                <dt>Ventilation</dt>
                <dd>{ventilationLabels[data.filters.ventilation]}</dd>
                <dt>Horodatage</dt>
                <dd>{data.generatedAt}</dd>
              </dl>
            </div>
          </div>

          <div className="card" style={{ marginTop: 16, padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{ventilationLabels[data.filters.ventilation]}</th>
                  <th>Montant émis</th>
                  <th>Montant recouvré</th>
                  <th>Reste à recouvrer</th>
                  <th>Taux</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="empty">Aucune donnée pour ces filtres.</td>
                  </tr>
                ) : (
                  visibleRows.map((row) => (
                    <tr key={row.key}>
                      <td>{row.label}</td>
                      <td>{formatEuro(row.montant_emis)}</td>
                      <td>{formatEuro(row.montant_recouvre)}</td>
                      <td>{formatEuro(row.reste_a_recouvrer)}</td>
                      <td>{formatPct(row.taux_recouvrement)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
