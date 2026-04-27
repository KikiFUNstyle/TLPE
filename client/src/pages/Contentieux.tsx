import { Fragment, FormEvent, useEffect, useState } from 'react';
import { api, apiBlobWithMetadata } from '../api';
import { formatDate, formatEuro, toLocalDateInputValue } from '../format';
import { useAuth } from '../auth';

interface Contentieux {
  id: number;
  numero: string;
  type: string;
  statut: string;
  montant_litige: number | null;
  date_ouverture: string;
  date_cloture: string | null;
  description: string;
  decision: string | null;
  raison_sociale: string;
  assujetti_id: number;
  titre_id: number | null;
}

interface TimelineEvent {
  id: number;
  type: 'ouverture' | 'courrier' | 'statut' | 'decision' | 'jugement' | 'relance' | 'commentaire';
  date: string;
  auteur: string | null;
  description: string;
  piece_jointe_id: number | null;
  piece_jointe_nom?: string | null;
}

interface Assujetti {
  id: number;
  raison_sociale: string;
  identifiant_tlpe: string;
}

interface TimelineDraft {
  type: 'courrier' | 'statut' | 'decision' | 'jugement' | 'relance' | 'commentaire';
  date: string;
  auteur: string;
  description: string;
  piece_jointe_id: string;
}

const timelineTypeOptions: Array<{ value: TimelineDraft['type']; label: string }> = [
  { value: 'courrier', label: 'Courrier' },
  { value: 'statut', label: 'Statut' },
  { value: 'decision', label: 'Décision' },
  { value: 'jugement', label: 'Jugement' },
  { value: 'relance', label: 'Relance' },
  { value: 'commentaire', label: 'Commentaire' },
];

const timelineTypeLabels: Record<TimelineEvent['type'], string> = {
  ouverture: 'Ouverture',
  courrier: 'Courrier',
  statut: 'Statut',
  decision: 'Décision',
  jugement: 'Jugement',
  relance: 'Relance',
  commentaire: 'Commentaire',
};

const statusLabels: Record<string, string> = {
  ouvert: 'Ouvert',
  instruction: 'Instruction',
  clos_maintenu: 'Clos maintenu',
  degrevement_partiel: 'Dégrevement partiel',
  degrevement_total: 'Dégrevement total',
  non_lieu: 'Non-lieu',
};

const defaultDecisionStatus = 'instruction';

function todayInputValue() {
  return toLocalDateInputValue();
}

function normalizeStatusLabel(statut: string) {
  return statusLabels[statut] ?? statut.replace(/_/g, ' ');
}

function eventBadgeClass(type: TimelineEvent['type']) {
  if (type === 'decision') return 'success';
  if (type === 'courrier' || type === 'relance') return 'primary';
  if (type === 'statut') return 'info';
  if (type === 'jugement') return 'warn';
  return '';
}

function statusBadgeClass(statut: string) {
  if (statut.startsWith('degrevement')) return 'success';
  if (statut === 'non_lieu') return 'warn';
  if (statut === 'clos_maintenu') return 'primary';
  return 'info';
}

function sortTimeline(events: TimelineEvent[]) {
  return [...events].sort((left, right) => {
    if (left.date !== right.date) return left.date.localeCompare(right.date);
    return left.id - right.id;
  });
}

export function clearContentieuxActionState(currentId: number | null, completedContentieuxId: number): number | null {
  return currentId === completedContentieuxId ? null : currentId;
}

export function clearTimelineLoadingState(currentLoadingId: number | null, completedContentieuxId: number): number | null {
  return clearContentieuxActionState(currentLoadingId, completedContentieuxId);
}

