import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api';
import { formatDate, formatEuro } from '../format';
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

interface Assujetti { id: number; raison_sociale: string; identifiant_tlpe: string; }

export default function ContentieuxPage() {
  const { hasRole, user } = useAuth();
  const [rows, setRows] = useState<Contentieux[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  const load = () => {
    api<Contentieux[]>('/api/contentieux').then(setRows).catch((e) => setErr((e as Error).message));
  };
  useEffect(load, []);

  const decide = async (c: Contentieux) => {
    const statut = prompt('Decision (instruction, clos_maintenu, degrevement_partiel, degrevement_total, non_lieu) :', 'instruction');
    if (!statut) return;
    const decision = prompt('Motivation de la decision :', '');
    try {
      await api(`/api/contentieux/${c.id}/decider`, {
        method: 'POST',
        body: JSON.stringify({ statut, decision }),
      });
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Contentieux et reclamations</h1>
          <p>Suivi des dossiers gracieux, contentieux, moratoires et controles.</p>
        </div>
        {(hasRole('admin', 'gestionnaire') || (user?.role === 'contribuable' && user.assujetti_id)) && (
          <button className="btn" onClick={() => setShowModal(true)}>+ Nouvelle reclamation</button>
        )}
      </div>

      {err && <div className="alert error">{err}</div>}

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr><th>Numero</th><th>Type</th><th>Assujetti</th><th>Montant litige</th><th>Ouverture</th><th>Statut</th><th>Description</th><th></th></tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={8} className="empty">Aucun contentieux.</td></tr>
            ) : rows.map((c) => (
              <tr key={c.id}>
                <td>{c.numero}</td>
                <td>{c.type}</td>
                <td>{c.raison_sociale}</td>
                <td>{formatEuro(c.montant_litige)}</td>
                <td>{formatDate(c.date_ouverture)}</td>
                <td>
                  <span className={`badge ${c.statut.startsWith('degrevement') ? 'success' : c.statut === 'non_lieu' ? '' : 'info'}`}>
                    {c.statut.replace('_', ' ')}
                  </span>
                </td>
                <td style={{ fontSize: 12, maxWidth: 300 }}>{c.description}</td>
                <td>
                  {hasRole('admin', 'gestionnaire', 'financier') && (
                    <button className="btn small secondary" onClick={() => decide(c)}>Decision</button>
                  )}
                </td>
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
