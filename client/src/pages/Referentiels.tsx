import { FormEvent, useEffect, useMemo, useState } from 'react';
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
}

interface Type {
  id: number;
  code: string;
  libelle: string;
  categorie: string;
}

export default function Referentiels() {
  const [tab, setTab] = useState<'bareme' | 'zones' | 'types'>('bareme');
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
      </div>
      {tab === 'bareme' && <BaremeTab />}
      {tab === 'zones' && <ZonesTab />}
      {tab === 'types' && <TypesTab />}
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
  const [rows, setRows] = useState<Zone[]>([]);
  useEffect(() => { api<Zone[]>('/api/referentiels/zones').then(setRows); }, []);
  return (
    <div className="card" style={{ padding: 0 }}>
      <table className="table">
        <thead><tr><th>Code</th><th>Libelle</th><th>Coefficient</th></tr></thead>
        <tbody>
          {rows.map((z) => (
            <tr key={z.id}><td>{z.code}</td><td>{z.libelle}</td><td>× {z.coefficient}</td></tr>
          ))}
        </tbody>
      </table>
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
