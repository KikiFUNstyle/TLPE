import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { formatEuro } from '../format';
import { useAuth } from '../auth';

interface Ligne {
  id: number;
  dispositif_id: number;
  dispositif_identifiant: string;
  type_libelle: string;
  categorie: string;
  zone_libelle: string | null;
  adresse_rue: string | null;
  adresse_ville: string | null;
  surface_declaree: number;
  nombre_faces: number;
  date_pose: string | null;
  date_depose: string | null;
  tarif_applique: number | null;
  coefficient_zone: number | null;
  prorata: number | null;
  montant_ligne: number | null;
}

interface Declaration {
  id: number;
  numero: string;
  assujetti_id: number;
  annee: number;
  statut: string;
  alerte_gestionnaire: number;
  date_soumission: string | null;
  date_validation: string | null;
  hash_soumission: string | null;
  montant_total: number | null;
  commentaires: string | null;
  lignes: Ligne[];
  receipt: null | {
    verification_token: string;
    payload_hash: string;
    generated_at: string;
    email_status: 'pending' | 'envoye' | 'echec';
    email_error: string | null;
    email_sent_at: string | null;
    download_url: string;
  };
}

export default function DeclarationDetail() {
  const { id } = useParams();
  const { hasRole } = useAuth();
  const [decl, setDecl] = useState<Declaration | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api<Declaration>(`/api/declarations/${id}`).then(setDecl).catch((e) => setErr((e as Error).message));
  };
  useEffect(() => { load(); }, [id]);

  if (err) return <div className="alert error">{err}</div>;
  if (!decl) return <div>Chargement...</div>;

  const canEdit = decl.statut === 'brouillon';
  const canSubmit = canEdit && decl.lignes.length > 0;
  const canValidate = decl.statut === 'soumise' && hasRole('admin', 'gestionnaire');
  const canEmit = decl.statut === 'validee' && hasRole('admin', 'financier') && decl.montant_total !== null;
  const canDownloadReceipt = decl.statut !== 'brouillon' && !!decl.receipt?.download_url;

  const saveLignes = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/declarations/${decl.id}/lignes`, {
        method: 'PUT',
        body: JSON.stringify(
          decl.lignes.map((l) => ({
            dispositif_id: l.dispositif_id,
            surface_declaree: Number(l.surface_declaree),
            nombre_faces: Number(l.nombre_faces),
            date_pose: l.date_pose || null,
            date_depose: l.date_depose || null,
          })),
        ),
      });
      setInfo('Lignes enregistrees');
      load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await api(`/api/declarations/${decl.id}/soumettre`, { method: 'POST' }); setInfo('Declaration soumise'); load(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const valider = async () => {
    setBusy(true); setErr(null);
    try { const r = await api<{ montant_total: number }>(`/api/declarations/${decl.id}/valider`, { method: 'POST' }); setInfo(`Validee - montant calcule : ${formatEuro(r.montant_total)}`); load(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const rejeter = async () => {
    const motif = prompt('Motif du rejet ?');
    if (!motif) return;
    setBusy(true); setErr(null);
    try { await api(`/api/declarations/${decl.id}/rejeter`, { method: 'POST', body: JSON.stringify({ motif }) }); load(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const emettre = async () => {
    setBusy(true); setErr(null);
    try { await api('/api/titres', { method: 'POST', body: JSON.stringify({ declaration_id: decl.id }) }); setInfo('Titre emis'); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const updateLigne = (idx: number, patch: Partial<Ligne>) => {
    setDecl({
      ...decl,
      lignes: decl.lignes.map((l, i) => (i === idx ? { ...l, ...patch } : l)),
    });
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Declaration {decl.numero}</h1>
          <p>
            Exercice {decl.annee} &middot;{' '}
            <span className={`badge ${
              decl.statut === 'validee' ? 'success' :
              decl.statut === 'soumise' ? 'info' :
              decl.statut === 'rejetee' ? 'danger' : ''
            }`}>{decl.statut}</span>
            {decl.date_soumission && <> &middot; Soumise le {decl.date_soumission}</>}
            {decl.hash_soumission && <> &middot; <code style={{ fontSize: 11 }}>{decl.hash_soumission.substring(0, 12)}...</code></>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {canEdit && <button className="btn secondary" disabled={busy} onClick={saveLignes}>Enregistrer</button>}
          {canSubmit && <button className="btn" disabled={busy} onClick={submit}>Soumettre</button>}
          {canValidate && <button className="btn success" disabled={busy} onClick={valider}>Valider &amp; calculer</button>}
          {canValidate && <button className="btn danger" disabled={busy} onClick={rejeter}>Rejeter</button>}
          {canEmit && <button className="btn" disabled={busy} onClick={emettre}>Emettre titre</button>}
          {canDownloadReceipt && (
            <a className="btn secondary" href={decl.receipt!.download_url} target="_blank" rel="noreferrer">
              Télécharger l'accusé PDF
            </a>
          )}
        </div>
      </div>

      {err && <div className="alert error">{err}</div>}
      {info && <div className="alert success">{info}</div>}
      {decl.alerte_gestionnaire ? (
        <div className="alert warning">Alerte gestionnaire : variation de surface N vs N-1 supérieure à 30%.</div>
      ) : null}
      {decl.receipt ? (
        <div className="alert info">
          Accusé de réception généré le {decl.receipt.generated_at}.&nbsp;
          <code style={{ fontSize: 11 }}>{decl.receipt.payload_hash.substring(0, 16)}...</code>
          {decl.receipt.email_status === 'envoye' && ' · Email envoyé'}
          {decl.receipt.email_status === 'pending' && ' · Email en attente (SMTP non configuré)'}
          {decl.receipt.email_status === 'echec' && ` · Email en échec${decl.receipt.email_error ? `: ${decl.receipt.email_error}` : ''}`}
        </div>
      ) : null}
      {decl.commentaires && <div className="alert info">Commentaire : {decl.commentaires}</div>}

      <h3>Dispositifs declares ({decl.lignes.length})</h3>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Dispositif</th><th>Type</th><th>Surface (m²)</th><th>Faces</th>
              <th>Pose</th><th>Depose</th>
              {!canEdit && <><th>Tarif</th><th>Coef</th><th>Prorata</th><th>Montant</th></>}
            </tr>
          </thead>
          <tbody>
            {decl.lignes.length === 0 ? (
              <tr><td colSpan={canEdit ? 6 : 10} className="empty">Aucun dispositif.</td></tr>
            ) : decl.lignes.map((l, idx) => (
              <tr key={l.id}>
                <td>
                  {l.dispositif_identifiant}
                  <div style={{ fontSize: 11, color: 'var(--c-muted)' }}>
                    {[l.adresse_rue, l.adresse_ville].filter(Boolean).join(', ')}
                  </div>
                </td>
                <td>{l.type_libelle}<div style={{ fontSize: 11, color: 'var(--c-muted)' }}>{l.categorie}</div></td>
                <td>
                  {canEdit ? (
                    <input type="number" step="0.01" min="0.01" value={l.surface_declaree}
                      onChange={(e) => updateLigne(idx, { surface_declaree: Number(e.target.value) })}
                      style={{ width: 80 }} />
                  ) : l.surface_declaree}
                </td>
                <td>
                  {canEdit ? (
                    <select value={l.nombre_faces} onChange={(e) => updateLigne(idx, { nombre_faces: Number(e.target.value) })}>
                      <option value={1}>1</option><option value={2}>2</option>
                    </select>
                  ) : l.nombre_faces}
                </td>
                <td>{canEdit ? <input type="date" value={l.date_pose || ''} onChange={(e) => updateLigne(idx, { date_pose: e.target.value })} /> : l.date_pose || '-'}</td>
                <td>{canEdit ? <input type="date" value={l.date_depose || ''} onChange={(e) => updateLigne(idx, { date_depose: e.target.value })} /> : l.date_depose || '-'}</td>
                {!canEdit && <>
                  <td>{l.tarif_applique ?? '-'}</td>
                  <td>{l.coefficient_zone ?? '-'}</td>
                  <td>{l.prorata !== null ? l.prorata.toFixed(3) : '-'}</td>
                  <td><strong>{formatEuro(l.montant_ligne)}</strong></td>
                </>}
              </tr>
            ))}
          </tbody>
          {!canEdit && decl.montant_total !== null && (
            <tfoot>
              <tr>
                <td colSpan={9} style={{ textAlign: 'right', fontWeight: 600 }}>Total (arrondi euro inferieur) :</td>
                <td style={{ fontWeight: 700, color: 'var(--c-primary)' }}>{formatEuro(decl.montant_total)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </>
  );
}
