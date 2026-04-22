import { FormEvent, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { api } from '../api';
import { formatEuro } from '../format';
import { useAuth } from '../auth';

interface Bareme {
  id: number;
  annee: number;
  categorie: 'publicitaire' | 'preenseigne' | 'enseigne';
  surface_min: number;
  surface_max: number | null;
  tarif_m2: number | null;
  tarif_fixe: number | null;
  exonere: number;
  libelle: string;
}

interface BaremeHistory {
  annee: number;
  lignes: number;
  first_bareme_id: number;
  activated_at: string | null;
}

interface Zone {
  id: number;
  code: string;
  libelle: string;
  coefficient: number;
  description?: string | null;
}

interface ZoneGeoJson {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    properties: {
      code: string;
      libelle: string;
      coefficient: number;
      description?: string | null;
    };
    geometry: {
      type: 'Polygon' | 'MultiPolygon';
      coordinates: unknown;
    };
  }>;
}

interface Exoneration {
  id: number;
  type: 'droit' | 'deliberee' | 'eco';
  critere: string;
  taux: number;
  date_debut: string | null;
  date_fin: string | null;
  active: number;
}

interface ExonerationForm {
  type: Exoneration['type'];
  critere: string;
  taux: string;
  date_debut: string;
  date_fin: string;
  active: boolean;
}

interface Type {
  id: number;
  code: string;
  libelle: string;
  categorie: string;
}

export default function Referentiels() {
  const [tab, setTab] = useState<'bareme' | 'zones' | 'types' | 'exonerations'>('bareme');
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Referentiels</h1>
          <p>Bareme tarifaire, zones geographiques, types de dispositifs.</p>
        </div>
      </div>
      <div className="toolbar">
        <button className={`btn ${tab === 'bareme' ? '' : 'secondary'}`} onClick={() => setTab('bareme')}>Bareme</button>
        <button className={`btn ${tab === 'zones' ? '' : 'secondary'}`} onClick={() => setTab('zones')}>Zones</button>
        <button className={`btn ${tab === 'types' ? '' : 'secondary'}`} onClick={() => setTab('types')}>Types de dispositifs</button>
        <button className={`btn ${tab === 'exonerations' ? '' : 'secondary'}`} onClick={() => setTab('exonerations')}>Exonerations</button>
      </div>
      {tab === 'bareme' && <BaremeTab />}
      {tab === 'zones' && <ZonesTab />}
      {tab === 'types' && <TypesTab />}
      {tab === 'exonerations' && <ExonerationsTab />}
    </>
  );
}

