import { FormEvent, useEffect, useState } from 'react';
import { api, apiBlob, apiBlobWithMetadata } from '../api';
import { formatDate, formatEuro } from '../format';
import { useAuth } from '../auth';
import { TitreRecouvrementHistory, type RecouvrementAction } from './TitreRecouvrementHistory';
import { buildBordereauFilename, buildBordereauPath, canExportBordereau } from './titresBordereau';
import {
  canGenerateMiseEnDemeure,
  getBatchEligibleTitreIds,
  getMiseEnDemeureActionLabel,
} from './titresMiseEnDemeure';
import { parsePayfipConfirmationSearch } from './payfip';
import { PayfipConfirmationView } from './PayfipConfirmation';
import {
  TITRE_STATUS_OPTIONS,
  canAdmettreNonValeur,
  canRendreExecutoire,
  canViewRecouvrementHistory,
  getTitreStatusBadgeVariant,
  getTitreStatusLabel,
} from './titreStatut';

interface Titre {
  id: number;
  numero: string;
  annee: number;
  raison_sociale: string;
  identifiant_tlpe: string;
  montant: number;
  montant_paye: number;
  date_emission: string;
  date_echeance: string;
  statut: string;
}

interface CampagneOption {
  id: number;
  annee: number;
  statut: string;
}

interface TitreHistoriqueResponse {
  titre: Titre;
  actions: RecouvrementAction[];
}

