import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiBlobWithMetadata } from '../api';
import { useAuth } from '../auth';
import { buildRelancesExportFilename, buildRelancesReportPath, canExportRelances, defaultRelancesFilters, shouldApplyRelancesRequestResult, type RelancesExportFormat, type RelancesFiltersForm, type RelancesReportStatus, type RelancesReportType } from './relancesReport';

type RelancesRow = {
  date: string;
  date_time: string;
  destinataire: string;
  type_code: RelancesReportType;
  type_label: string;
  canal: 'email' | 'courrier';
  statut: RelancesReportStatus;
  reponse_label: string;
};

type RelancesPayload = {
  generatedAt: string;
  hash: string;
  filters: {
    date_debut: string;
    date_fin: string;
    type: RelancesReportType | null;
    statut: RelancesReportStatus | null;
  };
  indicators: {
    total: number;
    envoyees: number;
    echecs: number;
    regularisees: number;
    taux_regularisation: number;
    canal_email: number;
    canal_courrier: number;
  };
  rows: RelancesRow[];
};

const typeOptions: Array<{ value: string; label: string }> = [
  { value: '', label: 'Tous types' },
  { value: 'relance_declaration', label: 'Relance déclaration' },
  { value: 'mise_en_demeure_declaration', label: 'Mise en demeure déclaration' },
  { value: 'relance_impaye', label: 'Relance impayé' },
  { value: 'mise_en_demeure_impaye', label: 'Mise en demeure impayé' },
];

const statutOptions: Array<{ value: string; label: string }> = [
  { value: '', label: 'Tous statuts' },
  { value: 'pending', label: 'En attente' },
  { value: 'envoye', label: 'Envoyé' },
  { value: 'echec', label: 'Échec' },
  { value: 'transmis', label: 'Transmis' },
  { value: 'classe', label: 'Classé' },
];

function formatRate(value: number) {
  return `${(value * 100).toFixed(1)} %`;
}

export default function Relances() {
  const { hasRole } = useAuth();
  const [filters, setFilters] = useState<RelancesFiltersForm>(() => defaultRelancesFilters());
  const [data, setData] = useState<RelancesPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState<RelancesExportFormat | null>(null);
  const requestIdRef = useRef(0);

  const canManage = hasRole('admin', 'gestionnaire');
  const canExport = canExportRelances({ dateDebut: filters.date_debut, dateFin: filters.date_fin, canManage });

  const load = async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setErr(null);
    try {
      const payload = await api<RelancesPayload>(buildRelancesReportPath(filters));
      if (!shouldApplyRelancesRequestResult(requestIdRef.current, requestId)) {
        return;
      }
      setData(payload);
    } catch (error) {
      if (!shouldApplyRelancesRequestResult(requestIdRef.current, requestId)) {
        return;
      }
      setErr((error as Error).message);
    } finally {
      if (shouldApplyRelancesRequestResult(requestIdRef.current, requestId)) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!canManage) return;
    void load();
  }, [canManage, filters.date_debut, filters.date_fin, filters.type, filters.statut]);

  const rows = useMemo(() => data?.rows ?? [], [data]);

  const exportReport = async (format: RelancesExportFormat) => {
    if (!canExport) return;
    setExporting(format);
    setErr(null);
    setInfo(null);
    try {
      const { blob, filename } = await apiBlobWithMetadata(buildRelancesReportPath(filters, format));
      const href = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = filename || buildRelancesExportFilename(filters.date_debut, filters.date_fin, format);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(href);
      setInfo(`Suivi des relances ${format.toUpperCase()} téléchargé.`);
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

  if (!canManage) {
    return <div className="alert warning">Le suivi des relances est réservé aux profils admin et gestionnaire.</div>;
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Suivi des relances</h1>
          <p>Mesure l’efficacité des rappels et mises en demeure pour préparer la phase contentieuse.</p>
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

      <form className="card form" onSubmit={onSubmit} style={{ marginBottom: 16 }}>
        <div className="form-row cols-3">
          <div>
            <label>Date début</label>
            <input type="date" value={filters.date_debut} onChange={(event) => setFilters((prev) => ({ ...prev, date_debut: event.target.value }))} />
          </div>
          <div>
            <label>Date fin</label>
            <input type="date" value={filters.date_fin} onChange={(event) => setFilters((prev) => ({ ...prev, date_fin: event.target.value }))} />
          </div>
          <div>
            <label>Type</label>
            <select value={filters.type} onChange={(event) => setFilters((prev) => ({ ...prev, type: event.target.value }))}>
              {typeOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="form-row cols-3">
          <div>
            <label>Statut</label>
            <select value={filters.statut} onChange={(event) => setFilters((prev) => ({ ...prev, statut: event.target.value }))}>
              {statutOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
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
              <div className="label">Envoyées</div>
              <div className="value">{data.indicators.envoyees}</div>
              <div className="meta">sur {data.indicators.total} action(s)</div>
            </div>
            <div className="card kpi success">
              <div className="label">Régularisées</div>
              <div className="value">{data.indicators.regularisees}</div>
              <div className="meta">taux {formatRate(data.indicators.taux_regularisation)}</div>
            </div>
            <div className="card kpi warning">
              <div className="label">Échecs</div>
              <div className="value">{data.indicators.echecs}</div>
              <div className="meta">canal email {data.indicators.canal_email}</div>
            </div>
            <div className="card kpi accent">
              <div className="label">Courriers</div>
              <div className="value">{data.indicators.canal_courrier}</div>
              <div className="meta">généré le {data.generatedAt}</div>
            </div>
          </div>

          <div className="grid cols-2" style={{ marginBottom: 16 }}>
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Filtres appliqués</h3>
              <dl className="calc-detail" style={{ marginTop: 12 }}>
                <dt>Date début</dt>
                <dd>{data.filters.date_debut}</dd>
                <dt>Date fin</dt>
                <dd>{data.filters.date_fin}</dd>
                <dt>Type</dt>
                <dd>{typeOptions.find((option) => option.value === (data.filters.type || ''))?.label || 'Tous types'}</dd>
                <dt>Statut</dt>
                <dd>{statutOptions.find((option) => option.value === (data.filters.statut || ''))?.label || 'Tous statuts'}</dd>
                <dt>Hash</dt>
                <dd><code>{data.hash}</code></dd>
              </dl>
            </div>
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Synthèse</h3>
              <dl className="calc-detail" style={{ marginTop: 12 }}>
                <dt>Total lignes</dt>
                <dd>{data.indicators.total}</dd>
                <dt>Envoyées</dt>
                <dd>{data.indicators.envoyees}</dd>
                <dt>Échecs</dt>
                <dd>{data.indicators.echecs}</dd>
                <dt>Taux de régularisation</dt>
                <dd>{formatRate(data.indicators.taux_regularisation)}</dd>
              </dl>
            </div>
          </div>

          <div className="card" style={{ padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Destinataire</th>
                  <th>Type</th>
                  <th>Canal</th>
                  <th>Statut</th>
                  <th>Réponse</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="empty">Aucune relance ou mise en demeure pour ces filtres.</td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr key={`${row.date_time}-${row.destinataire}-${row.type_code}`}>
                      <td>{row.date}</td>
                      <td>{row.destinataire}</td>
                      <td>{row.type_label}</td>
                      <td>{row.canal === 'email' ? 'Email' : 'Courrier'}</td>
                      <td>{statutOptions.find((option) => option.value === row.statut)?.label || row.statut}</td>
                      <td>{row.reponse_label}</td>
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
