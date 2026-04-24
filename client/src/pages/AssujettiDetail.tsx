import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, apiBlobWithMetadata } from '../api';
import { formatDate, formatEuro, toLocalDateInputValue } from '../format';
import { useAuth } from '../auth';

interface MandatSepa {
  id: number;
  rum: string;
  iban_masked: string;
  bic: string;
  date_signature: string;
  statut: 'actif' | 'revoque';
  date_revocation: string | null;
  created_at?: string;
  updated_at?: string;
}

interface MandatMutateResponse {
  id: number;
  assujetti_id: number;
  rum: string;
  iban_masked?: string;
  bic?: string;
  date_signature?: string;
  statut: 'actif' | 'revoque';
  date_revocation?: string | null;
  mandats_sepa: MandatSepa[];
}

interface Detail {
  id: number;
  identifiant_tlpe: string;
  raison_sociale: string;
  siret: string | null;
  forme_juridique: string | null;
  adresse_rue: string | null;
  adresse_cp: string | null;
  adresse_ville: string | null;
  email: string | null;
  telephone: string | null;
  statut: string;
  dispositifs: Array<{
    id: number;
    identifiant: string;
    type_libelle: string;
    categorie: string;
    surface: number;
    nombre_faces: number;
    zone_libelle: string | null;
    statut: string;
  }>;
  declarations: Array<{
    id: number;
    numero: string;
    annee: number;
    statut: string;
    montant_total: number | null;
  }>;
  titres: Array<{
    id: number;
    numero: string;
    annee: number;
    montant: number;
    montant_paye: number;
    statut: string;
    date_echeance: string;
  }>;
  mandats_sepa?: MandatSepa[];
}

