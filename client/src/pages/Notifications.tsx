import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiBlobWithMetadata } from '../api';
import { useAuth } from '../auth';
import {
  buildNotificationsExportFilename,
  buildNotificationsPath,
  canExportNotifications,
  defaultNotificationsFilters,
  shouldApplyNotificationsRequestResult,
  type NotificationRow,
  type NotificationsFiltersForm,
} from './notificationsHelpers';

type NotificationsPayload = {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  rows: NotificationRow[];
  options: {
    statuses: { value: string; label: string }[];
    templates: string[];
  };
};

function formatTimestamp(value: string) {
  const date = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('fr-FR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  });
}

function formatMode(mode: string) {
  return mode === 'auto' ? 'Auto' : 'Manuel';
}

function buildContextLink(row: NotificationRow): { label: string; href: string } | null {
  if (row.template_code.startsWith('invitation') || row.template_code.startsWith('relance')) {
    const basePath = row.campagne_id ? `/relances?campagne_id=${row.campagne_id}` : '/relances';
    return { label: 'Voir la campagne', href: basePath };
  }
  if (
    row.template_code.startsWith('titre_') ||
    row.template_code.startsWith('paiement_') ||
    row.template_code.startsWith('decision_') ||
    row.template_code.startsWith('accuse_')
  ) {
    if (row.assujetti_id) {
      return { label: `Assujetti #${row.assujetti_id}`, href: `/assujettis/${row.assujetti_id}` };
    }
  }
  if (row.template_code.startsWith('contentieux_') || row.template_code.startsWith('alerte_')) {
    return { label: 'Contentieux', href: '/contentieux' };
  }
  return null;
}

export default function Notifications() {
  const { user, hasRole } = useAuth();
  const canManage = hasRole('admin') || hasRole('gestionnaire');
  const canExport = canExportNotifications({ canManage });
  const [filters, setFilters] = useState<NotificationsFiltersForm>(() => defaultNotificationsFilters());
  const [page, setPage] = useState(1);
  const [data, setData] = useState<NotificationsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [resending, setResending] = useState<number | null>(null);
  const requestIdRef = useRef(0);

  const fetchUrl = useMemo(
    () => buildNotificationsPath(filters, { page }),
    [filters, page],
  );

  useEffect(() => {
    let cancelled = false;
    const requestId = ++requestIdRef.current;
    setLoading(true);

    api<NotificationsPayload>(fetchUrl)
      .then((payload) => {
        if (cancelled) return;
        if (shouldApplyNotificationsRequestResult(requestId, requestIdRef.current)) {
          setData(payload);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error('Erreur chargement notifications:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [fetchUrl]);

  function handleSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
  }

  function handleReset() {
    setFilters(defaultNotificationsFilters());
    setPage(1);
  }

  function setFilter(key: keyof NotificationsFiltersForm, value: string | number) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  async function handleExportCsv() {
    setExporting(true);
    try {
      const url = buildNotificationsPath(filters, { format: 'csv' });
      const { blob, filename } = await apiBlobWithMetadata(url);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename ?? buildNotificationsExportFilename(filters);
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (err: unknown) {
      console.error('Erreur export CSV:', err);
      alert("Erreur lors de l'export CSV");
    } finally {
      setExporting(false);
    }
  }

  async function handleResend(id: number) {
    if (!confirm('Renvoyer cette notification ?')) return;
    setResending(id);
    try {
      await api(`/api/notifications/${id}/resend`, { method: 'POST' });
      setPage(1);
    } catch (err: unknown) {
      console.error('Erreur renvoi notification:', err);
      alert("Erreur lors du renvoi de la notification");
    } finally {
      setResending(null);
    }
  }

  const totalPages = data?.total_pages ?? 1;

  return (
    <div className="page">
      <h1>Historique des notifications</h1>

      <form className="filters" onSubmit={handleSearch}>
        <div className="filter-row">
          <div className="filter-group">
            <label htmlFor="notif-q">Recherche</label>
            <input
              id="notif-q"
              type="text"
              placeholder="Destinataire, sujet, assujetti…"
              value={filters.q}
              onChange={(e) => setFilter('q', e.target.value)}
            />
          </div>

          <div className="filter-group">
            <label htmlFor="notif-statut">Statut</label>
            <select
              id="notif-statut"
              value={filters.statut}
              onChange={(e) => setFilter('statut', e.target.value)}
            >
              <option value="">Tous</option>
              {data?.options.statuses.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="notif-email">Destinataire</label>
            <input
              id="notif-email"
              type="text"
              placeholder="Email"
              value={filters.email_destinataire}
              onChange={(e) => setFilter('email_destinataire', e.target.value)}
            />
          </div>

          <div className="filter-group">
            <label htmlFor="notif-template">Template</label>
            <select
              id="notif-template"
              value={filters.template_code}
              onChange={(e) => setFilter('template_code', e.target.value)}
            >
              <option value="">Tous</option>
              {data?.options.templates.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="notif-date-debut">Du</label>
            <input
              id="notif-date-debut"
              type="date"
              value={filters.date_debut}
              onChange={(e) => setFilter('date_debut', e.target.value)}
            />
          </div>

          <div className="filter-group">
            <label htmlFor="notif-date-fin">Au</label>
            <input
              id="notif-date-fin"
              type="date"
              value={filters.date_fin}
              onChange={(e) => setFilter('date_fin', e.target.value)}
            />
          </div>
        </div>

        <div className="filter-actions">
          <button type="submit" className="btn btn-primary">Rechercher</button>
          <button type="button" className="btn" onClick={handleReset}>Effacer</button>
          {canExport && (
            <button
              type="button"
              className="btn"
              onClick={handleExportCsv}
              disabled={exporting}
            >
              {exporting ? 'Export…' : 'Export CSV'}
            </button>
          )}
        </div>
      </form>

      {loading && <div className="loading">Chargement…</div>}

      {!loading && data && (
        <>
          <div className="table-info">
            {data.total} notification{data.total !== 1 ? 's' : ''}
          </div>

          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Destinataire</th>
                <th>Sujet</th>
                <th>Statut</th>
                <th>Template</th>
                <th>Mode</th>
                <th>Contexte</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty">Aucune notification trouvée</td>
                </tr>
              )}
              {data.rows.map((row) => {
                const contextLink = buildContextLink(row);
                return (
                  <tr key={row.id} className={row.statut === 'echec' ? 'row-error' : ''}>
                    <td className="cell-date" title={formatTimestamp(row.created_at)}>
                      {formatTimestamp(row.created_at)}
                    </td>
                    <td>{row.email_destinataire}</td>
                    <td className="cell-objet" title={row.objet}>
                      {row.objet.length > 60 ? `${row.objet.slice(0, 60)}…` : row.objet}
                    </td>
                    <td>
                      <span className={`badge badge-${row.statut}`}>
                        {row.statut_label}
                      </span>
                      {row.statut === 'echec' && row.erreur && (
                        <span className="error-detail" title={row.erreur}>⚠</span>
                      )}
                    </td>
                    <td className="cell-code">{row.template_code}</td>
                    <td>{formatMode(row.mode)}</td>
                    <td>
                      {contextLink ? (
                        <a href={contextLink.href}>{contextLink.label}</a>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {row.statut === 'echec' && (
                        <button
                          className="btn btn-sm"
                          onClick={() => handleResend(row.id)}
                          disabled={resending === row.id}
                        >
                          {resending === row.id ? '…' : 'Renvoyer'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div className="pagination">
              <button
                className="btn btn-sm"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                ← Précédent
              </button>
              <span className="page-info">
                Page {page} / {totalPages}
              </span>
              <button
                className="btn btn-sm"
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
              >
                Suivant →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
