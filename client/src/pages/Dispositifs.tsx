import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';

interface Dispositif {
  id: number;
  identifiant: string;
  surface: number;
  nombre_faces: number;
  type_libelle: string;
  categorie: string;
  zone_libelle: string | null;
  adresse_rue: string | null;
  adresse_ville: string | null;
  statut: string;
  assujetti_id: number;
  assujetti_raison_sociale: string;
}

interface Type { id: number; libelle: string; categorie: string; }
interface Zone { id: number; libelle: string; coefficient: number; }
interface Assujetti { id: number; identifiant_tlpe: string; raison_sociale: string; }

export default function Dispositifs() {
  const { hasRole } = useAuth();
  const [rows, setRows] = useState<Dispositif[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    api<Dispositif[]>(`/api/dispositifs?${params}`).then(setRows).catch((e) => setErr((e as Error).message));
  };
  useEffect(load, [q]);

  const canWrite = hasRole('admin', 'gestionnaire', 'controleur');

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Dispositifs</h1>
          <p>Enseignes, preenseignes et dispositifs publicitaires recenses.</p>
        </div>
        {canWrite && <button className="btn" onClick={() => setShowModal(true)}>+ Nouveau dispositif</button>}
      </div>

      {err && <div className="alert error">{err}</div>}

      <div className="toolbar">
        <input placeholder="Rechercher (id, rue, ville)..." value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="spacer" />
        <span style={{ color: 'var(--c-muted)', fontSize: 13 }}>{rows.length} resultat(s)</span>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Identifiant</th><th>Type</th><th>Assujetti</th>
              <th>Surface</th><th>Faces</th><th>Zone</th><th>Adresse</th><th>Statut</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={8} className="empty">Aucun dispositif.</td></tr>
            ) : rows.map((d) => (
              <tr key={d.id}>
                <td>{d.identifiant}</td>
                <td>{d.type_libelle}</td>
                <td>{d.assujetti_raison_sociale}</td>
                <td>{d.surface} m²</td>
                <td>{d.nombre_faces}</td>
                <td>{d.zone_libelle ?? '-'}</td>
                <td>{[d.adresse_rue, d.adresse_ville].filter(Boolean).join(', ')}</td>
                <td><span className={`badge ${d.statut === 'declare' ? 'info' : d.statut === 'litigieux' ? 'warn' : ''}`}>{d.statut}</span></td>
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
  const [types, setTypes] = useState<Type[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [assujettis, setAssujettis] = useState<Assujetti[]>([]);
  const [form, setForm] = useState({
    assujetti_id: 0,
    type_id: 0,
    zone_id: 0,
    adresse_rue: '',
    adresse_cp: '',
    adresse_ville: '',
    surface: 1,
    nombre_faces: 1,
    date_pose: '',
  });
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    Promise.all([
      api<Type[]>('/api/referentiels/types'),
      api<Zone[]>('/api/referentiels/zones'),
      api<Assujetti[]>('/api/assujettis'),
    ]).then(([t, z, a]) => {
      setTypes(t);
      setZones(z);
      setAssujettis(a);
      if (t[0]) setForm((f) => ({ ...f, type_id: t[0].id }));
      if (a[0]) setForm((f) => ({ ...f, assujetti_id: a[0].id }));
    });
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      await api('/api/dispositifs', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          surface: Number(form.surface),
          nombre_faces: Number(form.nombre_faces),
          zone_id: form.zone_id || null,
          date_pose: form.date_pose || null,
        }),
      });
      onCreated();
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const upd = (k: string, v: string | number) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Nouveau dispositif</h2>
        {err && <div className="alert error">{err}</div>}
        <form className="form" onSubmit={submit}>
          <div className="form-row">
            <div>
              <label>Assujetti *</label>
              <select required value={form.assujetti_id} onChange={(e) => upd('assujetti_id', Number(e.target.value))}>
                {assujettis.map((a) => <option key={a.id} value={a.id}>{a.identifiant_tlpe} - {a.raison_sociale}</option>)}
              </select>
            </div>
            <div>
              <label>Type *</label>
              <select required value={form.type_id} onChange={(e) => upd('type_id', Number(e.target.value))}>
                {types.map((t) => <option key={t.id} value={t.id}>[{t.categorie}] {t.libelle}</option>)}
              </select>
            </div>
          </div>
          <div className="form-row cols-3">
            <div>
              <label>Surface (m²) *</label>
              <input type="number" min="0.01" step="0.01" required value={form.surface} onChange={(e) => upd('surface', e.target.value)} />
            </div>
            <div>
              <label>Faces *</label>
              <select value={form.nombre_faces} onChange={(e) => upd('nombre_faces', Number(e.target.value))}>
                <option value={1}>1</option><option value={2}>2</option>
              </select>
            </div>
            <div>
              <label>Zone</label>
              <select value={form.zone_id} onChange={(e) => upd('zone_id', Number(e.target.value))}>
                <option value={0}>Aucune</option>
                {zones.map((z) => <option key={z.id} value={z.id}>{z.libelle} (×{z.coefficient})</option>)}
              </select>
            </div>
          </div>
          <div>
            <label>Adresse d'implantation</label>
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
          <div>
            <label>Date de pose</label>
            <input type="date" value={form.date_pose} onChange={(e) => upd('date_pose', e.target.value)} />
            <div className="hint">Utilisee pour le prorata temporis.</div>
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
