import { FormEvent, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { api } from '../api';
import { formatEuro } from '../format';
import { useAuth } from '../auth';

interface Campagne {
  id: number;
  annee: number;
  date_ouverture: string;
  date_limite_declaration: string;
  date_cloture: string;
  relance_j7_courrier: number;
  statut: 'brouillon' | 'ouverte' | 'cloturee';
  created_by_email?: string;
  created_at: string;
}

interface CampagneSummary {
  campagne: Campagne;
  jobs: Array<{
    id: number;
    type: 'invitation' | 'relance' | 'cloture';
    statut: 'pending' | 'done' | 'failed';
    payload: string | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
  }>;
  mises_en_demeure: number;
  declarations: Array<{ statut: string; total: number }>;
}

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
  const [tab, setTab] = useState<'campagnes' | 'bareme' | 'zones' | 'types' | 'exonerations'>('campagnes');
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Referentiels</h1>
          <p>Bareme tarifaire, zones geographiques, types de dispositifs.</p>
        </div>
      </div>
      <div className="toolbar">
        <button className={`btn ${tab === 'campagnes' ? '' : 'secondary'}`} onClick={() => setTab('campagnes')}>Campagnes</button>
        <button className={`btn ${tab === 'bareme' ? '' : 'secondary'}`} onClick={() => setTab('bareme')}>Bareme</button>
        <button className={`btn ${tab === 'zones' ? '' : 'secondary'}`} onClick={() => setTab('zones')}>Zones</button>
        <button className={`btn ${tab === 'types' ? '' : 'secondary'}`} onClick={() => setTab('types')}>Types de dispositifs</button>
        <button className={`btn ${tab === 'exonerations' ? '' : 'secondary'}`} onClick={() => setTab('exonerations')}>Exonerations</button>
      </div>
      {tab === 'campagnes' && <CampagnesTab />}
      {tab === 'bareme' && <BaremeTab />}
      {tab === 'zones' && <ZonesTab />}
      {tab === 'types' && <TypesTab />}
      {tab === 'exonerations' && <ExonerationsTab />}
    </>
  );
}

