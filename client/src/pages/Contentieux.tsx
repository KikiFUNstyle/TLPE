import { Fragment, FormEvent, useEffect, useState } from 'react';
import { api, apiBlob, apiBlobWithMetadata } from '../api';
import { formatDate, formatEuro, toLocalDateInputValue } from '../format';
import { useAuth, type Role, type User } from '../auth';
import { classifyContentieuxDeadline, describeContentieuxDeadline, type ContentieuxDeadlineSummary } from './contentieuxDeadlineUtils';

interface Contentieux extends ContentieuxDeadlineSummary {
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
  delai_prolonge_par: number | null;
  delai_prolonge_at: string | null;
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

type ContentieuxAttachmentType = 'courrier-admin' | 'courrier-contribuable' | 'decision' | 'jugement';

interface ContentieuxAttachment {
  id: number;
  nom: string;
  mime_type: string;
  taille: number;
  type_piece: ContentieuxAttachmentType | null;
  type_piece_label: string;
  created_at: string;
  auteur: string;
  auteur_role: string | null;
  access_mode: 'lecture-seule' | 'gestion';
  can_delete: boolean;
  download_url: string;
}

interface AttachmentUploadDraft {
  type_piece: ContentieuxAttachmentType;
  file: File | null;
}

interface DeadlineExtensionDraft {
  date_limite_reponse: string;
  justification: string;
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

const contentieuxAttachmentTypeOptions: Array<{ value: ContentieuxAttachmentType; label: string }> = [
  { value: 'courrier-admin', label: 'Courrier administration' },
  { value: 'courrier-contribuable', label: 'Courrier contribuable' },
  { value: 'decision', label: 'Décision' },
  { value: 'jugement', label: 'Jugement' },
];

export function attachmentTypeOptionsForRole(role: Role | undefined): Array<{ value: ContentieuxAttachmentType; label: string }> {
  if (role === 'contribuable') {
    return contentieuxAttachmentTypeOptions.filter((option) => option.value === 'courrier-contribuable');
  }
  return contentieuxAttachmentTypeOptions;
}

export function defaultAttachmentTypeForRole(role: Role | undefined): ContentieuxAttachmentType {
  return attachmentTypeOptionsForRole(role)[0]?.value ?? 'courrier-contribuable';
}

export function attachmentPreviewKind(mimeType: string): 'pdf' | 'image' | 'unsupported' {
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('image/')) return 'image';
  return 'unsupported';
}

export function canViewContentieuxAttachments(user: Pick<User, 'role'> | null | undefined): boolean {
  return Boolean(user && user.role !== 'financier');
}

export function canUploadContentieuxAttachments(user: Pick<User, 'role' | 'assujetti_id'> | null | undefined): boolean {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'gestionnaire') return true;
  return user.role === 'contribuable' && Boolean(user.assujetti_id);
}

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

function isDeadlineVisible(contentieux: Contentieux) {
  return Boolean(contentieux.date_limite_reponse);
}