export default function AssujettiDetail() {
  const { id } = useParams();
  const [data, setData] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [invitationStatus, setInvitationStatus] = useState<string | null>(null);
  const [invitationStatusType, setInvitationStatusType] = useState<'success' | 'error' | 'info'>('info');
  const [sendingInvitation, setSendingInvitation] = useState(false);
  const [sepaStatus, setSepaStatus] = useState<string | null>(null);
  const [sepaStatusType, setSepaStatusType] = useState<'success' | 'error' | 'info'>('info');
  const [savingMandat, setSavingMandat] = useState(false);
  const [revokingMandatId, setRevokingMandatId] = useState<number | null>(null);
  const [exportingSepa, setExportingSepa] = useState(false);
  const today = toLocalDateInputValue();
  const [mandatForm, setMandatForm] = useState({
    rum: '',
    iban: '',
    bic: '',
    date_signature: today,
  });
  const [exportForm, setExportForm] = useState({
    date_reference: today,
    date_prelevement: today,
  });
  const { hasRole } = useAuth();

  const canManageAssujetti = hasRole('admin', 'gestionnaire');
  const canManageMandats = hasRole('admin', 'gestionnaire', 'financier');
  const canExportSepa = hasRole('admin', 'financier');

  const mandatCount = data?.mandats_sepa?.length ?? 0;
  const activeMandat = useMemo(() => data?.mandats_sepa?.find((mandat) => mandat.statut === 'actif') ?? null, [data]);

  const load = () => {
    api<Detail>(`/api/assujettis/${id}`)
      .then((next) => {
        setData(next);
        setErr(null);
      })
      .catch((e) => setErr((e as Error).message));
  };
  useEffect(() => {
    load();
  }, [id]);

  const ouvrirDeclaration = async () => {
    if (!data) return;
    const annee = new Date().getFullYear();
    try {
      const res = await api<{ id: number }>('/api/declarations', {
        method: 'POST',
        body: JSON.stringify({ assujetti_id: data.id, annee }),
      });
      window.location.href = `/declarations/${res.id}`;
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const renvoyerInvitation = async () => {
    if (!data) return;
    setSendingInvitation(true);
    setInvitationStatus(null);
    setErr(null);

    try {
      const campagne = await api<{ campagne: { id: number; statut: string } | null }>('/api/campagnes/active');
      if (!campagne.campagne || campagne.campagne.statut !== 'ouverte') {
        throw new Error('Aucune campagne ouverte pour renvoyer une invitation');
      }

      const result = await api<{ ok: boolean; sent: number; failed: number; skipped: number }>(
        `/api/campagnes/${campagne.campagne.id}/envoyer-invitations`,
        {
          method: 'POST',
          body: JSON.stringify({ assujetti_id: data.id }),
        },
      );

      if (result.sent > 0) {
        setInvitationStatusType('success');
        setInvitationStatus('Invitation renvoyee avec succes.');
      } else if (result.failed > 0) {
        setInvitationStatusType('error');
        setInvitationStatus("L'invitation n'a pas pu etre envoyee.");
      } else if (result.skipped > 0) {
        setInvitationStatusType('info');
        setInvitationStatus("Aucun envoi effectue: assujetti non eligible (actif + email requis).");
      } else {
        setInvitationStatusType('info');
        setInvitationStatus("Aucun envoi immediat: invitation en attente d'envoi (service email non configure).");
      }
    } catch (e) {
      setInvitationStatusType('error');
      setInvitationStatus((e as Error).message);
    } finally {
      setSendingInvitation(false);
    }
  };

  const submitMandat = async (event: FormEvent) => {
    event.preventDefault();
    if (!data) return;
    setSavingMandat(true);
    setSepaStatus(null);
    setErr(null);

    try {
      const result = await api<MandatMutateResponse>(`/api/assujettis/${data.id}/mandats-sepa`, {
        method: 'POST',
        body: JSON.stringify(mandatForm),
      });
      setData((prev) => (prev ? { ...prev, mandats_sepa: result.mandats_sepa } : prev));
      setMandatForm((prev) => ({ ...prev, rum: '', iban: '', bic: '' }));
      setSepaStatusType('success');
      setSepaStatus(`Mandat SEPA ${result.rum} enregistré.`);
    } catch (e) {
      setSepaStatusType('error');
      setSepaStatus((e as Error).message);
    } finally {
      setSavingMandat(false);
    }
  };

  const revokeMandat = async (mandat: MandatSepa) => {
    if (!data) return;
    setRevokingMandatId(mandat.id);
    setSepaStatus(null);
    setErr(null);

    try {
      const result = await api<MandatMutateResponse>(`/api/assujettis/${data.id}/mandats-sepa/${mandat.id}/revoke`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setData((prev) => (prev ? { ...prev, mandats_sepa: result.mandats_sepa } : prev));
      setSepaStatusType('success');
      setSepaStatus(`Mandat SEPA ${result.rum} révoqué.`);
    } catch (e) {
      setSepaStatusType('error');
      setSepaStatus((e as Error).message);
    } finally {
      setRevokingMandatId(null);
    }
  };

  const exportSepaBatch = async () => {
    setExportingSepa(true);
    setSepaStatus(null);
    setErr(null);

    try {
      const { blob, filename } = await apiBlobWithMetadata('/api/sepa/export-batch', {
        method: 'POST',
        body: JSON.stringify(exportForm),
      });
      const href = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = filename || `pain.008-${exportForm.date_prelevement}.xml`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(href);
      setSepaStatusType('success');
      setSepaStatus(`Batch pain.008 exporté (${anchor.download}).`);
      load();
    } catch (e) {
      setSepaStatusType('error');
      setSepaStatus((e as Error).message);
    } finally {
      setExportingSepa(false);
    }
  };

  if (err) return <div className="alert error">{err}</div>;
  if (!data) return <div>Chargement...</div>;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>{data.raison_sociale}</h1>
          <p>
            {data.identifiant_tlpe} &middot; SIRET {data.siret ?? 'non renseigne'} &middot; <span className="badge">{data.statut}</span>
          </p>
        </div>
        {canManageAssujetti && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={ouvrirDeclaration}>Ouvrir declaration {new Date().getFullYear()}</button>
            <button className="btn secondary" onClick={renvoyerInvitation} disabled={sendingInvitation}>
              {sendingInvitation ? 'Envoi...' : "Renvoyer l'invitation"}
            </button>
          </div>
        )}
      </div>
      {invitationStatus && (
        <div className={`alert ${invitationStatusType}`} style={{ marginBottom: 16 }}>
          {invitationStatus}
        </div>
      )}
      {sepaStatus && (
        <div className={`alert ${sepaStatusType}`} style={{ marginBottom: 16 }}>
          {sepaStatus}
        </div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Coordonnees</h3>
          <div style={{ fontSize: 14, lineHeight: 1.8 }}>
            <div><strong>Forme :</strong> {data.forme_juridique ?? '-'}</div>
            <div><strong>Adresse :</strong> {[data.adresse_rue, data.adresse_cp, data.adresse_ville].filter(Boolean).join(', ') || '-'}</div>
            <div><strong>Email :</strong> {data.email ?? '-'}</div>
            <div><strong>Tel :</strong> {data.telephone ?? '-'}</div>
          </div>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Resume fiscal</h3>
          <div style={{ fontSize: 14, lineHeight: 1.8 }}>
            <div>Dispositifs : <strong>{data.dispositifs.length}</strong></div>
            <div>Declarations : <strong>{data.declarations.length}</strong></div>
            <div>Titres emis : <strong>{data.titres.length}</strong></div>
            <div>Mandats SEPA : <strong>{mandatCount}</strong></div>
            <div>Mandat actif : <strong>{activeMandat ? activeMandat.rum : 'aucun'}</strong></div>
            <div>Solde en cours : <strong>{formatEuro(data.titres.reduce((s, t) => s + (t.montant - t.montant_paye), 0))}</strong></div>
          </div>
        </div>
      </div>

      <h3 style={{ marginTop: 24 }}>Mandats SEPA</h3>
      <div className="grid cols-2">
        <div className="card">
          <h3 style={{ marginTop: 0, marginBottom: 12 }}>Mandats enregistrés</h3>
          {data.mandats_sepa && data.mandats_sepa.length > 0 ? (
            <table className="table">
              <thead>
                <tr>
                  <th>RUM</th>
                  <th>IBAN</th>
                  <th>BIC</th>
                  <th>Signature</th>
                  <th>Statut</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.mandats_sepa.map((mandat) => (
                  <tr key={mandat.id}>
                    <td>{mandat.rum}</td>
                    <td>{mandat.iban_masked}</td>
                    <td>{mandat.bic}</td>
                    <td>{formatDate(mandat.date_signature)}</td>
                    <td>
                      <span className={`badge ${mandat.statut === 'actif' ? 'success' : 'warn'}`}>
                        {mandat.statut}
                      </span>
                      {mandat.date_revocation ? ` · ${formatDate(mandat.date_revocation)}` : ''}
                    </td>
                    <td>
                      {canManageMandats && mandat.statut === 'actif' ? (
                        <button
                          type="button"
                          className="btn secondary"
                          onClick={() => { void revokeMandat(mandat); }}
                          disabled={revokingMandatId === mandat.id}
                        >
                          {revokingMandatId === mandat.id ? 'Révocation...' : 'Révoquer'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty" style={{ padding: 24 }}>Aucun mandat SEPA enregistré.</div>
          )}
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0, marginBottom: 12 }}>Créer un mandat</h3>
          {canManageMandats ? (
            <form className="form" onSubmit={submitMandat}>
              <div className="form-row">
                <div>
                  <label>RUM</label>
                  <input
                    value={mandatForm.rum}
                    placeholder="RUM-ALPHA-001"
                    onChange={(e) => setMandatForm((prev) => ({ ...prev, rum: e.target.value }))}
                    required
                  />
                </div>
                <div>
                  <label>Date de signature</label>
                  <input
                    type="date"
                    value={mandatForm.date_signature}
                    onChange={(e) => setMandatForm((prev) => ({ ...prev, date_signature: e.target.value }))}
                    required
                  />
                </div>
              </div>
              <div className="form-row">
                <div>
                  <label>IBAN</label>
                  <input
                    value={mandatForm.iban}
                    placeholder="FR7630006000011234567890189"
                    onChange={(e) => setMandatForm((prev) => ({ ...prev, iban: e.target.value }))}
                    required
                  />
                </div>
                <div>
                  <label>BIC</label>
                  <input
                    value={mandatForm.bic}
                    placeholder="AGRIFRPPXXX"
                    onChange={(e) => setMandatForm((prev) => ({ ...prev, bic: e.target.value }))}
                    required
                  />
                </div>
              </div>
              <div className="actions">
                <button type="submit" className="btn" disabled={savingMandat}>
                  {savingMandat ? 'Enregistrement...' : 'Enregistrer le mandat'}
                </button>
              </div>
            </form>
          ) : (
            <div className="empty" style={{ padding: 24 }}>Droits insuffisants pour gérer les mandats.</div>
          )}
        </div>
      </div>

      <h3 style={{ marginTop: 24 }}>Export SEPA pain.008</h3>
      <div className="card">
        {canExportSepa ? (
          <form className="form" onSubmit={(e) => { e.preventDefault(); void exportSepaBatch(); }}>
            <div className="form-row">
              <div>
                <label>Date de référence</label>
                <input
                  type="date"
                  value={exportForm.date_reference}
                  onChange={(e) => setExportForm((prev) => ({ ...prev, date_reference: e.target.value }))}
                  required
                />
              </div>
              <div>
                <label>Date de prélèvement</label>
                <input
                  type="date"
                  value={exportForm.date_prelevement}
                  onChange={(e) => setExportForm((prev) => ({ ...prev, date_prelevement: e.target.value }))}
                  required
                />
              </div>
            </div>
            <div className="hint">Les titres échus disposant d'un mandat actif sont regroupés automatiquement en lot pain.008. La séquence FRST/RCUR est calculée selon l'historique d'export.</div>
            <div className="actions">
              <button type="submit" className="btn secondary" disabled={exportingSepa}>
                {exportingSepa ? 'Export en cours...' : 'Exporter le lot SEPA'}
              </button>
            </div>
          </form>
        ) : (
          <div className="empty" style={{ padding: 24 }}>Seuls les profils admin ou financier peuvent exporter un lot SEPA.</div>
        )}
      </div>

      <h3 style={{ marginTop: 24 }}>Dispositifs ({data.dispositifs.length})</h3>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Identifiant</th><th>Type</th><th>Categorie</th>
              <th>Surface</th><th>Faces</th><th>Zone</th><th>Statut</th>
            </tr>
          </thead>
          <tbody>
            {data.dispositifs.length === 0 ? (
              <tr><td colSpan={7} className="empty">Aucun dispositif.</td></tr>
            ) : data.dispositifs.map((d) => (
              <tr key={d.id}>
                <td>{d.identifiant}</td>
                <td>{d.type_libelle}</td>
                <td style={{ textTransform: 'capitalize' }}>{d.categorie}</td>
                <td>{d.surface} m²</td>
                <td>{d.nombre_faces}</td>
                <td>{d.zone_libelle ?? '-'}</td>
                <td><span className="badge">{d.statut}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ marginTop: 24 }}>Declarations</h3>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr><th>Numero</th><th>Annee</th><th>Statut</th><th>Montant</th><th></th></tr>
          </thead>
          <tbody>
            {data.declarations.length === 0 ? (
              <tr><td colSpan={5} className="empty">Aucune declaration.</td></tr>
            ) : data.declarations.map((d) => (
              <tr key={d.id}>
                <td>{d.numero}</td>
                <td>{d.annee}</td>
                <td><span className="badge">{d.statut}</span></td>
                <td>{formatEuro(d.montant_total)}</td>
                <td><Link to={`/declarations/${d.id}`}>Ouvrir</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ marginTop: 24 }}>Titres de recettes</h3>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr><th>Numero</th><th>Annee</th><th>Montant</th><th>Paye</th><th>Echeance</th><th>Statut</th><th></th></tr>
          </thead>
          <tbody>
            {data.titres.length === 0 ? (
              <tr><td colSpan={7} className="empty">Aucun titre.</td></tr>
            ) : data.titres.map((t) => (
              <tr key={t.id}>
                <td>{t.numero}</td>
                <td>{t.annee}</td>
                <td>{formatEuro(t.montant)}</td>
                <td>{formatEuro(t.montant_paye)}</td>
                <td>{formatDate(t.date_echeance)}</td>
                <td><span className={`badge ${t.statut === 'paye' ? 'success' : ''}`}>{t.statut}</span></td>
                <td><a href={`/api/titres/${t.id}/pdf`} target="_blank" rel="noreferrer">PDF</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