export default function Titres() {
  const { hasRole } = useAuth();
  const [rows, setRows] = useState<Titre[]>([]);
  const [campagnes, setCampagnes] = useState<CampagneOption[]>([]);
  const [pesv2SelectionMode, setPesv2SelectionMode] = useState<'campagne' | 'periode'>('campagne');
  const [selectedCampagneId, setSelectedCampagneId] = useState<string>('');
  const [pesv2DateDebut, setPesv2DateDebut] = useState<string>('');
  const [pesv2DateFin, setPesv2DateFin] = useState<string>('');
  const [annee, setAnnee] = useState<string>('');
  const [statut, setStatut] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [exporting, setExporting] = useState<null | 'pdf' | 'xlsx' | 'pesv2' | 'mise-en-demeure-batch'>(null);
  const [downloadingMiseEnDemeureId, setDownloadingMiseEnDemeureId] = useState<number | null>(null);
  const [paiementFor, setPaiementFor] = useState<Titre | null>(null);
  const [historyFor, setHistoryFor] = useState<Titre | null>(null);
  const [historyData, setHistoryData] = useState<TitreHistoriqueResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [payfipConfirmation, setPayfipConfirmation] = useState<ReturnType<typeof parsePayfipConfirmationSearch> | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const parsed = parsePayfipConfirmationSearch(window.location.search);
    if (window.location.pathname === '/titres' && parsed.statut !== 'unknown') {
      setPayfipConfirmation(parsed);
      return;
    }
    setPayfipConfirmation(null);
  }, []);

  const load = () => {
    const params = new URLSearchParams();
    if (annee) params.set('annee', annee);
    if (statut) params.set('statut', statut);
    api<Titre[]>(`/api/titres?${params}`)
      .then((data) => {
        setRows(data);
        setErr(null);
      })
      .catch((e) => setErr((e as Error).message));
  };
  useEffect(load, [annee, statut]);

  useEffect(() => {
    if (!canManageTitres) return;
    api<CampagneOption[]>('/api/campagnes')
      .then((data) => {
        setCampagnes(data);
        const cloturee = data.find((campagne) => campagne.statut === 'cloturee');
        if (cloturee) {
          setSelectedCampagneId(String(cloturee.id));
        }
      })
      .catch(() => undefined);
  }, []);

  const canManageTitres = hasRole('admin', 'financier');
  const selectedMiseEnDemeureTitreIds = getBatchEligibleTitreIds(rows, canManageTitres);
  const canRunMiseEnDemeureBatch = canManageTitres && exporting === null && selectedMiseEnDemeureTitreIds.length > 0;
  const canExport = canExportBordereau({ annee, canManage: canManageTitres });
  const canExportPesv2 =
    canManageTitres &&
    exporting === null &&
    ((pesv2SelectionMode === 'campagne' && selectedCampagneId.length > 0) ||
      (pesv2SelectionMode === 'periode' && pesv2DateDebut.length > 0 && pesv2DateFin.length > 0));

  const downloadBordereau = async (format: 'pdf' | 'xlsx') => {
    if (!canExport) return;
    setExporting(format);
    setErr(null);
    setInfo(null);
    try {
      const blob = await apiBlob(buildBordereauPath(annee, format));
      const href = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = buildBordereauFilename(annee, format);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(href);
      setInfo(`Bordereau ${format.toUpperCase()} téléchargé.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setExporting(null);
    }
  };

  const downloadPesv2 = async () => {
    if (!canExportPesv2) return;
    setExporting('pesv2');
    setErr(null);
    setInfo(null);

    const executePesv2Export = async (confirmReexport: boolean) => {
      const payload =
        pesv2SelectionMode === 'campagne'
          ? { campagne_id: Number(selectedCampagneId), confirm_reexport: confirmReexport }
          : { date_debut: pesv2DateDebut, date_fin: pesv2DateFin, confirm_reexport: confirmReexport };

      const { blob, filename } = await apiBlobWithMetadata('/api/titres/export-pesv2', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const href = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download =
        filename ||
        (pesv2SelectionMode === 'campagne'
          ? `pesv2-campagne-${selectedCampagneId}.xml`
          : `pesv2-${pesv2DateDebut}-${pesv2DateFin}.xml`);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(href);
    };

    try {
      await executePesv2Export(false);
      setInfo('Export PESV2 téléchargé.');
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes('Confirmation requise')) {
        const confirmed = window.confirm(
          'Certains titres ont déjà été exportés. Voulez-vous confirmer le réexport PESV2 ?',
        );
        if (confirmed) {
          try {
            await executePesv2Export(true);
            setInfo('Réexport PESV2 téléchargé.');
            return;
          } catch (retryError) {
            setErr((retryError as Error).message);
            return;
          }
        }
      }
      setErr(message);
    } finally {
      setExporting(null);
    }
  };

  const downloadMiseEnDemeure = async (titre: Titre) => {
    if (!canGenerateMiseEnDemeure(titre, canManageTitres)) return;
    setDownloadingMiseEnDemeureId(titre.id);
    setErr(null);
    setInfo(null);
    try {
      const payload = await api<{
        numero: string;
        download_url: string;
      }>(`/api/titres/${titre.id}/mise-en-demeure`, {
        method: 'POST',
      });
      const blob = await apiBlob(payload.download_url);
      const href = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = `${payload.numero}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(href);
      setInfo(`Mise en demeure ${payload.numero} téléchargée.`);
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDownloadingMiseEnDemeureId(null);
    }
  };

  const runMiseEnDemeureBatch = async () => {
    if (!canRunMiseEnDemeureBatch) return;
    setExporting('mise-en-demeure-batch');
    setErr(null);
    setInfo(null);
    try {
      const payload = await api<{
        count: number;
        items: Array<{ numero: string }>;
      }>('/api/titres/mises-en-demeure/batch', {
        method: 'POST',
        body: JSON.stringify({ titre_ids: selectedMiseEnDemeureTitreIds }),
      });
      setInfo(`Lot de ${payload.count} mises en demeure généré (${payload.items.map((item) => item.numero).join(', ')}).`);
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setExporting(null);
    }
  };

  const initiatePayfipPayment = async (titre: Titre) => {
    setErr(null);
    setInfo(null);
    try {
      const payload = await api<{
        redirect_url: string;
        reference: string;
        montant: number;
        numero_titre: string;
      }>(`/api/titres/${titre.id}/payfip/initiate`, {
        method: 'POST',
      });
      setInfo(`Redirection PayFip préparée pour le titre ${payload.numero_titre} (${formatEuro(payload.montant)}).`);
      window.location.href = payload.redirect_url;
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const openHistory = async (titre: Titre) => {
    setHistoryFor(titre);
    setHistoryData(null);
    setHistoryLoading(true);
    setErr(null);
    try {
      const payload = await api<TitreHistoriqueResponse>(`/api/titres/${titre.id}/historique`);
      setHistoryData(payload);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setHistoryLoading(false);
    }
  };

  const refreshHistoryIfOpen = async (titre: Titre) => {
    if (historyFor?.id !== titre.id) return;
    try {
      const payload = await api<TitreHistoriqueResponse>(`/api/titres/${titre.id}/historique`);
      setHistoryData(payload);
      setHistoryFor(payload.titre);
    } catch {
      // noop: l'erreur principale est déjà affichée via l'action initiatrice
    }
  };

  const downloadTitreExecutoire = async (titre: Titre) => {
    setErr(null);
    setInfo(null);
    try {
      const { blob, filename } = await apiBlobWithMetadata(`/api/titres/${titre.id}/rendre-executoire`, {
        method: 'POST',
      });
      const href = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = filename || `titre-executoire-${titre.numero}.xml`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(href);
      setInfo(`Titre ${titre.numero} transmis au comptable public.`);
      load();
      await refreshHistoryIfOpen(titre);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const markAdmisNonValeur = async (titre: Titre) => {
    const commentaire = window.prompt(
      'Commentaire de retour comptable (admission en non-valeur) :',
      'Retour comptable negatif - creance irrecouvrable',
    );
    if (commentaire === null) return;

    setErr(null);
    setInfo(null);
    try {
      await api(`/api/titres/${titre.id}/admettre-non-valeur`, {
        method: 'POST',
        body: JSON.stringify({ commentaire }),
      });
      setInfo(`Titre ${titre.numero} admis en non-valeur.`);
      load();
      await refreshHistoryIfOpen(titre);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Titres de recettes</h1>
          <p>Titres emis, paiements et etat de recouvrement.</p>
        </div>
      </div>

      {err && <div className="alert error">{err}</div>}
      {payfipConfirmation && <PayfipConfirmationView confirmation={payfipConfirmation} />}
      {info && <div className="alert info">{info}</div>}

      <div className="toolbar">
        <select value={annee} onChange={(e) => setAnnee(e.target.value)}>
          <option value="">Toutes annees</option>
          <option>{new Date().getFullYear() - 1}</option>
          <option>{new Date().getFullYear()}</option>
        </select>
        <select value={statut} onChange={(e) => setStatut(e.target.value)}>
          {TITRE_STATUS_OPTIONS.map((option) => (
            <option key={option.value || 'all'} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <div className="spacer" />
        {canManageTitres && (
          <>
            <button
              className="btn secondary"
              disabled={!canExport || exporting !== null}
              onClick={() => {
                void downloadBordereau('pdf');
              }}
              title={canExport ? 'Exporter le bordereau PDF' : 'Sélectionner une année pour exporter le bordereau'}
            >
              {exporting === 'pdf' ? 'Export PDF...' : 'Bordereau PDF'}
            </button>
            <button
              className="btn secondary"
              disabled={!canExport || exporting !== null}
              onClick={() => {
                void downloadBordereau('xlsx');
              }}
              title={canExport ? 'Exporter le bordereau Excel' : 'Sélectionner une année pour exporter le bordereau'}
            >
              {exporting === 'xlsx' ? 'Export Excel...' : 'Bordereau Excel'}
            </button>
            <select value={pesv2SelectionMode} onChange={(e) => setPesv2SelectionMode(e.target.value as 'campagne' | 'periode')} title="Mode de sélection PESV2">
              <option value="campagne">PESV2 par campagne</option>
              <option value="periode">PESV2 par période</option>
            </select>
            {pesv2SelectionMode === 'campagne' ? (
              <select value={selectedCampagneId} onChange={(e) => setSelectedCampagneId(e.target.value)} title="Campagne clôturée à exporter en PESV2">
                <option value="">Campagne PESV2</option>
                {campagnes
                  .filter((campagne) => campagne.statut === 'cloturee')
                  .map((campagne) => (
                    <option key={campagne.id} value={campagne.id}>
                      {campagne.annee} · {campagne.statut}
                    </option>
                  ))}
              </select>
            ) : (
              <>
                <input type="date" value={pesv2DateDebut} onChange={(e) => setPesv2DateDebut(e.target.value)} title="Date début émission PESV2" />
                <input type="date" value={pesv2DateFin} onChange={(e) => setPesv2DateFin(e.target.value)} title="Date fin émission PESV2" />
              </>
            )}
            <button
              className="btn secondary"
              disabled={!canExportPesv2}
              onClick={() => {
                void downloadPesv2();
              }}
              title={
                pesv2SelectionMode === 'campagne'
                  ? selectedCampagneId
                    ? 'Exporter le flux XML PESV2'
                    : 'Sélectionner une campagne clôturée'
                  : pesv2DateDebut && pesv2DateFin
                    ? 'Exporter le flux XML PESV2'
                    : 'Renseigner une période d\'émission'
              }
            >
              {exporting === 'pesv2' ? 'Export PESV2...' : 'Export PESV2 XML'}
            </button>
            <button
              className="btn secondary"
              disabled={!canRunMiseEnDemeureBatch}
              onClick={() => {
                void runMiseEnDemeureBatch();
              }}
              title={
                selectedMiseEnDemeureTitreIds.length > 0
                  ? `Générer un lot pour ${selectedMiseEnDemeureTitreIds.length} titre(s) éligible(s)`
                  : 'Aucun titre impayé éligible dans la liste courante'
              }
            >
              {exporting === 'mise-en-demeure-batch'
                ? 'Génération lot MED...'
                : `Lot mises en demeure (${selectedMiseEnDemeureTitreIds.length})`}
            </button>
            <span className="toolbar-hint">
              Génère les courriers PDF pour les titres impayés affichés (max 100) et les archive dans les pièces jointes.
            </span>
          </>
        )}
        <span style={{ color: 'var(--c-muted)', fontSize: 13 }}>{rows.length} resultat(s)</span>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Numero</th><th>Annee</th><th>Assujetti</th>
              <th>Montant</th><th>Paye</th><th>Solde</th>
              <th>Emission</th><th>Echeance</th><th>Statut</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={10} className="empty">Aucun titre.</td></tr>
            ) : rows.map((t) => (
              <tr key={t.id}>
                <td>{t.numero}</td>
                <td>{t.annee}</td>
                <td>{t.raison_sociale}</td>
                <td>{formatEuro(t.montant)}</td>
                <td>{formatEuro(t.montant_paye)}</td>
                <td>{formatEuro(t.montant - t.montant_paye)}</td>
                <td>{formatDate(t.date_emission)}</td>
                <td>{formatDate(t.date_echeance)}</td>
                <td><span className={`badge ${getTitreStatusBadgeVariant(t.statut)}`}>{getTitreStatusLabel(t.statut)}</span></td>
                <td>
                  <a className="btn small secondary" href={`/api/titres/${t.id}/pdf`} target="_blank" rel="noreferrer">PDF</a>
                  {hasRole('admin', 'financier') && canGenerateMiseEnDemeure(t, canManageTitres) && (
                    <button
                      className="btn small secondary"
                      style={{ marginLeft: 4 }}
                      disabled={downloadingMiseEnDemeureId === t.id}
                      onClick={() => {
                        void downloadMiseEnDemeure(t);
                      }}
                    >
                      {downloadingMiseEnDemeureId === t.id ? 'MED...' : getMiseEnDemeureActionLabel(t)}
                    </button>
                  )}
                  {canViewRecouvrementHistory(t.statut, canManageTitres) && (
                    <button
                      className="btn small secondary"
                      style={{ marginLeft: 4 }}
                      onClick={() => {
                        void openHistory(t);
                      }}
                    >
                      Historique
                    </button>
                  )}
                  {hasRole('contribuable') && t.statut !== 'paye' && (
                    <button
                      className="btn small secondary"
                      style={{ marginLeft: 4 }}
                      onClick={() => {
                        void initiatePayfipPayment(t);
                      }}
                    >
                      Payer en ligne
                    </button>
                  )}
                  {hasRole('admin', 'financier') && t.statut !== 'paye' && (
                    <button className="btn small" style={{ marginLeft: 4 }} onClick={() => setPaiementFor(t)}>Paiement</button>
                  )}
                  {canRendreExecutoire(t.statut, canManageTitres) && (
                    <button
                      className="btn small secondary"
                      style={{ marginLeft: 4 }}
                      onClick={() => {
                        void downloadTitreExecutoire(t);
                      }}
                    >
                      Rendre exécutoire
                    </button>
                  )}
                  {canAdmettreNonValeur(t.statut, canManageTitres) && (
                    <button
                      className="btn small secondary"
                      style={{ marginLeft: 4 }}
                      onClick={() => {
                        void markAdmisNonValeur(t);
                      }}
                    >
                      Admettre non-valeur
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {paiementFor && <PaiementModal titre={paiementFor} onClose={() => setPaiementFor(null)} onDone={() => { setPaiementFor(null); load(); }} />}
      {historyFor && (
        <TitreHistoryModal
          titre={historyFor}
          loading={historyLoading}
          data={historyData}
          onClose={() => {
            setHistoryFor(null);
            setHistoryData(null);
            setHistoryLoading(false);
          }}
        />
      )}
    </>
  );
}

function TitreHistoryModal({
  titre,
  loading,
  data,
  onClose,
}: {
  titre: Titre;
  loading: boolean;
  data: TitreHistoriqueResponse | null;
  onClose: () => void;
}) {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760 }}>
        <h2>Historique de recouvrement</h2>
        <p style={{ color: 'var(--c-muted)', fontSize: 13 }}>
          Titre {titre.numero} · Statut {getTitreStatusLabel(titre.statut)} · Solde dû {formatEuro(titre.montant - titre.montant_paye)}
        </p>
        {loading ? <div>Chargement...</div> : <TitreRecouvrementHistory actions={data?.actions ?? []} />}
        <div className="actions">
          <button type="button" className="btn secondary" onClick={onClose}>Fermer</button>
        </div>
      </div>
    </div>
  );
}

function PaiementModal({ titre, onClose, onDone }: { titre: Titre; onClose: () => void; onDone: () => void }) {
  const reste = titre.montant - titre.montant_paye;
  const [form, setForm] = useState({
    montant: reste,
    date_paiement: new Date().toISOString().slice(0, 10),
    modalite: 'virement',
    reference: '',
  });
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      await api(`/api/titres/${titre.id}/paiements`, {
        method: 'POST',
        body: JSON.stringify({ ...form, montant: Number(form.montant) }),
      });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Enregistrer un paiement</h2>
        <p style={{ color: 'var(--c-muted)', fontSize: 13 }}>Titre {titre.numero} - Solde du : {formatEuro(reste)}</p>
        {err && <div className="alert error">{err}</div>}
        <form className="form" onSubmit={submit}>
          <div className="form-row">
            <div>
              <label>Montant (EUR)</label>
              <input type="number" step="0.01" min="0.01" max={reste} value={form.montant} onChange={(e) => setForm((f) => ({ ...f, montant: Number(e.target.value) }))} required />
            </div>
            <div>
              <label>Date du paiement</label>
              <input type="date" value={form.date_paiement} onChange={(e) => setForm((f) => ({ ...f, date_paiement: e.target.value }))} required />
            </div>
          </div>
          <div className="form-row">
            <div>
              <label>Modalite</label>
              <select value={form.modalite} onChange={(e) => setForm((f) => ({ ...f, modalite: e.target.value }))}>
                <option value="virement">Virement</option>
                <option value="cheque">Cheque</option>
                <option value="tipi">Paiement en ligne (Tipi)</option>
                <option value="sepa">Prelevement SEPA</option>
                <option value="numeraire">Numeraire (regie)</option>
              </select>
            </div>
            <div>
              <label>Reference</label>
              <input value={form.reference} onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} />
            </div>
          </div>
          <div className="actions">
            <button type="button" className="btn secondary" onClick={onClose}>Annuler</button>
            <button type="submit" className="btn" disabled={loading}>{loading ? 'Enregistrement...' : 'Enregistrer'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
