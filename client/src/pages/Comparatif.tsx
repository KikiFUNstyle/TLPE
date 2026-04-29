import { useEffect, useMemo, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, apiBlobWithMetadata } from '../api';
import { formatEuro, formatPct } from '../format';
import {
  buildComparatifExportFilename,
  buildComparatifReportPath,
  canExportComparatif,
  defaultComparatifFilters,
  shouldApplyComparatifRequestResult,
  shouldAutoLoadComparatif,
  type ComparatifExportFormat,
  type ComparatifFiltersForm,
} from './comparatifReport';

type ComparatifSummaryRow = {
  annee: number;
  montant_emis: number;
  montant_recouvre: number;
  nombre_assujettis: number;
  nombre_dispositifs: number;
};

type ComparatifBreakdownValue = {
  annee: number;
  montant_emis: number;
  montant_recouvre: number;
};

type ComparatifBreakdownRow = {
  key: string;
  label: string;
  values: ComparatifBreakdownValue[];
};

type ComparatifEvolution = {
  montant_emis: number;
  montant_recouvre: number;
  nombre_assujettis: number;
  nombre_dispositifs: number;
};

type ComparatifPayload = {
  generatedAt: string;
  hash: string;
  filters: {
    annee: number;
    years: number[];
  };
  summary: ComparatifSummaryRow[];
  breakdowns: {
    zone: ComparatifBreakdownRow[];
    categorie: ComparatifBreakdownRow[];
  };
  evolutions: {
    vs_n1: ComparatifEvolution;
    vs_n2: ComparatifEvolution;
  };
};

const metricCards: Array<{ key: keyof ComparatifSummaryRow; label: string; type: 'currency' | 'count' }> = [
  { key: 'montant_emis', label: 'Montant émis', type: 'currency' },
  { key: 'montant_recouvre', label: 'Montant recouvré', type: 'currency' },
  { key: 'nombre_assujettis', label: 'Assujettis', type: 'count' },
  { key: 'nombre_dispositifs', label: 'Dispositifs', type: 'count' },
];

function formatMetric(value: number, type: 'currency' | 'count') {
  return type === 'currency' ? formatEuro(value) : String(value);
}

