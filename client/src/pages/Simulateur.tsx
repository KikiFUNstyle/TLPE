import { FormEvent, useState } from 'react';
import { api } from '../api';
import { formatEuro } from '../format';

interface CalcResult {
  montant: number;
  detail: {
    surface_unitaire: number;
    nombre_faces: number;
    surface_effective: number;
    categorie: string;
    tranche_libelle: string;
    tarif_m2: number | null;
    tarif_fixe: number | null;
    coefficient_zone: number;
    jours_exploitation: number;
    prorata: number;
    exonere: boolean;
    sous_total: number;
    montant_arrondi: number;
  };
}

export default function Simulateur() {
  const [form, setForm] = useState({
    annee: new Date().getFullYear(),
    categorie: 'publicitaire' as 'publicitaire' | 'preenseigne' | 'enseigne',
    surface: 4,
    nombre_faces: 1,
    coefficient_zone: 1,
    date_pose: '',
    date_depose: '',
  });
  const [result, setResult] = useState<CalcResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setResult(null);
    setLoading(true);
    try {
      const r = await api<CalcResult>('/api/simulateur', {
        method: 'POST',
        body: JSON.stringify({
          annee: Number(form.annee),
          categorie: form.categorie,
          surface: Number(form.surface),
          nombre_faces: Number(form.nombre_faces),
          coefficient_zone: Number(form.coefficient_zone),
          date_pose: form.date_pose || null,
          date_depose: form.date_depose || null,
        }),
      });
      setResult(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const upd = (k: string, v: string | number) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Simulateur TLPE</h1>
          <p>Calcul prévisionnel conforme aux articles L2333-6 à L2333-16 du CGCT. Resultat indicatif non opposable.</p>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <form className="form" onSubmit={submit}>
            <div className="form-row">
              <div>
                <label>Annee</label>
                <select value={form.annee} onChange={(e) => upd('annee', Number(e.target.value))}>
                  <option>{new Date().getFullYear() - 1}</option>
                  <option>{new Date().getFullYear()}</option>
                  <option>{new Date().getFullYear() + 1}</option>
                </select>
              </div>
              <div>
                <label>Categorie</label>
                <select value={form.categorie} onChange={(e) => upd('categorie', e.target.value)}>
                  <option value="publicitaire">Dispositif publicitaire</option>
                  <option value="preenseigne">Preenseigne</option>
                  <option value="enseigne">Enseigne</option>
                </select>
              </div>
            </div>
            <div className="form-row cols-3">
              <div>
                <label>Surface (m²)</label>
                <input type="number" step="0.01" min="0.01" value={form.surface} onChange={(e) => upd('surface', e.target.value)} required />
              </div>
              <div>
                <label>Nombre de faces</label>
                <select value={form.nombre_faces} onChange={(e) => upd('nombre_faces', Number(e.target.value))}>
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                </select>
              </div>
              <div>
                <label>Coef. zone</label>
                <input type="number" step="0.1" min="0.1" value={form.coefficient_zone} onChange={(e) => upd('coefficient_zone', e.target.value)} />
              </div>
            </div>
            <div className="form-row">
              <div>
                <label>Date de pose</label>
                <input type="date" value={form.date_pose} onChange={(e) => upd('date_pose', e.target.value)} />
                <div className="hint">Si vide : 1er janvier</div>
              </div>
              <div>
                <label>Date de depose</label>
                <input type="date" value={form.date_depose} onChange={(e) => upd('date_depose', e.target.value)} />
                <div className="hint">Si vide : 31 decembre</div>
              </div>
            </div>
            <button type="submit" className="btn" disabled={loading}>{loading ? 'Calcul...' : 'Calculer'}</button>
          </form>

          {err && <div className="alert error" style={{ marginTop: 16 }}>{err}</div>}
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Resultat</h3>
          {!result ? (
            <div className="empty">Saisissez les parametres et cliquez sur Calculer.</div>
          ) : (
            <div className="calc-detail">
              <dl>
                <dt>Tranche du bareme</dt>
                <dd>{result.detail.tranche_libelle}</dd>
                <dt>Surface effective</dt>
                <dd>{result.detail.surface_effective} m² ({result.detail.surface_unitaire} × {result.detail.nombre_faces} face{result.detail.nombre_faces > 1 ? 's' : ''})</dd>
                <dt>Tarif applique</dt>
                <dd>
                  {result.detail.tarif_fixe !== null
                    ? `${result.detail.tarif_fixe} EUR (forfait)`
                    : result.detail.tarif_m2 !== null
                      ? `${result.detail.tarif_m2} EUR/m²`
                      : '-'}
                </dd>
                <dt>Coefficient zone</dt>
                <dd>× {result.detail.coefficient_zone}</dd>
                <dt>Prorata temporis</dt>
                <dd>{result.detail.jours_exploitation} jours ({(result.detail.prorata * 100).toFixed(2)}%)</dd>
                <dt>Sous-total (avant arrondi)</dt>
                <dd>{formatEuro(result.detail.sous_total)}</dd>
                {result.detail.exonere && <><dt>Exoneration</dt><dd>Oui</dd></>}
              </dl>
              <div className="total">Montant TLPE : {formatEuro(result.montant)}</div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
