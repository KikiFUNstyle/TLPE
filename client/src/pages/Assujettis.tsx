import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';

interface Assujetti {
  id: number;
  identifiant_tlpe: string;
  raison_sociale: string;
  siret: string | null;
  adresse_ville: string | null;
  email: string | null;
  statut: string;
}

export default function Assujettis() {
  const { hasRole } = useAuth();
  const [rows, setRows] = useState<Assujetti[]>([]);
  const [q, setQ] = useState('');
  const [statut, setStatut] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (statut) params.set('statut', statut);
    api<Assujetti[]>(`/api/assujettis?${params}`).then(setRows).catch((e) => setErr((e as Error).message));
  };
  useEffect(load, [q, statut]);

  const canWrite = hasRole('admin', 'gestionnaire');

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Assujettis</h1>
          <p>Fichier des contribuables TLPE.</p>
        </div>
        {canWrite && <button className="btn" onClick={() => setShowModal(true)}>+ Nouvel assujetti</button>}
      </div>

      {err && <div className="alert error">{err}</div>}

      <div className="toolbar">
        <input placeholder="Rechercher (nom, SIRET, id)..." value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={statut} onChange={(e) => setStatut(e.target.value)}>
          <option value="">Tous les statuts</option>
          <option value="actif">Actif</option>
          <option value="inactif">Inactif</option>
          <option value="radie">Radie</option>
          <option value="contentieux">Contentieux</option>
        </select>
        <div className="spacer" />
        <span style={{ color: 'var(--c-muted)', fontSize: 13 }}>{rows.length} resultat(s)</span>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Raison sociale</th>
              <th>SIRET</th>
              <th>Ville</th>
              <th>Email</th>
              <th>Statut</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={6} className="empty">Aucun assujetti.</td></tr>
            ) : rows.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/assujettis/${r.id}`}>{r.identifiant_tlpe}</Link></td>
                <td>{r.raison_sociale}</td>
                <td>{r.siret ?? '-'}</td>
                <td>{r.adresse_ville ?? '-'}</td>
                <td>{r.email ?? '-'}</td>
                <td><span className={`badge ${r.statut === 'actif' ? 'success' : r.statut === 'contentieux' ? 'warn' : ''}`}>{r.statut}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && <CreationModal onClose={() => setShowModal(false)} onCreated={() => { setShowModal(false); load(); }} />}
    </>
  );
}

function CreationModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    raison_sociale: '',
    siret: '',
    forme_juridique: 'SARL',
    adresse_rue: '',
    adresse_cp: '',
    adresse_ville: '',
    email: '',
    telephone: '',
  });
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      await api('/api/assujettis', { method: 'POST', body: JSON.stringify(form) });
      onCreated();
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const upd = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Nouvel assujetti</h2>
        {err && <div className="alert error">{err}</div>}
        <form className="form" onSubmit={submit}>
          <div>
            <label>Raison sociale *</label>
            <input required value={form.raison_sociale} onChange={(e) => upd('raison_sociale', e.target.value)} />
          </div>
          <div className="form-row">
            <div>
              <label>SIRET (14 chiffres)</label>
              <input pattern="\d{14}" value={form.siret} onChange={(e) => upd('siret', e.target.value)} />
              <div className="hint">Controle automatique (Luhn).</div>
            </div>
            <div>
              <label>Forme juridique</label>
              <select value={form.forme_juridique} onChange={(e) => upd('forme_juridique', e.target.value)}>
                <option>SA</option><option>SAS</option><option>SARL</option><option>EI</option>
                <option>Association</option><option>Autre</option>
              </select>
            </div>
          </div>
          <div>
            <label>Adresse</label>
            <input value={form.adresse_rue} onChange={(e) => upd('adresse_rue', e.target.value)} />
          </div>
          <div className="form-row">
            <div>
              <label>Code postal</label>
              <input value={form.adresse_cp} onChange={(e) => upd('adresse_cp', e.target.value)} />
            </div>
            <div>
              <label>Ville</label>
              <input value={form.adresse_ville} onChange={(e) => upd('adresse_ville', e.target.value)} />
            </div>
          </div>
          <div className="form-row">
            <div>
              <label>Email</label>
              <input type="email" value={form.email} onChange={(e) => upd('email', e.target.value)} />
            </div>
            <div>
              <label>Telephone</label>
              <input value={form.telephone} onChange={(e) => upd('telephone', e.target.value)} />
            </div>
          </div>
          <div className="actions">
            <button type="button" className="btn secondary" onClick={onClose}>Annuler</button>
            <button type="submit" className="btn" disabled={loading}>{loading ? 'Creation...' : 'Creer'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
