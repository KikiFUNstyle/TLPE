import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiBlobWithMetadata } from '../api';
import { useAuth } from '../auth';
import { buildAuditLogExportFilename, buildAuditLogPath, canExportAuditLog, defaultAuditLogFilters, shouldApplyAuditLogRequestResult, type AuditLogFiltersForm } from './auditLog';

type AuditLogRow = {
  id: number;
  created_at: string;
  user_id: number | null;
  user_email: string | null;
  user_display: string;
  action: string;
  entite: string;
  entite_id: number | null;
  details: string | null;
  ip: string | null;
};

type AuditLogOptionUser = {
  id: number;
  label: string;
  email: string;
};

type AuditLogPayload = {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  rows: AuditLogRow[];
  options: {
    users: AuditLogOptionUser[];
    actions: string[];
    entites: string[];
  };
};

function formatAuditTimestamp(value: string) {
  const date = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('fr-FR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  });
}

function formatDetails(details: string | null) {
  if (!details) return '—';
  try {
    return JSON.stringify(JSON.parse(details), null, 2);
  } catch {
    return details;
  }
}

export default function AuditLog() {
  const { user, hasRole } = useAuth();
  const canManage = hasRole('admin');
  const canExport = canExportAuditLog({ canManage });
  const [filters, setFilters] = useState<AuditLogFiltersForm>(() => defaultAuditLogFilters());
  const [appliedFilters, setAppliedFilters] = useState<AuditLogFiltersForm>(() => defaultAuditLogFilters());
  const [data, setData] = useState<AuditLogPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const requestIdRef = useRef(0);

  const load = async (nextFilters = appliedFilters, nextPage = page) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setErr(null);
    try {
      const payload = await api<AuditLogPayload>(buildAuditLogPath(nextFilters, { page: nextPage }));
      if (!shouldApplyAuditLogRequestResult(requestIdRef.current, requestId)) return;
      setData(payload);
      setInfo(`${payload.total} entrée(s) trouvée(s).`);
    } catch (error) {
      if (!shouldApplyAuditLogRequestResult(requestIdRef.current, requestId)) return;
      setErr((error as Error).message);
    } finally {
      if (shouldApplyAuditLogRequestResult(requestIdRef.current, requestId)) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!canManage) return;
    void load(appliedFilters, page);
  }, [canManage, appliedFilters, page]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const totalPages = data?.total_pages ?? 1;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setInfo(null);
    setPage(1);
    setAppliedFilters({ ...filters });
  };

  const resetFilters = () => {
    const next = defaultAuditLogFilters();
    setFilters(next);
    setAppliedFilters(next);
    setPage(1);
    setInfo(null);
    setErr(null);
  };

  const exportCsv = async () => {
    if (!canExport) return;
    setExporting(true);
    setErr(null);
    setInfo(null);
    try {
      const { blob, filename } = await apiBlobWithMetadata(buildAuditLogPath(appliedFilters, { page: 1, format: 'csv' }));
      const href = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = filename || buildAuditLogExportFilename(appliedFilters);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(href);
      setInfo('Export CSV du journal d’audit téléchargé.');
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setExporting(false);
    }
  };

  if (!canManage) {
    return <div className="empty">Le journal d’audit est réservé aux administrateurs.</div>;
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Journal d’audit</h1>
          <p>Consultation en lecture seule de la traçabilité complète des actions utilisateurs, avec filtres, recherche forensic et export CSV.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn secondary" type="button" disabled={!canExport || exporting} onClick={() => void exportCsv()}>
            {exporting ? 'Export CSV...' : 'Exporter CSV'}
          </button>
        </div>
      </div>

      <div className="alert warning">
        Journal immuable : cette interface est strictement en lecture seule. Aucune édition ni suppression n’est possible.
      </div>

      {err && <div className="alert error">{err}</div>}
      {info && <div className="alert success">{info}</div>}

      <form className="card form" onSubmit={onSubmit} style={{ marginBottom: 16 }}>
        <div className="form-row cols-3">
          <div>
            <label>Utilisateur</label>
            <select value={filters.user_id} onChange={(event) => setFilters((current) => ({ ...current, user_id: event.target.value }))}>
              <option value="">Tous les utilisateurs</option>
              {(data?.options.users ?? []).map((option) => (
                <option key={option.id} value={String(option.id)}>{option.label || option.email}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Entité</label>
            <select value={filters.entite} onChange={(event) => setFilters((current) => ({ ...current, entite: event.target.value }))}>
              <option value="">Toutes les entités</option>
              {(data?.options.entites ?? []).map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Action</label>
            <select value={filters.action} onChange={(event) => setFilters((current) => ({ ...current, action: event.target.value }))}>
              <option value="">Toutes les actions</option>
              {(data?.options.actions ?? []).map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="form-row cols-3">
          <div>
            <label>Date début</label>
            <input type="date" value={filters.date_debut} onChange={(event) => setFilters((current) => ({ ...current, date_debut: event.target.value }))} />
          </div>
          <div>
            <label>Date fin</label>
            <input type="date" value={filters.date_fin} onChange={(event) => setFilters((current) => ({ ...current, date_fin: event.target.value }))} />
          </div>
          <div>
            <label>Taille de page</label>
            <select
              value={String(filters.page_size)}
              onChange={(event) => {
                const pageSize = Number(event.target.value);
                setFilters((current) => ({ ...current, page_size: pageSize }));
                setAppliedFilters((current) => ({ ...current, page_size: pageSize }));
                setPage(1);
              }}
            >
              <option value="25">25 lignes</option>
              <option value="50">50 lignes</option>
              <option value="100">100 lignes</option>
            </select>
          </div>
        </div>

        <div>
          <label>Recherche plein texte</label>
          <input
            value={filters.q}
            onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))}
            placeholder="Ex. hash, numéro, email, IP, référence d’archive..."
          />
          <div className="hint">La recherche s’applique au détail JSON, à l’action, à l’entité et aux informations utilisateur.</div>
        </div>

        <div className="actions">
          <button className="btn secondary" type="button" onClick={resetFilters} disabled={loading}>Réinitialiser</button>
          <button className="btn" type="submit" disabled={loading}>{loading ? 'Chargement...' : 'Appliquer les filtres'}</button>
        </div>
      </form>

      <div className="card" style={{ padding: 0 }}>
        <div className="toolbar" style={{ padding: '16px 20px 0' }}>
          <strong>{data?.total ?? 0} entrée(s)</strong>
          <div className="spacer" />
          <span className="toolbar-hint">Utilisateur connecté : {user?.prenom} {user?.nom}</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Horodatage</th>
              <th>Utilisateur</th>
              <th>Action</th>
              <th>Entité</th>
              <th>Détails</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">Aucune entrée d’audit pour ces filtres.</td>
              </tr>
            ) : rows.map((row) => (
              <tr key={row.id}>
                <td>{formatAuditTimestamp(row.created_at)}</td>
                <td>
                  <strong>{row.user_display}</strong>
                  <div className="hint">{row.user_email ?? 'Compte système'}</div>
                </td>
                <td><code>{row.action}</code></td>
                <td>
                  <strong>{row.entite}</strong>
                  <div className="hint">ID {row.entite_id ?? '—'}</div>
                </td>
                <td>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 12 }}>{formatDetails(row.details)}</pre>
                </td>
                <td>{row.ip ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="toolbar" style={{ padding: '0 20px 16px' }}>
          <span className="toolbar-hint">Page {data?.page ?? 1} / {totalPages}</span>
          <div className="spacer" />
          <button className="btn secondary small" type="button" disabled={loading || page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
            Précédente
          </button>
          <button className="btn secondary small" type="button" disabled={loading || page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>
            Suivante
          </button>
        </div>
      </div>
    </>
  );
}
