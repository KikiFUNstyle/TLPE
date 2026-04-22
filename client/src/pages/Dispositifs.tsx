import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { AddressAutocomplete, type AddressSuggestion } from '../components/AddressAutocomplete';

interface Dispositif {
  id: number;
  identifiant: string;
  surface: number;
  nombre_faces: number;
  type_libelle: string;
  categorie: string;
  zone_libelle: string | null;
  adresse_rue: string | null;
  adresse_cp: string | null;
  adresse_ville: string | null;
  statut: string;
  assujetti_id: number;
  assujetti_raison_sociale: string;
}

interface Type { id: number; libelle: string; categorie: string; }
interface Zone {
  id: number;
  libelle: string;
  coefficient: number;
}
interface Assujetti { id: number; identifiant_tlpe: string; raison_sociale: string; }
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

export default function Dispositifs() {
  const { hasRole } = useAuth();
  const [rows, setRows] = useState<Dispositif[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [showImport, setShowImport] = useState(false);
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
        {canWrite && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn secondary"
              onClick={async () => {
                try {
                  const csv = await api<string>('/api/dispositifs/import/template', {
                    headers: { Accept: 'text/csv' },
                  });
                  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'dispositifs-template.csv';
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
            <button className="btn" onClick={() => setShowModal(true)}>+ Nouveau dispositif</button>
          </div>
        )}
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
                <td>{[d.adresse_rue, d.adresse_cp, d.adresse_ville].filter(Boolean).join(', ')}</td>
                <td><span className={`badge ${d.statut === 'declare' ? 'info' : d.statut === 'litigieux' ? 'warn' : ''}`}>{d.statut}</span></td>
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
  const [geocodeWithBan, setGeocodeWithBan] = useState(false);
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
      const response = await api<ImportPreviewResponse>('/api/dispositifs/import', {
        method: 'POST',
        body: JSON.stringify({
          fileName: file.name,
          contentBase64,
          mode: 'preview',
          onError: errorMode,
          geocodeWithBan,
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
      await api('/api/dispositifs/import', {
        method: 'POST',
        body: JSON.stringify({
          fileName: file.name,
          contentBase64,
          mode: 'commit',
          onError: errorMode,
          geocodeWithBan,
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
        <h2>Import en masse des dispositifs</h2>
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

          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={geocodeWithBan}
                onChange={(e) => {
                  setGeocodeWithBan(e.target.checked);
                  setPreview(null);
                }}
              />
              Geocoder via BAN si lat/lon absents
            </label>
          </div>

          {preview && (
            <div className="card" style={{ marginTop: 12 }}>
              <p><strong>Total:</strong> {preview.total}</p>
              <p><strong>Lignes valides:</strong> {preview.valid}</p>
              <p><strong>Lignes rejetées:</strong> {preview.rejected}</p>
              {geocodeWithBan && (
                <div className="alert info" style={{ marginBottom: 12 }}>
                  Géocodage BAN activé : les lignes sans lat/lon seront enrichies automatiquement quand possible.
                </div>
              )}
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
  const [types, setTypes] = useState<Type[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [assujettis, setAssujettis] = useState<Assujetti[]>([]);
  const [form, setForm] = useState({
    assujetti_id: 0,
    type_id: 0,
    zone_id: 0,
    auto_zone: true,
    adresse_rue: '',
    adresse_cp: '',
    adresse_ville: '',
    latitude: '',
    longitude: '',
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
          latitude: form.latitude ? Number(form.latitude) : null,
          longitude: form.longitude ? Number(form.longitude) : null,
          auto_zone: form.auto_zone,
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

  const upd = (k: string, v: string | number | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const applyAddressSuggestion = (suggestion: AddressSuggestion) => {
    setForm((f) => ({
      ...f,
      adresse_rue: suggestion.adresse,
      adresse_cp: suggestion.codePostal ?? f.adresse_cp,
      adresse_ville: suggestion.ville ?? f.adresse_ville,
      latitude: String(suggestion.latitude),
      longitude: String(suggestion.longitude),
      zone_id: 0,
      auto_zone: true,
    }));
  };

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
                <option value={0}>Aucune / auto-detection</option>
                {zones.map((z) => <option key={z.id} value={z.id}>{z.libelle} (×{z.coefficient})</option>)}
              </select>
            </div>
          </div>
          <div>
            <label>Adresse d'implantation</label>
            <AddressAutocomplete
              value={form.adresse_rue}
              onValueChange={(next) => {
                setForm((f) => ({ ...f, adresse_rue: next, latitude: '', longitude: '', zone_id: 0 }));
              }}
              onSelect={applyAddressSuggestion}
            />
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
          <div className="form-row cols-3">
            <div>
              <label>Latitude</label>
              <input type="number" step="0.000001" value={form.latitude} onChange={(e) => upd('latitude', e.target.value)} />
            </div>
            <div>
              <label>Longitude</label>
              <input type="number" step="0.000001" value={form.longitude} onChange={(e) => upd('longitude', e.target.value)} />
            </div>
            <div style={{ display: 'flex', alignItems: 'end' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={form.auto_zone} onChange={(e) => upd('auto_zone', e.target.checked)} />
                Auto-attribuer la zone par point-in-polygon
              </label>
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
