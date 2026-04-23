import { FormEvent, useEffect, useState } from 'react';
import { api, apiBlob } from '../api';
import { formatDate, formatEuro } from '../format';
import { useAuth } from '../auth';
import { buildBordereauFilename, buildBordereauPath, canExportBordereau } from './titresBordereau';

interface Titre {
  id: number;
  numero: string;
  annee: number;
  raison_sociale: string;
  identifiant_tlpe: string;
  montant: number;
  montant_paye: number;
  date_emission: string;
  date_echeance: string;
  statut: string;
}

export default function Titres() {
  const { hasRole } = useAuth();
  const [rows, setRows] = useState<Titre[]>([]);
  const [annee, setAnnee] = useState<string>('');
  const [statut, setStatut] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [exporting, setExporting] = useState<null | 'pdf' | 'xlsx'>(null);
  const [paiementFor, setPaiementFor] = useState<Titre | null>(null);

  const load = () => {
    const params = new URLSearchParams();
    if (annee) params.set('annee', annee);
    if (statut) params.set('statut', statut);
    api<Titre[]>(`/api/titres?${params}`)
      .then((data) => {
        setRows(data);
        setErr(null);
      })
      .catch((e) => setErr((e as Error).message));
  };
  useEffect(load, [annee, statut]);

  const canManageTitres = hasRole('admin', 'financier');
  const canExport = canExportBordereau({ annee, canManage: canManageTitres });

  const downloadBordereau = async (format: 'pdf' | 'xlsx') => {
    if (!canExport) return;
    setExporting(format);
    setErr(null);
    setInfo(null);
    try {
      const blob = await apiBlob(buildBordereauPath(annee, format));
      const href = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = buildBordereauFilename(annee, format);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(href);
      setInfo(`Bordereau ${format.toUpperCase()} téléchargé.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setExporting(null);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Titres de recettes</h1>
          <p>Titres emis, paiements et etat de recouvrement.</p>
        </div>
      </div>

      {err && <div className="alert error">{err}</div>}
      {info && <div className="alert info">{info}</div>}

      <div className="toolbar">
        <select value={annee} onChange={(e) => setAnnee(e.target.value)}>
          <option value="">Toutes annees</option>
          <option>{new Date().getFullYear() - 1}</option>
          <option>{new Date().getFullYear()}</option>
        </select>
        <select value={statut} onChange={(e) => setStatut(e.target.value)}>
          <option value="">Tous statuts</option>
          <option value="emis">Emis</option>
          <option value="paye_partiel">Paye partiel</option>
          <option value="paye">Paye</option>
          <option value="impaye">Impaye</option>
          <option value="mise_en_demeure">Mise en demeure</option>
        </select>
        <div className="spacer" />
        {canManageTitres && (
          <>
            <button
              className="btn secondary"
              disabled={!canExport || exporting !== null}
              onClick={() => {
                void downloadBordereau('pdf');
              }}
              title={canExport ? 'Exporter le bordereau PDF' : 'Sélectionner une année pour exporter le bordereau'}
            >
              {exporting === 'pdf' ? 'Export PDF...' : 'Bordereau PDF'}
            </button>
            <button
              className="btn secondary"
              disabled={!canExport || exporting !== null}
              onClick={() => {
                void downloadBordereau('xlsx');
              }}
              title={canExport ? 'Exporter le bordereau Excel' : 'Sélectionner une année pour exporter le bordereau'}
            >
              {exporting === 'xlsx' ? 'Export Excel...' : 'Bordereau Excel'}
            </button>
          </>
        )}
        <span style={{ color: 'var(--c-muted)', fontSize: 13 }}>{rows.length} resultat(s)</span>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Numero</th><th>Annee</th><th>Assujetti</th>
              <th>Montant</th><th>Paye</th><th>Solde</th>
              <th>Emission</th><th>Echeance</th><th>Statut</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={10} className="empty">Aucun titre.</td></tr>
            ) : rows.map((t) => (
              <tr key={t.id}>
                <td>{t.numero}</td>
                <td>{t.annee}</td>
                <td>{t.raison_sociale}</td>
                <td>{formatEuro(t.montant)}</td>
                <td>{formatEuro(t.montant_paye)}</td>
                <td>{formatEuro(t.montant - t.montant_paye)}</td>
                <td>{formatDate(t.date_emission)}</td>
                <td>{formatDate(t.date_echeance)}</td>
                <td><span className={`badge ${t.statut === 'paye' ? 'success' : t.statut === 'emis' ? 'info' : 'warn'}`}>{t.statut}</span></td>
                <td>
                  <a className="btn small secondary" href={`/api/titres/${t.id}/pdf`} target="_blank" rel="noreferrer">PDF</a>
                  {hasRole('admin', 'financier') && t.statut !== 'paye' && (
                    <button className="btn small" style={{ marginLeft: 4 }} onClick={() => setPaiementFor(t)}>Paiement</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {paiementFor && <PaiementModal titre={paiementFor} onClose={() => setPaiementFor(null)} onDone={() => { setPaiementFor(null); load(); }} />}
    </>
  );
}

function PaiementModal({ titre, onClose, onDone }: { titre: Titre; onClose: () => void; onDone: () => void }) {
  const reste = titre.montant - titre.montant_paye;
  const [form, setForm] = useState({
    montant: reste,
    date_paiement: new Date().toISOString().slice(0, 10),
    modalite: 'virement',
    reference: '',
  });
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      await api(`/api/titres/${titre.id}/paiements`, {
        method: 'POST',
        body: JSON.stringify({ ...form, montant: Number(form.montant) }),
      });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Enregistrer un paiement</h2>
        <p style={{ color: 'var(--c-muted)', fontSize: 13 }}>Titre {titre.numero} - Solde du : {formatEuro(reste)}</p>
        {err && <div className="alert error">{err}</div>}
        <form className="form" onSubmit={submit}>
          <div className="form-row">
            <div>
              <label>Montant (EUR)</label>
              <input type="number" step="0.01" min="0.01" max={reste} value={form.montant} onChange={(e) => setForm((f) => ({ ...f, montant: Number(e.target.value) }))} required />
            </div>
            <div>
              <label>Date du paiement</label>
              <input type="date" value={form.date_paiement} onChange={(e) => setForm((f) => ({ ...f, date_paiement: e.target.value }))} required />
            </div>
          </div>
          <div className="form-row">
            <div>
              <label>Modalite</label>
              <select value={form.modalite} onChange={(e) => setForm((f) => ({ ...f, modalite: e.target.value }))}>
                <option value="virement">Virement</option>
                <option value="cheque">Cheque</option>
                <option value="tipi">Paiement en ligne (Tipi)</option>
                <option value="sepa">Prelevement SEPA</option>
                <option value="numeraire">Numeraire (regie)</option>
              </select>
            </div>
            <div>
              <label>Reference</label>
              <input value={form.reference} onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} />
            </div>
          </div>
          <div className="actions">
            <button type="button" className="btn secondary" onClick={onClose}>Annuler</button>
            <button type="submit" className="btn" disabled={loading}>{loading ? 'Enregistrement...' : 'Enregistrer'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