export default function ContentieuxPage() {
  const { hasRole, user } = useAuth();
  const [rows, setRows] = useState<Contentieux[]>([]);
  const [timelines, setTimelines] = useState<Record<number, TimelineEvent[]>>({});
  const [openRowId, setOpenRowId] = useState<number | null>(null);
  const [loadingTimelineId, setLoadingTimelineId] = useState<number | null>(null);
  const [savingTimelineId, setSavingTimelineId] = useState<number | null>(null);
  const [downloadingTimelineId, setDownloadingTimelineId] = useState<number | null>(null);
  const [decisioningId, setDecisioningId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [decisionDrafts, setDecisionDrafts] = useState<Record<number, { statut: string; decision: string }>>({});
  const [timelineDrafts, setTimelineDrafts] = useState<Record<number, TimelineDraft>>({});

  const canCreate = hasRole('admin', 'gestionnaire') || (user?.role === 'contribuable' && user.assujetti_id);
  const canManage = hasRole('admin', 'gestionnaire', 'financier');

  const load = () => {
    api<Contentieux[]>('/api/contentieux')
      .then((data) => {
        setRows(data);
        setErr(null);
      })
      .catch((e) => setErr((e as Error).message));
  };
  useEffect(load, []);

  const ensureTimelineDraft = (contentieuxId: number) => {
    setTimelineDrafts((prev) => {
      if (prev[contentieuxId]) return prev;
      return {
        ...prev,
        [contentieuxId]: {
          type: 'courrier',
          date: todayInputValue(),
          auteur: '',
          description: '',
          piece_jointe_id: '',
        },
      };
    });
  };

  const ensureDecisionDraft = (contentieux: Contentieux) => {
    setDecisionDrafts((prev) => {
      if (prev[contentieux.id]) return prev;
      return {
        ...prev,
        [contentieux.id]: {
          statut: contentieux.statut === 'ouvert' ? defaultDecisionStatus : contentieux.statut,
          decision: contentieux.decision ?? '',
        },
      };
    });
  };

  const loadTimeline = async (contentieuxId: number) => {
    setLoadingTimelineId(contentieuxId);
    try {
      const events = await api<TimelineEvent[]>(`/api/contentieux/${contentieuxId}/timeline`);
      setTimelines((prev) => ({ ...prev, [contentieuxId]: sortTimeline(events) }));
      ensureTimelineDraft(contentieuxId);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoadingTimelineId((current) => clearTimelineLoadingState(current, contentieuxId));
    }
  };

  const toggleTimeline = async (contentieux: Contentieux) => {
    if (openRowId === contentieux.id) {
      setOpenRowId(null);
      return;
    }
    setOpenRowId(contentieux.id);
    ensureDecisionDraft(contentieux);
    if (!timelines[contentieux.id]) {
      await loadTimeline(contentieux.id);
    }
  };

  const updateDecisionDraft = (contentieuxId: number, patch: Partial<{ statut: string; decision: string }>) => {
    setDecisionDrafts((prev) => ({
      ...prev,
      [contentieuxId]: {
        statut: prev[contentieuxId]?.statut ?? defaultDecisionStatus,
        decision: prev[contentieuxId]?.decision ?? '',
        ...patch,
      },
    }));
  };

  const decide = async (contentieux: Contentieux) => {
    const draft = decisionDrafts[contentieux.id] ?? {
      statut: contentieux.statut === 'ouvert' ? defaultDecisionStatus : contentieux.statut,
      decision: contentieux.decision ?? '',
    };
    setDecisioningId(contentieux.id);
    try {
      await api(`/api/contentieux/${contentieux.id}/decider`, {
        method: 'POST',
        body: JSON.stringify({
          statut: draft.statut,
          decision: draft.decision.trim() ? draft.decision.trim() : null,
        }),
      });
      await Promise.all([load(), loadTimeline(contentieux.id)]);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDecisioningId((current) => clearContentieuxActionState(current, contentieux.id));
    }
  };

  const updateTimelineDraft = (contentieuxId: number, patch: Partial<TimelineDraft>) => {
    setTimelineDrafts((prev) => {
      const current: TimelineDraft = prev[contentieuxId] ?? {
        type: 'courrier',
        date: todayInputValue(),
        auteur: '',
        description: '',
        piece_jointe_id: '',
      };
      return {
        ...prev,
        [contentieuxId]: {
          ...current,
          ...patch,
        },
      };
    });
  };

  const submitTimelineEvent = async (contentieuxId: number) => {
    const draft = timelineDrafts[contentieuxId];
    if (!draft) return;
    setSavingTimelineId(contentieuxId);
    try {
      await api(`/api/contentieux/${contentieuxId}/evenements`, {
        method: 'POST',
        body: JSON.stringify({
          type: draft.type,
          date: draft.date,
          auteur: draft.auteur.trim() || null,
          description: draft.description,
          piece_jointe_id: draft.piece_jointe_id ? Number(draft.piece_jointe_id) : null,
        }),
      });
      setTimelineDrafts((prev) => ({
        ...prev,
        [contentieuxId]: {
          ...prev[contentieuxId],
          description: '',
          piece_jointe_id: '',
        },
      }));
      await loadTimeline(contentieuxId);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSavingTimelineId((current) => clearContentieuxActionState(current, contentieuxId));
    }
  };

  const downloadTimelinePdf = async (contentieux: Contentieux) => {
    setDownloadingTimelineId(contentieux.id);
    try {
      const { blob, filename } = await apiBlobWithMetadata(`/api/contentieux/${contentieux.id}/timeline/pdf`);
      const href = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = filename || `timeline-contentieux-${contentieux.numero}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(href);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDownloadingTimelineId(null);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Contentieux et reclamations</h1>
          <p>Suivi des dossiers gracieux, contentieux, moratoires et controles.</p>
        </div>
        {canCreate && <button className="btn" onClick={() => setShowModal(true)}>+ Nouvelle reclamation</button>}
      </div>

      {err && <div className="alert error">{err}</div>}

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Numero</th>
              <th>Type</th>
              <th>Assujetti</th>
              <th>Montant litige</th>
              <th>Ouverture</th>
              <th>Statut</th>
              <th>Description</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={8} className="empty">Aucun contentieux.</td></tr>
            ) : rows.map((contentieux) => {
              const isOpen = openRowId === contentieux.id;
              const timeline = timelines[contentieux.id] ?? [];
              const decisionDraft = decisionDrafts[contentieux.id] ?? {
                statut: contentieux.statut === 'ouvert' ? defaultDecisionStatus : contentieux.statut,
                decision: contentieux.decision ?? '',
              };
              const timelineDraft = timelineDrafts[contentieux.id] ?? {
                type: 'courrier',
                date: todayInputValue(),
                auteur: '',
                description: '',
                piece_jointe_id: '',
              };
              return (
                <Fragment key={contentieux.id}>
                  <tr>
                    <td>{contentieux.numero}</td>
                    <td>{contentieux.type}</td>
                    <td>{contentieux.raison_sociale}</td>
                    <td>{formatEuro(contentieux.montant_litige)}</td>
                    <td>{formatDate(contentieux.date_ouverture)}</td>
                    <td>
                      <span className={`badge ${statusBadgeClass(contentieux.statut)}`}>
                        {normalizeStatusLabel(contentieux.statut)}
                      </span>
                    </td>
                    <td style={{ fontSize: 12, maxWidth: 300 }}>{contentieux.description}</td>
                    <td>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        <button className="btn small secondary" onClick={() => { void toggleTimeline(contentieux); }}>
                          {isOpen ? 'Masquer timeline' : 'Voir timeline'}
                        </button>
                        <button
                          className="btn small secondary"
                          onClick={() => { void downloadTimelinePdf(contentieux); }}
                          disabled={downloadingTimelineId === contentieux.id}
                        >
                          {downloadingTimelineId === contentieux.id ? 'Export...' : 'Exporter PDF'}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr key={`${contentieux.id}-timeline`}>
                      <td colSpan={8} style={{ background: '#fbfcff' }}>
                        <div className="contentieux-detail">
                          <div className="contentieux-detail-grid">
                            <section className="card timeline-card">
                              <div className="timeline-header">
                                <div>
                                  <h3>Chronologie</h3>
                                  <p>{loadingTimelineId === contentieux.id ? 'Chargement des événements…' : `${timeline.length} événement(s)`}</p>
                                </div>
                              </div>
                              {timeline.length === 0 && loadingTimelineId !== contentieux.id ? (
                                <div className="empty" style={{ padding: '16px 0' }}>Aucun événement enregistré.</div>
                              ) : (
                                <div className="timeline-list">
                                  {timeline.map((event) => (
                                    <article key={event.id} className="timeline-item">
                                      <div className="timeline-item-marker" />
                                      <div className="timeline-item-body">
                                        <div className="timeline-item-topline">
                                          <span className={`badge ${eventBadgeClass(event.type)}`}>{timelineTypeLabels[event.type]}</span>
                                          <strong>{formatDate(event.date)}</strong>
                                          {event.auteur && <span className="timeline-muted">{event.auteur}</span>}
                                        </div>
                                        <p>{event.description}</p>
                                        {event.piece_jointe_nom && (
                                          <div className="timeline-muted">Pièce jointe liée : {event.piece_jointe_nom}</div>
                                        )}
                                      </div>
                                    </article>
                                  ))}
                                </div>
                              )}
                            </section>

                            <section className="contentieux-actions-stack">
                              {canManage && (
                                <div className="card">
                                  <h3 style={{ marginTop: 0 }}>Décision / statut</h3>
                                  <div className="form">
                                    <div>
                                      <label>Statut</label>
                                      <select
                                        value={decisionDraft.statut}
                                        onChange={(e) => updateDecisionDraft(contentieux.id, { statut: e.target.value })}
                                      >
                                        <option value="instruction">Instruction</option>
                                        <option value="clos_maintenu">Clos maintenu</option>
                                        <option value="degrevement_partiel">Dégrevement partiel</option>
                                        <option value="degrevement_total">Dégrevement total</option>
                                        <option value="non_lieu">Non-lieu</option>
                                      </select>
                                    </div>
                                    <div>
                                      <label>Décision / motivation</label>
                                      <textarea
                                        rows={4}
                                        value={decisionDraft.decision}
                                        onChange={(e) => updateDecisionDraft(contentieux.id, { decision: e.target.value })}
                                        placeholder="Motivation, synthèse ou décision rendue"
                                      />
                                    </div>
                                    <div className="actions">
                                      <button
                                        className="btn secondary"
                                        onClick={() => { void decide(contentieux); }}
                                        disabled={decisioningId === contentieux.id}
                                      >
                                        {decisioningId === contentieux.id ? 'Enregistrement...' : 'Enregistrer la décision'}
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              )}

                              {canManage && (
                                <div className="card">
                                  <h3 style={{ marginTop: 0 }}>Ajouter un événement</h3>
                                  <div className="form">
                                    <div className="form-row">
                                      <div>
                                        <label>Type d'événement</label>
                                        <select
                                          value={timelineDraft.type}
                                          onChange={(e) => updateTimelineDraft(contentieux.id, { type: e.target.value as TimelineDraft['type'] })}
                                        >
                                          {timelineTypeOptions.map((option) => (
                                            <option key={option.value} value={option.value}>{option.label}</option>
                                          ))}
                                        </select>
                                      </div>
                                      <div>
                                        <label>Date</label>
                                        <input
                                          type="date"
                                          value={timelineDraft.date}
                                          onChange={(e) => updateTimelineDraft(contentieux.id, { date: e.target.value })}
                                        />
                                      </div>
                                    </div>
                                    <div className="form-row">
                                      <div>
                                        <label>Auteur</label>
                                        <input
                                          value={timelineDraft.auteur}
                                          onChange={(e) => updateTimelineDraft(contentieux.id, { auteur: e.target.value })}
                                          placeholder="Service contentieux, avocat, juridiction..."
                                        />
                                      </div>
                                      <div>
                                        <label>ID pièce jointe (optionnel)</label>
                                        <input
                                          type="number"
                                          min="1"
                                          value={timelineDraft.piece_jointe_id}
                                          onChange={(e) => updateTimelineDraft(contentieux.id, { piece_jointe_id: e.target.value })}
                                          placeholder="Ex: 12"
                                        />
                                      </div>
                                    </div>
                                    <div>
                                      <label>Description</label>
                                      <textarea
                                        required
                                        rows={4}
                                        value={timelineDraft.description}
                                        onChange={(e) => updateTimelineDraft(contentieux.id, { description: e.target.value })}
                                        placeholder="Décrire l'événement saisi manuellement"
                                      />
                                    </div>
                                    <div className="actions">
                                      <button
                                        className="btn secondary"
                                        onClick={() => { void submitTimelineEvent(contentieux.id); }}
                                        disabled={savingTimelineId === contentieux.id || !timelineDraft.description.trim()}
                                      >
                                        {savingTimelineId === contentieux.id ? 'Ajout...' : 'Ajouter à la timeline'}
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </section>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {showModal && <CreationModal onClose={() => setShowModal(false)} onCreated={() => { setShowModal(false); load(); }} />}
    </>
  );
}

function CreationModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { user } = useAuth();
  const [assujettis, setAssujettis] = useState<Assujetti[]>([]);
  const [form, setForm] = useState({
    assujetti_id: user?.assujetti_id ?? 0,
    type: 'gracieux' as 'gracieux' | 'contentieux' | 'moratoire' | 'controle',
    montant_litige: '',
    description: '',
  });
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (user?.role !== 'contribuable') {
      api<Assujetti[]>('/api/assujettis').then((a) => {
        setAssujettis(a);
        if (a[0]) setForm((f) => ({ ...f, assujetti_id: a[0].id }));
      });
    }
  }, [user]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      await api('/api/contentieux', {
        method: 'POST',
        body: JSON.stringify({
          assujetti_id: form.assujetti_id,
          type: form.type,
          montant_litige: form.montant_litige ? Number(form.montant_litige) : null,
          description: form.description,
        }),
      });
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Nouvelle reclamation</h2>
        {err && <div className="alert error">{err}</div>}
        <form className="form" onSubmit={submit}>
          {user?.role !== 'contribuable' && (
            <div>
              <label>Assujetti</label>
              <select value={form.assujetti_id} onChange={(e) => setForm((f) => ({ ...f, assujetti_id: Number(e.target.value) }))}>
                {assujettis.map((a) => <option key={a.id} value={a.id}>{a.identifiant_tlpe} - {a.raison_sociale}</option>)}
              </select>
            </div>
          )}
          <div className="form-row">
            <div>
              <label>Type</label>
              <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as typeof f.type }))}>
                <option value="gracieux">Gracieux</option>
                <option value="contentieux">Contentieux</option>
                <option value="moratoire">Moratoire</option>
                <option value="controle">Controle</option>
              </select>
            </div>
            <div>
              <label>Montant en litige (EUR)</label>
              <input type="number" min="0" step="0.01" value={form.montant_litige} onChange={(e) => setForm((f) => ({ ...f, montant_litige: e.target.value }))} />
            </div>
          </div>
          <div>
            <label>Description / motifs *</label>
            <textarea required rows={4} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </div>
          <div className="actions">
            <button type="button" className="btn secondary" onClick={onClose}>Annuler</button>
            <button type="submit" className="btn" disabled={loading}>{loading ? '...' : 'Deposer'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