function BaremeTab() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [rows, setRows] = useState<Bareme[]>([]);
  const [history, setHistory] = useState<BaremeHistory[]>([]);
  const [activeYear, setActiveYear] = useState<number | null>(null);
  const [selectedYear, setSelectedYear] = useState<number | 'all'>('all');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [csvInput, setCsvInput] = useState('');
  const [singleForm, setSingleForm] = useState({
    annee: new Date().getFullYear(),
    categorie: 'publicitaire' as 'publicitaire' | 'preenseigne' | 'enseigne',
    surface_min: 0,
    surface_max: '',
    tarif_m2: '',
    tarif_fixe: '',
    exonere: false,
    libelle: '',
  });

  const availableYears = useMemo(() => history.map((h) => h.annee), [history]);

  async function refreshData() {
    setLoading(true);
    setError(null);
    try {
      const [baremes, historyRows, active] = await Promise.all([
        api<Bareme[]>('/api/referentiels/baremes'),
        api<BaremeHistory[]>('/api/referentiels/baremes/history'),
        api<{ annee_active: number | null }>('/api/referentiels/baremes/active-year'),
      ]);
      setRows(baremes);
      setHistory(historyRows);
      setActiveYear(active.annee_active);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshData();
  }, []);

  const displayedRows = useMemo(() => {
    if (selectedYear === 'all') return rows;
    return rows.filter((r) => r.annee === selectedYear);
  }, [rows, selectedYear]);

  async function submitSingleBareme(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/referentiels/baremes', {
        method: 'POST',
        body: JSON.stringify({
          annee: singleForm.annee,
          categorie: singleForm.categorie,
          surface_min: Number(singleForm.surface_min),
          surface_max: singleForm.surface_max ? Number(singleForm.surface_max) : null,
          tarif_m2: singleForm.tarif_m2 ? Number(singleForm.tarif_m2) : null,
          tarif_fixe: singleForm.tarif_fixe ? Number(singleForm.tarif_fixe) : null,
          exonere: singleForm.exonere,
          libelle: singleForm.libelle,
        }),
      });
      setSingleForm((prev) => ({ ...prev, libelle: '', tarif_m2: '', tarif_fixe: '' }));
      await refreshData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    }
  }

  async function submitCsvImport(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/referentiels/baremes/import', {
        method: 'POST',
        body: JSON.stringify({ csv: csvInput }),
      });
      setCsvInput('');
      await refreshData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    }
  }

  async function activateYear(year: number) {
    setError(null);
    try {
      await api(`/api/referentiels/baremes/activate-year/${year}`, { method: 'POST' });
      await refreshData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    }
  }

  return (
    <div className="grid" style={{ gap: 16 }}>
      {error && <div className="card" style={{ borderColor: '#b91c1c', color: '#b91c1c' }}>{error}</div>}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <strong>Historique des baremes</strong>
          <span>Annee active: <strong>{activeYear ?? '-'}</strong></span>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className={`btn ${selectedYear === 'all' ? '' : 'secondary'}`} onClick={() => setSelectedYear('all')}>
            Toutes les annees
          </button>
          {availableYears.map((year) => (
            <button key={year} className={`btn ${selectedYear === year ? '' : 'secondary'}`} onClick={() => setSelectedYear(year)}>
              {year}
            </button>
          ))}
        </div>
        <table className="table" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Annee</th>
              <th>Lignes</th>
              <th>Activation</th>
              {isAdmin && <th>Action</th>}
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.annee}>
                <td>{h.annee}</td>
                <td>{h.lignes}</td>
                <td>{h.activated_at ? new Date(h.activated_at).toLocaleString() : 'Non active'}</td>
                {isAdmin && (
                  <td>
                    <button className="btn secondary" disabled={!!h.activated_at} onClick={() => activateYear(h.annee)}>
                      {h.activated_at ? 'Deja active' : 'Activer'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <div className="grid cols-2" style={{ gap: 16 }}>
          <form className="card" onSubmit={submitSingleBareme}>
            <h3>Ajouter un bareme</h3>
            <div className="form-grid two" style={{ marginTop: 8 }}>
              <div>
                <label>Annee</label>
                <input type="number" value={singleForm.annee} onChange={(e) => setSingleForm((p) => ({ ...p, annee: Number(e.target.value) }))} required />
              </div>
              <div>
                <label>Categorie</label>
                <select value={singleForm.categorie} onChange={(e) => setSingleForm((p) => ({ ...p, categorie: e.target.value as Bareme['categorie'] }))}>
                  <option value="publicitaire">Publicitaire</option>
                  <option value="preenseigne">Preenseigne</option>
                  <option value="enseigne">Enseigne</option>
                </select>
              </div>
              <div>
                <label>Surface min</label>
                <input type="number" step="0.01" value={singleForm.surface_min} onChange={(e) => setSingleForm((p) => ({ ...p, surface_min: Number(e.target.value) }))} required />
              </div>
              <div>
                <label>Surface max</label>
                <input type="number" step="0.01" value={singleForm.surface_max} onChange={(e) => setSingleForm((p) => ({ ...p, surface_max: e.target.value }))} />
              </div>
              <div>
                <label>Tarif m²</label>
                <input type="number" step="0.01" value={singleForm.tarif_m2} onChange={(e) => setSingleForm((p) => ({ ...p, tarif_m2: e.target.value }))} />
              </div>
              <div>
                <label>Tarif fixe</label>
                <input type="number" step="0.01" value={singleForm.tarif_fixe} onChange={(e) => setSingleForm((p) => ({ ...p, tarif_fixe: e.target.value }))} />
              </div>
            </div>
            <label style={{ marginTop: 8 }}>Libelle</label>
            <input value={singleForm.libelle} onChange={(e) => setSingleForm((p) => ({ ...p, libelle: e.target.value }))} required />
            <label style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={singleForm.exonere} onChange={(e) => setSingleForm((p) => ({ ...p, exonere: e.target.checked }))} />
              Exonere
            </label>
            <div style={{ marginTop: 12 }}>
              <button className="btn" type="submit">Enregistrer</button>
            </div>
          </form>

          <form className="card" onSubmit={submitCsvImport}>
            <h3>Import CSV des baremes</h3>
            <p style={{ marginTop: 8, marginBottom: 8 }}>
              Colonnes attendues : <code>annee,categorie,surface_min,surface_max,tarif_m2,tarif_fixe,exonere,libelle</code>
            </p>
            <textarea
              rows={12}
              placeholder="Collez ici le contenu CSV"
              value={csvInput}
              onChange={(e) => setCsvInput(e.target.value)}
              style={{ width: '100%' }}
              required
            />
            <div style={{ marginTop: 12 }}>
              <button className="btn" type="submit">Importer</button>
            </div>
          </form>
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: 12, borderBottom: '1px solid #e5e7eb' }}>
          <strong>Liste des baremes {selectedYear === 'all' ? '' : `- ${selectedYear}`}</strong>
          {loading && <span style={{ marginLeft: 8 }}>Chargement...</span>}
        </div>
        <table className="table">
          <thead>
            <tr><th>Annee</th><th>Categorie</th><th>Tranche</th><th>Tarif/m²</th><th>Tarif fixe</th><th>Exonere</th></tr>
          </thead>
          <tbody>
            {displayedRows.map((b) => (
              <tr key={b.id}>
                <td>{b.annee}</td>
                <td style={{ textTransform: 'capitalize' }}>{b.categorie}</td>
                <td>{b.libelle}</td>
                <td>{b.tarif_m2 !== null ? formatEuro(b.tarif_m2) : '-'}</td>
                <td>{b.tarif_fixe !== null ? formatEuro(b.tarif_fixe) : '-'}</td>
                <td>{b.exonere ? 'Oui' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ZonesTab() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [rows, setRows] = useState<Zone[]>([]);
  const [geoJsonText, setGeoJsonText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadZones = async () => {
    try {
      const zones = await api<Zone[]>('/api/referentiels/zones');
      setRows(zones);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    }
  };

  useEffect(() => {
    loadZones();
  }, []);

  const importGeoJson = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);

    try {
      const parsed = JSON.parse(geoJsonText);
      const result = await api<{ imported: number; created: number; updated: number }>('/api/referentiels/zones/import', {
        method: 'POST',
        body: JSON.stringify({ geojson: parsed }),
      });
      setMessage(`Import termine: ${result.imported} zone(s), ${result.created} creee(s), ${result.updated} mise(s) a jour`);
      setGeoJsonText('');
      await loadZones();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    }
  };

  const onGeoJsonFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      setGeoJsonText(text);
      setMessage(`Fichier charge: ${file.name}`);
    } catch {
      setError('Impossible de lire le fichier');
    }
  };

  const exportGeoJson = async () => {
    setError(null);
    setMessage(null);
    try {
      const geojson = await api<ZoneGeoJson>('/api/referentiels/zones/geojson');
      const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/geo+json' });
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = 'zones.geojson';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      setMessage('Export GeoJSON telecharge');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    }
  };

  return (
    <div className="grid" style={{ gap: 16 }}>
      {error && <div className="card" style={{ borderColor: '#b91c1c', color: '#b91c1c' }}>{error}</div>}
      {message && <div className="card" style={{ borderColor: '#15803d', color: '#166534' }}>{message}</div>}

      {isAdmin && (
        <form className="card" onSubmit={importGeoJson}>
          <h3>Import GeoJSON des zones (US1.2)</h3>
          <p style={{ marginTop: 8, marginBottom: 8 }}>
            Collez un <code>FeatureCollection</code> contenant des zones avec <code>properties.code</code>,
            <code>properties.libelle</code> et des geometries <code>Polygon</code>/<code>MultiPolygon</code>.
          </p>
          <textarea
            rows={12}
            placeholder="Collez ici le GeoJSON"
            value={geoJsonText}
            onChange={(event) => setGeoJsonText(event.target.value)}
            style={{ width: '100%' }}
            required
          />
          <div style={{ marginTop: 8 }}>
            <input type="file" accept=".json,.geojson,application/geo+json,application/json" onChange={onGeoJsonFileSelected} />
            <div className="hint">Ou chargez un fichier GeoJSON depuis votre poste.</div>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button className="btn" type="submit">Importer</button>
            <button className="btn secondary" type="button" onClick={exportGeoJson}>Exporter GeoJSON</button>
          </div>
        </form>
      )}

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead><tr><th>Code</th><th>Libelle</th><th>Coefficient</th><th>Description</th></tr></thead>
          <tbody>
            {rows.map((z) => (
              <tr key={z.id}><td>{z.code}</td><td>{z.libelle}</td><td>× {z.coefficient}</td><td>{z.description ?? '-'}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TypesTab() {
  const [rows, setRows] = useState<Type[]>([]);
  useEffect(() => { api<Type[]>('/api/referentiels/types').then(setRows); }, []);
  return (
    <div className="card" style={{ padding: 0 }}>
      <table className="table">
        <thead><tr><th>Code</th><th>Libelle</th><th>Categorie</th></tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}><td>{t.code}</td><td>{t.libelle}</td><td style={{ textTransform: 'capitalize' }}>{t.categorie}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExonerationsTab() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [rows, setRows] = useState<Exoneration[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<ExonerationForm>({
    type: 'droit',
    critere: '{"categorie":"enseigne","surface_max":7}',
    taux: '1',
    date_debut: '',
    date_fin: '',
    active: true,
  });

  const refresh = async () => {
    setError(null);
    try {
      const data = await api<Exoneration[]>('/api/referentiels/exonerations');
      setRows(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const critere = JSON.parse(form.critere);
      await api('/api/referentiels/exonerations', {
        method: 'POST',
        body: JSON.stringify({
          type: form.type,
          critere,
          taux: Number(form.taux),
          date_debut: form.date_debut || null,
          date_fin: form.date_fin || null,
          active: form.active,
        }),
      });
      setForm((prev) => ({ ...prev, critere: '{"categorie":"enseigne","surface_max":7}', taux: '1' }));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Critere JSON invalide');
    }
  };

  const remove = async (id: number) => {
    setError(null);
    try {
      await api(`/api/referentiels/exonerations/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    }
  };

  return (
    <div className="grid" style={{ gap: 16 }}>
      {error && <div className="card" style={{ borderColor: '#b91c1c', color: '#b91c1c' }}>{error}</div>}

      {isAdmin && (
        <form className="card" onSubmit={submit}>
          <h3>Nouvelle exoneration / abattement</h3>
          <div className="form-grid two" style={{ marginTop: 8 }}>
            <div>
              <label>Type</label>
              <select value={form.type} onChange={(e) => setForm((prev) => ({ ...prev, type: e.target.value as Exoneration['type'] }))}>
                <option value="droit">Droit</option>
                <option value="deliberee">Deliberee</option>
                <option value="eco">Eco</option>
              </select>
            </div>
            <div>
              <label>Taux (0 a 1)</label>
              <input type="number" step="0.01" min={0} max={1} value={form.taux} onChange={(e) => setForm((prev) => ({ ...prev, taux: e.target.value }))} required />
            </div>
            <div>
              <label>Date debut</label>
              <input type="date" value={form.date_debut} onChange={(e) => setForm((prev) => ({ ...prev, date_debut: e.target.value }))} />
            </div>
            <div>
              <label>Date fin</label>
              <input type="date" value={form.date_fin} onChange={(e) => setForm((prev) => ({ ...prev, date_fin: e.target.value }))} />
            </div>
          </div>
          <label style={{ marginTop: 8 }}>Critere (JSON)</label>
          <textarea rows={5} style={{ width: '100%' }} value={form.critere} onChange={(e) => setForm((prev) => ({ ...prev, critere: e.target.value }))} required />
          <label style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={form.active} onChange={(e) => setForm((prev) => ({ ...prev, active: e.target.checked }))} />
            Active
          </label>
          <div className="hint">Exemples criteres: {`{"categorie":"enseigne","surface_max":7}`}, {`{"assujetti_id":12,"annee_min":2026}`}</div>
          <div style={{ marginTop: 12 }}>
            <button className="btn" type="submit">Enregistrer</button>
          </div>
        </form>
      )}

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr><th>Type</th><th>Taux</th><th>Periode</th><th>Critere</th><th>Active</th>{isAdmin && <th>Action</th>}</tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.type}</td>
                <td>{Math.round(row.taux * 100)} %</td>
                <td>{row.date_debut || '-'} → {row.date_fin || '-'}</td>
                <td><code>{row.critere}</code></td>
                <td>{row.active ? 'Oui' : 'Non'}</td>
                {isAdmin && (
                  <td>
                    <button className="btn secondary" onClick={() => remove(row.id)}>Supprimer</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
