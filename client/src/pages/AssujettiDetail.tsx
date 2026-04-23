import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { formatDate, formatEuro } from '../format';
import { useAuth } from '../auth';

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
}

export default function AssujettiDetail() {
  const { id } = useParams();
  const [data, setData] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [invitationStatus, setInvitationStatus] = useState<string | null>(null);
  const [invitationStatusType, setInvitationStatusType] = useState<'success' | 'error' | 'info'>('info');
  const [sendingInvitation, setSendingInvitation] = useState(false);
  const { hasRole } = useAuth();

  const load = () => {
    api<Detail>(`/api/assujettis/${id}`).then(setData).catch((e) => setErr((e as Error).message));
  };
  useEffect(() => { load(); }, [id]);

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
        setInvitationStatus('Aucun envoi effectue.');
      }
    } catch (e) {
      setInvitationStatusType('error');
      setInvitationStatus((e as Error).message);
    } finally {
      setSendingInvitation(false);
    }
  };

  if (err) return <div className="alert error">{err}</div>;
  if (!data) return <div>Chargement...</div>;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>{data.raison_sociale}</h1>
          <p>{data.identifiant_tlpe} &middot; SIRET {data.siret ?? 'non renseigne'} &middot; <span className="badge">{data.statut}</span></p>
        </div>
        {hasRole('admin', 'gestionnaire') && (
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
            <div>Solde en cours : <strong>{formatEuro(data.titres.reduce((s, t) => s + (t.montant - t.montant_paye), 0))}</strong></div>
          </div>
        </div>
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
