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

interface ImportAnomaly {
  line: number;
  field: string;
  message: string;
}

interface ImportPreviewResponse {
  total: number;
  valid: number;
  rejected: number;
  anomalies: ImportAnomaly[];
}

export default function Assujettis() {
  const { hasRole } = useAuth();
  const [rows, setRows] = useState<Assujetti[]>([]);
  const [q, setQ] = useState('');
  const [statut, setStatut] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [showImport, setShowImport] = useState(false);
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
        {canWrite && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn secondary"
              onClick={async () => {
                try {
                  const csv = await api<string>('/api/assujettis/import/template', {
                    headers: { Accept: 'text/csv' },
                  });
                  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'assujettis-template.csv';
                  a.click();
                  URL.revokeObjectURL(url);
                } catch (error) {
                  setErr((error as Error).message);
                }
              }}
            >
              Template CSV
            </button>
            <button className="btn secondary" onClick={() => setShowImport(true)}>Importer CSV/Excel</button>
            <button className="btn" onClick={() => setShowModal(true)}>+ Nouvel assujetti</button>
          </div>
        )}
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

      {showImport && <ImportModal onClose={() => setShowImport(false)} onImported={() => { setShowImport(false); load(); }} />}
      {showModal && <CreationModal onClose={() => setShowModal(false)} onCreated={() => { setShowModal(false); load(); }} />}
    </>
  );
}

function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [errorMode, setErrorMode] = useState<'abort' | 'skip'>('abort');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const readFileBase64 = (input: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const raw = String(reader.result || '');
        const comma = raw.indexOf(',');
        resolve(comma >= 0 ? raw.slice(comma + 1) : raw);
      };
      reader.onerror = () => reject(new Error('Impossible de lire le fichier'));
      reader.readAsDataURL(input);
    });

  const previewImport = async () => {
    if (!file) {
      setErr('Veuillez choisir un fichier CSV ou Excel');
      return;
    }
    setErr(null);
    setLoading(true);
    try {
      const contentBase64 = await readFileBase64(file);
      const response = await api<ImportPreviewResponse>('/api/assujettis/import', {
        method: 'POST',
        body: JSON.stringify({
          fileName: file.name,
          contentBase64,
          mode: 'preview',
          onError: errorMode,
        }),
      });
      setPreview(response);
    } catch (error) {
      setErr((error as Error).message);
      setPreview(null);
    } finally {
      setLoading(false);
    }
  };

  const commitImport = async () => {
    if (!file) {
      setErr('Veuillez choisir un fichier CSV ou Excel');
      return;
    }
    setErr(null);
    setLoading(true);
    try {
      const contentBase64 = await readFileBase64(file);
      await api('/api/assujettis/import', {
        method: 'POST',
        body: JSON.stringify({
          fileName: file.name,
          contentBase64,
          mode: 'commit',
          onError: errorMode,
        }),
      });
      onImported();
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Import en masse des assujettis</h2>
        {err && <div className="alert error">{err}</div>}

        <div className="form">
          <div>
            <label>Fichier (.csv, .xlsx, .xls)</label>
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPreview(null);
              }}
            />
          </div>

          <div>
            <label>Gestion des erreurs</label>
            <select value={errorMode} onChange={(e) => setErrorMode(e.target.value as 'abort' | 'skip')}>
              <option value="abort">Tout annuler si anomalies</option>
              <option value="skip">Ignorer les lignes en erreur</option>
            </select>
          </div>

          {preview && (
            <div className="card" style={{ marginTop: 12 }}>
              <p><strong>Total:</strong> {preview.total}</p>
              <p><strong>Lignes valides:</strong> {preview.valid}</p>
              <p><strong>Lignes rejetées:</strong> {preview.rejected}</p>
              {preview.anomalies.length > 0 && (
                <div style={{ maxHeight: 180, overflow: 'auto' }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Ligne</th>
                        <th>Champ</th>
                        <th>Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.anomalies.map((a, idx) => (
                        <tr key={`${a.line}-${a.field}-${idx}`}>
                          <td>{a.line}</td>
                          <td>{a.field}</td>
                          <td>{a.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <div className="actions">
            <button type="button" className="btn secondary" onClick={onClose}>Annuler</button>
            <button type="button" className="btn secondary" onClick={previewImport} disabled={loading}>
              {loading ? 'Analyse...' : 'Pré-contrôle'}
            </button>
            <button type="button" className="btn" onClick={commitImport} disabled={loading}>
              {loading ? 'Import...' : 'Importer'}
            </button>
          </div>
        </div>
      </div>
    </div>
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