function CampagnesTab() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'gestionnaire';

  const [rows, setRows] = useState<Campagne[]>([]);
  const [activeCampagneId, setActiveCampagneId] = useState<number | null>(null);
  const [selectedCampagneId, setSelectedCampagneId] = useState<number | null>(null);
  const [summary, setSummary] = useState<CampagneSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    annee: new Date().getFullYear(),
    date_ouverture: `${new Date().getFullYear()}-01-01`,
    date_limite_declaration: `${new Date().getFullYear()}-03-01`,
    date_cloture: `${new Date().getFullYear()}-03-02`,
    relance_j7_courrier: false,
  });

  async function refreshCampagnes(preferredCampagneId?: number | null) {
    setLoading(true);
    setError(null);
    try {
      const [campagnes, active] = await Promise.all([
        api<Campagne[]>('/api/campagnes'),
        api<{ campagne: Campagne | null }>('/api/campagnes/active'),
      ]);
      setRows(campagnes);
      setActiveCampagneId(active.campagne?.id ?? null);

      const preferred = preferredCampagneId ?? selectedCampagneId;
      const nextSelected = preferred && campagnes.some((c) => c.id === preferred) ? preferred : campagnes[0]?.id ?? null;
      setSelectedCampagneId(nextSelected);
      if (nextSelected) {
        const s = await api<CampagneSummary>(`/api/campagnes/${nextSelected}/summary`);
        setSummary(s);
      } else {
        setSummary(null);
      }
    } catch (e) {
      setSummary(null);
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  }

  async function loadSummary(campagneId: number) {
    try {
      const s = await api<CampagneSummary>(`/api/campagnes/${campagneId}/summary`);
      setSummary(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    }
  }

  useEffect(() => {
    refreshCampagnes();
  }, []);

  async function createCampagne(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api('/api/campagnes', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setMessage(`Campagne ${form.annee} creee`);
      await refreshCampagnes();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    }
  }

  async function openSelected(campagneId = selectedCampagneId) {
    if (!campagneId) return;
    setError(null);
    setMessage(null);
    try {
      const result = await api<{ ok: true; annee: number; invitations_preparees: number }>(`/api/campagnes/${campagneId}/open`, {
        method: 'POST',
      });
      setMessage(`Campagne ${result.annee} ouverte. Invitations preparees: ${result.invitations_preparees}`);
      await refreshCampagnes(campagneId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    }
  }

  async function closeSelected(campagneId = selectedCampagneId) {
    if (!campagneId) return;
    setError(null);
    setMessage(null);
    try {
      const result = await api<{ ok: true; annee: number; brouillons_bascules: number }>(`/api/campagnes/${campagneId}/close`, {
        method: 'POST',
      });
      setMessage(`Campagne ${result.annee} cloturee. Brouillons bascules: ${result.brouillons_bascules}`);
      await refreshCampagnes(campagneId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    }
  }

  const selectedCampagne = useMemo(
    () => rows.find((c) => c.id === selectedCampagneId) ?? null,
    [rows, selectedCampagneId],
  );

  const canOpen = selectedCampagne?.statut === 'brouillon';
  const canClose = selectedCampagne?.statut === 'ouverte';

  return (
    <div className="grid" style={{ gap: 16 }}>
      {error && <div className="card" style={{ borderColor: '#b91c1c', color: '#b91c1c' }}>{error}</div>}
      {message && <div className="card" style={{ borderColor: '#15803d', color: '#166534' }}>{message}</div>}

      {isAdmin && (
        <form className="card" onSubmit={createCampagne}>
          <h3>Creer une campagne declarative annuelle</h3>
          <div className="form-grid two" style={{ marginTop: 8 }}>
            <div>
              <label>Annee fiscale</label>
              <input
                type="number"
                min={2008}
                max={2100}
                value={form.annee}
                onChange={(e) => setForm((prev) => ({ ...prev, annee: Number(e.target.value) }))}
                required
              />
            </div>
            <div>
              <label>Date d'ouverture</label>
              <input
                type="date"
                value={form.date_ouverture}
                onChange={(e) => setForm((prev) => ({ ...prev, date_ouverture: e.target.value }))}
                required
              />
            </div>
            <div>
              <label>Date limite de declaration</label>
              <input
                type="date"
                value={form.date_limite_declaration}
                onChange={(e) => setForm((prev) => ({ ...prev, date_limite_declaration: e.target.value }))}
                required
              />
            </div>
            <div>
              <label>Date de cloture</label>
              <input
                type="date"
                value={form.date_cloture}
                onChange={(e) => setForm((prev) => ({ ...prev, date_cloture: e.target.value }))}
                required
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                id="relance-j7-courrier"
                type="checkbox"
                checked={form.relance_j7_courrier}
                onChange={(e) => setForm((prev) => ({ ...prev, relance_j7_courrier: e.target.checked }))}
              />
              <label htmlFor="relance-j7-courrier">Generer un courrier PDF postal en relance J-7</label>
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <button className="btn" type="submit">Creer la campagne</button>
          </div>
        </form>
      )}

      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: 12, borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>Campagnes declaratives</strong>
          {loading && <span>Chargement...</span>}
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Annee</th>
              <th>Ouverture</th>
              <th>Limite declaration</th>
              <th>Cloture</th>
              <th>Statut</th>
              <th>Relance J-7 courrier</th>
              <th>Creee par</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} style={{ backgroundColor: selectedCampagneId === c.id ? '#f8fafc' : undefined }}>
                <td>{c.annee}</td>
                <td>{c.date_ouverture}</td>
                <td>{c.date_limite_declaration}</td>
                <td>{c.date_cloture}</td>
                <td>
                  {c.statut}
                  {activeCampagneId === c.id ? ' (active)' : ''}
                </td>
                <td>{c.relance_j7_courrier ? 'Oui' : 'Non'}</td>
                <td>{c.created_by_email ?? '-'}</td>
                <td style={{ display: 'flex', gap: 8 }}>
                  <button className="btn secondary" onClick={() => { setSelectedCampagneId(c.id); loadSummary(c.id); }}>
                    Voir
                  </button>
                  {isAdmin && (
                    <>
                      <button className="btn secondary" disabled={c.statut !== 'brouillon'} onClick={async () => { setSelectedCampagneId(c.id); await openSelected(c.id); }}>
                        Ouvrir
                      </button>
                      <button className="btn secondary" disabled={c.statut !== 'ouverte'} onClick={async () => { setSelectedCampagneId(c.id); await closeSelected(c.id); }}>
                        Cloturer
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedCampagne && isAdmin && (
        <div className="card" style={{ display: 'flex', gap: 8 }}>
          <button className="btn" disabled={!canOpen} onClick={() => { void openSelected(); }}>Ouvrir la campagne selectionnee</button>
          <button className="btn secondary" disabled={!canClose} onClick={() => { void closeSelected(); }}>Cloturer la campagne selectionnee</button>
        </div>
      )}

      {summary && (
        <div className="grid cols-2" style={{ gap: 16 }}>
          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: 12, borderBottom: '1px solid #e5e7eb' }}>
              <strong>Jobs techniques ({summary.campagne.annee})</strong>
            </div>
            <table className="table">
              <thead>
                <tr><th>Type</th><th>Statut</th><th>Cree le</th><th>Payload</th></tr>
              </thead>
              <tbody>
                {summary.jobs.length === 0 ? (
                  <tr><td colSpan={4}>Aucun job</td></tr>
                ) : summary.jobs.map((job) => (
                  <tr key={job.id}>
                    <td>{job.type}</td>
                    <td>{job.statut}</td>
                    <td>{new Date(job.created_at).toLocaleString()}</td>
                    <td><code>{job.payload ?? '-'}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <strong>Etat des declarations ({summary.campagne.annee})</strong>
            <ul style={{ marginTop: 8 }}>
              {summary.declarations.map((item) => (
                <li key={item.statut}>{item.statut}: <strong>{item.total}</strong></li>
              ))}
            </ul>
            <p style={{ marginTop: 12 }}>
              Mises en demeure preparees: <strong>{summary.mises_en_demeure}</strong>
            </p>
          </div>
        </div>
      )}
    </div>
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