export default function Comparatif() {
  const currentYear = new Date().getFullYear();
  const [filters, setFilters] = useState<ComparatifFiltersForm>(() => defaultComparatifFilters(currentYear));
  const [data, setData] = useState<ComparatifPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState<ComparatifExportFormat | null>(null);
  const requestIdRef = useRef(0);

  const load = async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setErr(null);
    try {
      const payload = await api<ComparatifPayload>(buildComparatifReportPath(filters));
      if (!shouldApplyComparatifRequestResult(requestIdRef.current, requestId)) return;
      setData(payload);
    } catch (error) {
      if (!shouldApplyComparatifRequestResult(requestIdRef.current, requestId)) return;
      setErr((error as Error).message);
    } finally {
      if (shouldApplyComparatifRequestResult(requestIdRef.current, requestId)) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!shouldAutoLoadComparatif(filters.annee)) {
      return;
    }
    void load();
  }, [filters.annee]);

  const canExport = canExportComparatif({ annee: filters.annee, canManage: true });
  const chartData = useMemo(
    () => data?.summary.map((row) => ({
      annee: String(row.annee),
      montant_emis: row.montant_emis,
      montant_recouvre: row.montant_recouvre,
      nombre_assujettis: row.nombre_assujettis,
      nombre_dispositifs: row.nombre_dispositifs,
    })) ?? [],
    [data],
  );

  const exportReport = async (format: ComparatifExportFormat) => {
    if (!canExport) return;
    setExporting(format);
    setErr(null);
    setInfo(null);
    try {
      const { blob, filename } = await apiBlobWithMetadata(buildComparatifReportPath(filters, format));
      const href = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = filename || buildComparatifExportFilename(filters.annee, format);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(href);
      setInfo(`Comparatif pluriannuel ${format.toUpperCase()} téléchargé.`);
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
          <h1>Comparatif pluriannuel</h1>
          <p>Analyse des recettes TLPE sur N, N-1 et N-2 avec évolutions, ventilations et exports.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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

      <div className="card form" style={{ marginBottom: 16 }}>
        <div className="form-row cols-3">
          <div>
            <label>Année de référence</label>
            <input value={filters.annee} onChange={(event) => setFilters({ annee: event.target.value })} />
          </div>
          <div style={{ display: 'flex', alignItems: 'end' }}>
            <button className="btn" type="button" disabled={loading} onClick={() => void load()}>{loading ? 'Chargement...' : 'Actualiser'}</button>
          </div>
        </div>
      </div>

      {data && (
        <>
          <div className="grid cols-4" style={{ marginBottom: 16 }}>
            {metricCards.map((card) => (
              <div className="card kpi" key={card.key}>
                <div className="label">{card.label} N</div>
                <div className="value">{formatMetric(Number(data.summary[0][card.key]), card.type)}</div>
                <div className="meta">{data.filters.years.join(' / ')}</div>
              </div>
            ))}
          </div>

          <div className="grid cols-2" style={{ marginBottom: 16 }}>
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Vue d'ensemble</h3>
              {chartData.length === 0 ? (
                <div className="empty">Aucune donnée disponible.</div>
              ) : (
                <div style={{ width: '100%', height: 320 }}>
                  <ResponsiveContainer>
                    <BarChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="annee" />
                      <YAxis />
                      <Tooltip formatter={(value: number, name: string) => (name.includes('montant') ? formatEuro(value) : String(value))} />
                      <Legend />
                      <Bar dataKey="montant_emis" name="Montant émis" fill="#2952cc" />
                      <Bar dataKey="montant_recouvre" name="Montant recouvré" fill="#18753c" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            <div className="card">
              <h3 style={{ marginTop: 0 }}>Évolutions</h3>
              <dl className="calc-detail" style={{ marginTop: 12 }}>
                <dt>Montant émis vs N-1</dt>
                <dd>{formatPct(data.evolutions.vs_n1.montant_emis)}</dd>
                <dt>Montant recouvré vs N-1</dt>
                <dd>{formatPct(data.evolutions.vs_n1.montant_recouvre)}</dd>
                <dt>Dispositifs vs N-1</dt>
                <dd>{formatPct(data.evolutions.vs_n1.nombre_dispositifs)}</dd>
                <dt>Montant émis vs N-2</dt>
                <dd>{formatPct(data.evolutions.vs_n2.montant_emis)}</dd>
                <dt>Montant recouvré vs N-2</dt>
                <dd>{formatPct(data.evolutions.vs_n2.montant_recouvre)}</dd>
                <dt>Dispositifs vs N-2</dt>
                <dd>{formatPct(data.evolutions.vs_n2.nombre_dispositifs)}</dd>
                <dt>Horodatage</dt>
                <dd>{data.generatedAt}</dd>
              </dl>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16, padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Année</th>
                  <th>Montant émis</th>
                  <th>Montant recouvré</th>
                  <th>Assujettis</th>
                  <th>Dispositifs</th>
                </tr>
              </thead>
              <tbody>
                {data.summary.map((row) => (
                  <tr key={row.annee}>
                    <td>{row.annee}</td>
                    <td>{formatEuro(row.montant_emis)}</td>
                    <td>{formatEuro(row.montant_recouvre)}</td>
                    <td>{row.nombre_assujettis}</td>
                    <td>{row.nombre_dispositifs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid cols-2">
            <div className="card" style={{ padding: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th colSpan={4}>Ventilation par zone</th>
                  </tr>
                  <tr>
                    <th>Zone</th>
                    <th>Année</th>
                    <th>Montant émis</th>
                    <th>Montant recouvré</th>
                  </tr>
                </thead>
                <tbody>
                  {data.breakdowns.zone.flatMap((row) => row.values.map((value) => (
                    <tr key={`${row.key}-${value.annee}`}>
                      <td>{row.label}</td>
                      <td>{value.annee}</td>
                      <td>{formatEuro(value.montant_emis)}</td>
                      <td>{formatEuro(value.montant_recouvre)}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>

            <div className="card" style={{ padding: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th colSpan={4}>Ventilation par catégorie</th>
                  </tr>
                  <tr>
                    <th>Catégorie</th>
                    <th>Année</th>
                    <th>Montant émis</th>
                    <th>Montant recouvré</th>
                  </tr>
                </thead>
                <tbody>
                  {data.breakdowns.categorie.flatMap((row) => row.values.map((value) => (
                    <tr key={`${row.key}-${value.annee}`}>
                      <td>{row.label}</td>
                      <td>{value.annee}</td>
                      <td>{formatEuro(value.montant_emis)}</td>
                      <td>{formatEuro(value.montant_recouvre)}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