function deadlineCellClass(contentieux: Contentieux) {
  return classifyContentieuxDeadline(contentieux);
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

export function clearAttachmentLoadingState(currentLoadingId: number | null, completedContentieuxId: number): number | null {
  return clearContentieuxActionState(currentLoadingId, completedContentieuxId);
}

export default function ContentieuxPage() {
  const { hasRole, user } = useAuth();
  const [rows, setRows] = useState<Contentieux[]>([]);
  const [timelines, setTimelines] = useState<Record<number, TimelineEvent[]>>({});
  const [attachments, setAttachments] = useState<Record<number, ContentieuxAttachment[]>>({});
  const [openRowId, setOpenRowId] = useState<number | null>(null);
  const [loadingTimelineId, setLoadingTimelineId] = useState<number | null>(null);
  const [loadingAttachmentsId, setLoadingAttachmentsId] = useState<number | null>(null);
  const [savingTimelineId, setSavingTimelineId] = useState<number | null>(null);
  const [uploadingAttachmentId, setUploadingAttachmentId] = useState<number | null>(null);
  const [downloadingTimelineId, setDownloadingTimelineId] = useState<number | null>(null);
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState<number | null>(null);
  const [previewingAttachmentId, setPreviewingAttachmentId] = useState<number | null>(null);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<Record<number, number | null>>({});
  const [attachmentPreviewUrl, setAttachmentPreviewUrl] = useState<string | null>(null);
  const [attachmentPreviewMimeType, setAttachmentPreviewMimeType] = useState<string | null>(null);
  const [attachmentPreviewError, setAttachmentPreviewError] = useState<string | null>(null);
  const [decisioningId, setDecisioningId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [decisionDrafts, setDecisionDrafts] = useState<Record<number, { statut: string; decision: string }>>({});
  const [timelineDrafts, setTimelineDrafts] = useState<Record<number, TimelineDraft>>({});
  const [attachmentDrafts, setAttachmentDrafts] = useState<Record<number, AttachmentUploadDraft>>({});
  const [deadlineDrafts, setDeadlineDrafts] = useState<Record<number, DeadlineExtensionDraft>>({});

  const canCreate = hasRole('admin', 'gestionnaire') || (user?.role === 'contribuable' && user.assujetti_id);
  const canManage = hasRole('admin', 'gestionnaire', 'financier');
  const canViewAttachments = canViewContentieuxAttachments(user);
  const canUploadAttachments = canUploadContentieuxAttachments(user);

  const load = () => {
    api<Contentieux[]>('/api/contentieux')
      .then((data) => {
        setRows(data);
        setErr(null);
      })
      .catch((e) => setErr((e as Error).message));
  };
  useEffect(load, []);

  useEffect(() => () => {
    if (attachmentPreviewUrl) {
      window.URL.revokeObjectURL(attachmentPreviewUrl);
    }
  }, [attachmentPreviewUrl]);

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

  const ensureAttachmentDraft = (contentieuxId: number) => {
    setAttachmentDrafts((prev) => {
      if (prev[contentieuxId]) return prev;
      return {
        ...prev,
        [contentieuxId]: {
          type_piece: defaultAttachmentTypeForRole(user?.role),
          file: null,
        },
      };
    });
  };

  const ensureDeadlineDraft = (contentieux: Contentieux) => {
    setDeadlineDrafts((prev) => {
      if (prev[contentieux.id]) return prev;
      return {
        ...prev,
        [contentieux.id]: {
          date_limite_reponse: contentieux.date_limite_reponse ?? '',
          justification: contentieux.delai_prolonge_justification ?? '',
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

  const loadAttachments = async (contentieuxId: number) => {
    if (!canViewAttachments) return;
    setLoadingAttachmentsId(contentieuxId);
    try {
      const rows = await api<ContentieuxAttachment[]>(`/api/contentieux/${contentieuxId}/pieces-jointes`);
      setAttachments((prev) => ({ ...prev, [contentieuxId]: rows }));
      setSelectedAttachmentIds((prev) => {
        const currentSelected = prev[contentieuxId];
        const stillExists = rows.some((row) => row.id === currentSelected);
        return {
          ...prev,
          [contentieuxId]: stillExists ? currentSelected ?? null : rows[0]?.id ?? null,
        };
      });
      ensureAttachmentDraft(contentieuxId);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoadingAttachmentsId((current) => clearAttachmentLoadingState(current, contentieuxId));
    }
  };

  const resetAttachmentPreview = () => {
    if (attachmentPreviewUrl) {
      window.URL.revokeObjectURL(attachmentPreviewUrl);
    }
    setAttachmentPreviewUrl(null);
    setAttachmentPreviewMimeType(null);
    setAttachmentPreviewError(null);
    setPreviewingAttachmentId(null);
  };

  const toggleTimeline = async (contentieux: Contentieux) => {
    if (openRowId === contentieux.id) {
      setOpenRowId(null);
      resetAttachmentPreview();
      return;
    }
    resetAttachmentPreview();
    setOpenRowId(contentieux.id);
    ensureDecisionDraft(contentieux);
    ensureDeadlineDraft(contentieux);
    ensureAttachmentDraft(contentieux.id);
    const loaders: Array<Promise<unknown>> = [];
    if (!timelines[contentieux.id]) {
      loaders.push(loadTimeline(contentieux.id));
    }
    if (canViewAttachments && !attachments[contentieux.id]) {
      loaders.push(loadAttachments(contentieux.id));
    }
    if (loaders.length > 0) {
      await Promise.all(loaders);
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
      await Promise.all([load(), loadTimeline(contentieux.id), loadAttachments(contentieux.id)]);
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

  const updateDeadlineDraft = (contentieuxId: number, patch: Partial<DeadlineExtensionDraft>) => {
    setDeadlineDrafts((prev) => ({
      ...prev,
      [contentieuxId]: {
        date_limite_reponse: prev[contentieuxId]?.date_limite_reponse ?? '',
        justification: prev[contentieuxId]?.justification ?? '',
        ...patch,
      },
    }));
  };

  const updateAttachmentDraft = (contentieuxId: number, patch: Partial<AttachmentUploadDraft>) => {
    setAttachmentDrafts((prev) => ({
      ...prev,
      [contentieuxId]: {
        type_piece: prev[contentieuxId]?.type_piece ?? defaultAttachmentTypeForRole(user?.role),
        file: prev[contentieuxId]?.file ?? null,
        ...patch,
      },
    }));
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
      await Promise.all([loadTimeline(contentieuxId), loadAttachments(contentieuxId)]);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSavingTimelineId((current) => clearContentieuxActionState(current, contentieuxId));
    }
  };

  const uploadAttachment = async (contentieuxId: number) => {
    const draft = attachmentDrafts[contentieuxId];
    if (!draft?.file) return;
    setUploadingAttachmentId(contentieuxId);
    try {
      const formData = new FormData();
      formData.set('entite', 'contentieux');
      formData.set('entite_id', String(contentieuxId));
      formData.set('type_piece', draft.type_piece);
      formData.set('fichier', draft.file);
      await api('/api/pieces-jointes', {
        method: 'POST',
        body: formData,
      });
      setAttachmentDrafts((prev) => ({
        ...prev,
        [contentieuxId]: {
          type_piece: defaultAttachmentTypeForRole(user?.role),
          file: null,
        },
      }));
      await loadAttachments(contentieuxId);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUploadingAttachmentId((current) => clearContentieuxActionState(current, contentieuxId));
    }
  };

  const previewAttachment = async (contentieuxId: number, attachment: ContentieuxAttachment) => {
    resetAttachmentPreview();
    setPreviewingAttachmentId(attachment.id);
    try {
      const blob = await apiBlob(attachment.download_url);
      const url = window.URL.createObjectURL(blob);
      setAttachmentPreviewUrl(url);
      setAttachmentPreviewMimeType(attachment.mime_type);
      setSelectedAttachmentIds((prev) => ({ ...prev, [contentieuxId]: attachment.id }));
      setErr(null);
    } catch (e) {
      setAttachmentPreviewError((e as Error).message);
    } finally {
      setPreviewingAttachmentId(null);
    }
  };

  const downloadAttachment = async (attachment: ContentieuxAttachment) => {
    setDownloadingAttachmentId(attachment.id);
    try {
      const blob = await apiBlob(attachment.download_url);
      const href = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = attachment.nom;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(href);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDownloadingAttachmentId(null);
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

  const submitDeadlineExtension = async (contentieux: Contentieux) => {
    const draft = deadlineDrafts[contentieux.id];
    if (!draft) return;
    setDecisioningId(contentieux.id);
    try {
      await api(`/api/contentieux/${contentieux.id}/prolonger-delai`, {
        method: 'POST',
        body: JSON.stringify({
          date_limite_reponse: draft.date_limite_reponse,
          justification: draft.justification,
        }),
      });
      await Promise.all([load(), loadTimeline(contentieux.id), loadAttachments(contentieux.id)]);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDecisioningId((current) => clearContentieuxActionState(current, contentieux.id));
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
              const attachmentDraft = attachmentDrafts[contentieux.id] ?? {
                type_piece: defaultAttachmentTypeForRole(user?.role),
                file: null,
              };
              const contentieuxAttachments = attachments[contentieux.id] ?? [];
              const selectedAttachmentId = selectedAttachmentIds[contentieux.id] ?? contentieuxAttachments[0]?.id ?? null;
              const selectedAttachment = contentieuxAttachments.find((attachment) => attachment.id === selectedAttachmentId) ?? null;
              const selectedAttachmentPreviewKind = selectedAttachment
                ? attachmentPreviewKind(selectedAttachment.mime_type)
                : 'unsupported';
              const deadlineDraft = deadlineDrafts[contentieux.id] ?? {
                date_limite_reponse: contentieux.date_limite_reponse ?? '',
                justification: contentieux.delai_prolonge_justification ?? '',
              };
              const deadlineSummary = isDeadlineVisible(contentieux)
                ? describeContentieuxDeadline(contentieux)
                : 'Aucune échéance renseignée';
              return (
                <Fragment key={contentieux.id}>
                  <tr className={contentieux.overdue ? 'table-row-danger' : undefined}>
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
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ fontSize: 12, maxWidth: 300 }}>{contentieux.description}</div>
                        {isDeadlineVisible(contentieux) && (
                          <span className={`badge ${deadlineCellClass(contentieux)}`}>{deadlineSummary}</span>
                        )}
                      </div>
                    </td>
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

                              {canViewAttachments && (
                                <div className="card">
                                  <h3 style={{ marginTop: 0 }}>Pièces jointes</h3>
                                  <div className="timeline-muted" style={{ marginBottom: 12 }}>
                                    {loadingAttachmentsId === contentieux.id
                                      ? 'Chargement des pièces jointes…'
                                      : `${contentieuxAttachments.length} pièce(s) jointe(s)`}
                                    {user?.role === 'contribuable' ? ' • les pièces administration restent en lecture seule' : ''}
                                  </div>

                                  {contentieuxAttachments.length === 0 && loadingAttachmentsId !== contentieux.id ? (
                                    <div className="empty" style={{ padding: '12px 0' }}>Aucune pièce jointe.</div>
                                  ) : (
                                    <div className="contentieux-attachments-list">
                                      {contentieuxAttachments.map((attachment) => (
                                        <button
                                          key={attachment.id}
                                          type="button"
                                          className={`contentieux-attachment-item${selectedAttachmentId === attachment.id ? ' active' : ''}`}
                                          onClick={() => {
                                            setSelectedAttachmentIds((prev) => ({ ...prev, [contentieux.id]: attachment.id }));
                                          }}
                                        >
                                          <strong>{attachment.type_piece_label}</strong>
                                          <span>{attachment.nom}</span>
                                          <span className="timeline-muted">
                                            {formatDate(attachment.created_at)} • {attachment.auteur}
                                          </span>
                                        </button>
                                      ))}
                                    </div>
                                  )}

                                  {selectedAttachment && (
                                    <div className="contentieux-attachment-preview">
                                      <div className="contentieux-attachment-toolbar">
                                        <div>
                                          <strong>{selectedAttachment.nom}</strong>
                                          <div className="timeline-muted">
                                            {selectedAttachment.type_piece_label} • {selectedAttachment.mime_type} • {selectedAttachment.auteur}
                                          </div>
                                        </div>
                                        <div className="contentieux-attachment-toolbar-actions">
                                          <button
                                            type="button"
                                            className="btn small secondary"
                                            onClick={() => { void previewAttachment(contentieux.id, selectedAttachment); }}
                                            disabled={previewingAttachmentId === selectedAttachment.id}
                                          >
                                            {previewingAttachmentId === selectedAttachment.id ? 'Prévisualisation...' : 'Aperçu'}
                                          </button>
                                          <button
                                            type="button"
                                            className="btn small secondary"
                                            onClick={() => { void downloadAttachment(selectedAttachment); }}
                                            disabled={downloadingAttachmentId === selectedAttachment.id}
                                          >
                                            {downloadingAttachmentId === selectedAttachment.id ? 'Téléchargement...' : 'Télécharger'}
                                          </button>
                                        </div>
                                      </div>

                                      {attachmentPreviewError && <div className="alert error">{attachmentPreviewError}</div>}
                                      {attachmentPreviewUrl && selectedAttachmentPreviewKind === 'pdf' && (
                                        <iframe title={`Aperçu ${selectedAttachment.nom}`} src={attachmentPreviewUrl} className="contentieux-attachment-frame" />
                                      )}
                                      {attachmentPreviewUrl && selectedAttachmentPreviewKind === 'image' && (
                                        <img src={attachmentPreviewUrl} alt={selectedAttachment.nom} className="contentieux-attachment-image" />
                                      )}
                                      {attachmentPreviewUrl && selectedAttachmentPreviewKind === 'unsupported' && (
                                        <div className="timeline-muted">Aperçu indisponible pour ce type de fichier. Utilisez le téléchargement.</div>
                                      )}
                                    </div>
                                  )}

                                  {canUploadAttachments && (
                                    <div className="form" style={{ marginTop: 16 }}>
                                      <div className="form-row">
                                        <div>
                                          <label>Catégorie</label>
                                          <select
                                            value={attachmentDraft.type_piece}
                                            onChange={(e) => updateAttachmentDraft(contentieux.id, { type_piece: e.target.value as ContentieuxAttachmentType })}
                                          >
                                            {attachmentTypeOptionsForRole(user?.role).map((option) => (
                                              <option key={option.value} value={option.value}>{option.label}</option>
                                            ))}
                                          </select>
                                        </div>
                                        <div>
                                          <label>Fichier (PDF, PNG, JPG)</label>
                                          <input
                                            type="file"
                                            accept="application/pdf,image/png,image/jpeg"
                                            onChange={(e) => updateAttachmentDraft(contentieux.id, { file: e.target.files?.[0] ?? null })}
                                          />
                                        </div>
                                      </div>
                                      <div className="timeline-muted">
                                        {attachmentDraft.file ? `Fichier prêt : ${attachmentDraft.file.name}` : 'Sélectionnez un document à verser au dossier.'}
                                      </div>
                                      <div className="actions">
                                        <button
                                          type="button"
                                          className="btn secondary"
                                          onClick={() => { void uploadAttachment(contentieux.id); }}
                                          disabled={uploadingAttachmentId === contentieux.id || !attachmentDraft.file}
                                        >
                                          {uploadingAttachmentId === contentieux.id ? 'Téléversement...' : 'Ajouter la pièce jointe'}
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}

                              {canManage && isDeadlineVisible(contentieux) && (
                                <div className="card">
                                  <h3 style={{ marginTop: 0 }}>Prolonger le délai légal</h3>
                                  <div className="form">
                                    <div className="timeline-muted" style={{ marginBottom: 8 }}>
                                      Échéance actuelle : {formatDate(contentieux.date_limite_reponse)}
                                      {contentieux.date_limite_reponse_initiale && contentieux.date_limite_reponse_initiale !== contentieux.date_limite_reponse
                                        ? ` • initiale ${formatDate(contentieux.date_limite_reponse_initiale)}`
                                        : ''}
                                      {contentieux.delai_prolonge_at ? ` • dernière prolongation ${formatDate(contentieux.delai_prolonge_at)}` : ''}
                                    </div>
                                    <div>
                                      <label>Nouvelle date limite</label>
                                      <input
                                        type="date"
                                        value={deadlineDraft.date_limite_reponse}
                                        onChange={(e) => updateDeadlineDraft(contentieux.id, { date_limite_reponse: e.target.value })}
                                      />
                                    </div>
                                    <div>
                                      <label>Justification</label>
                                      <textarea
                                        rows={3}
                                        value={deadlineDraft.justification}
                                        onChange={(e) => updateDeadlineDraft(contentieux.id, { justification: e.target.value })}
                                        placeholder="Expliquer la base légale ou le motif de prolongation"
                                      />
                                    </div>
                                    <div className="actions">
                                      <button
                                        className="btn secondary"
                                        onClick={() => { void submitDeadlineExtension(contentieux); }}
                                        disabled={
                                          decisioningId === contentieux.id ||
                                          !deadlineDraft.date_limite_reponse ||
                                          deadlineDraft.date_limite_reponse <= (contentieux.date_limite_reponse ?? '') ||
                                          deadlineDraft.justification.trim().length < 5
                                        }
                                      >
                                        {decisioningId === contentieux.id ? 'Prolongation...' : 'Enregistrer la prolongation'}
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
