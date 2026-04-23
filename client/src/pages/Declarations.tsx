import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { formatEuro } from '../format';
import { useAuth } from '../auth';

interface Declaration {
  id: number;
  numero: string;
  annee: number;
  statut: string;
  alerte_gestionnaire: number;
  raison_sociale: string;
  identifiant_tlpe: string;
  montant_total: number | null;
  date_soumission: string | null;
}

export default function Declarations() {
  const { hasRole } = useAuth();
  const [rows, setRows] = useState<Declaration[]>([]);
  const [annee, setAnnee] = useState<string>(String(new Date().getFullYear()));
  const [statut, setStatut] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    const params = new URLSearchParams();
    if (annee) params.set('annee', annee);
    if (statut) params.set('statut', statut);
    api<Declaration[]>(`/api/declarations?${params}`).then(setRows).catch((e) => setErr((e as Error).message));
  };
  useEffect(load, [annee, statut]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Declarations</h1>
          <p>Campagne declarative annuelle : brouillons, soumises, validees.</p>
        </div>
      </div>

      {err && <div className="alert error">{err}</div>}

      <div className="toolbar">
        <select value={annee} onChange={(e) => setAnnee(e.target.value)}>
          <option value="">Toutes annees</option>
          <option>{new Date().getFullYear() - 1}</option>
          <option>{new Date().getFullYear()}</option>
          <option>{new Date().getFullYear() + 1}</option>
        </select>
        <select value={statut} onChange={(e) => setStatut(e.target.value)}>
          <option value="">Tous statuts</option>
          <option value="brouillon">Brouillon</option>
          <option value="soumise">Soumise</option>
          <option value="validee">Validee</option>
          <option value="rejetee">Rejetee</option>
        </select>
        <div className="spacer" />
        <span style={{ color: 'var(--c-muted)', fontSize: 13 }}>{rows.length} resultat(s)</span>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Numero</th><th>Annee</th><th>Assujetti</th>
              <th>Statut</th><th>Alertes</th><th>Montant</th><th>Soumise le</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={8} className="empty">
                Aucune declaration.
                {hasRole('admin', 'gestionnaire') && (
                  <div style={{ marginTop: 8 }}>Ouvrez une declaration depuis la fiche d'un assujetti.</div>
                )}
              </td></tr>
            ) : rows.map((d) => (
              <tr key={d.id}>
                <td>{d.numero}</td>
                <td>{d.annee}</td>
                <td>{d.raison_sociale}</td>
                <td><StatutBadge statut={d.statut} /></td>
                <td>{d.alerte_gestionnaire ? <span className="badge warn">Alerte</span> : <span style={{ color: 'var(--c-muted)' }}>-</span>}</td>
                <td>{formatEuro(d.montant_total)}</td>
                <td>{d.date_soumission ?? '-'}</td>
                <td><Link to={`/declarations/${d.id}`}>Ouvrir</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function StatutBadge({ statut }: { statut: string }) {
  const cls =
    statut === 'validee' ? 'success'
    : statut === 'soumise' ? 'info'
    : statut === 'rejetee' ? 'danger'
    : statut === 'brouillon' ? '' : 'warn';
  return <span className={`badge ${cls}`}>{statut}</span>;
}
