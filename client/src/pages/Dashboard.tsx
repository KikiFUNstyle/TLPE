import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatEuro, formatPct } from '../format';

interface DashboardData {
  annee: number;
  financier: {
    montant_emis_n: number;
    montant_emis_nm1: number;
    montant_recouvre: number;
    taux_recouvrement: number;
    montant_impaye: number;
    montant_litige: number;
    evolution_n_nm1: number | null;
  };
  operationnel: {
    assujettis_actifs: number;
    dispositifs_total: number;
    declarations_recues: number;
    declarations_attendues: number;
    taux_declaration: number;
    contentieux_ouverts: number;
  };
  repartition_categories: Array<{ categorie: string; nb: number }>;
  derniers_titres: Array<{
    id: number;
    numero: string;
    raison_sociale: string;
    montant: number;
    date_emission: string;
    statut: string;
  }>;
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<DashboardData>('/api/dashboard').then(setData).catch((e) => setErr((e as Error).message));
  }, []);

  if (err) return <div className="alert error">{err}</div>;
  if (!data) return <div>Chargement...</div>;

  const { financier, operationnel } = data;
  const totalCategories = data.repartition_categories.reduce((s, r) => s + r.nb, 0);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Tableau de bord {data.annee}</h1>
          <p>Synthese financiere et operationnelle du cycle TLPE en cours.</p>
        </div>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <div className="card kpi">
          <div className="label">Montant emis {data.annee}</div>
          <div className="value">{formatEuro(financier.montant_emis_n)}</div>
          <div className="meta">
            {financier.evolution_n_nm1 !== null
              ? `Evolution : ${(financier.evolution_n_nm1 * 100).toFixed(1)}% vs N-1`
              : `N-1 : ${formatEuro(financier.montant_emis_nm1)}`}
          </div>
        </div>
        <div className="card kpi success">
          <div className="label">Recouvre</div>
          <div className="value">{formatEuro(financier.montant_recouvre)}</div>
          <div className="meta">Taux : {formatPct(financier.taux_recouvrement)}</div>
        </div>
        <div className="card kpi warning">
          <div className="label">Impayes &gt; echeance</div>
          <div className="value">{formatEuro(financier.montant_impaye)}</div>
          <div className="meta">Titres en attente de paiement</div>
        </div>
        <div className="card kpi accent">
          <div className="label">Montant en litige</div>
          <div className="value">{formatEuro(financier.montant_litige)}</div>
          <div className="meta">{operationnel.contentieux_ouverts} dossier(s) ouvert(s)</div>
        </div>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <div className="card kpi">
          <div className="label">Assujettis actifs</div>
          <div className="value">{operationnel.assujettis_actifs}</div>
          <div className="meta">Fichier contribuables</div>
        </div>
        <div className="card kpi">
          <div className="label">Dispositifs</div>
          <div className="value">{operationnel.dispositifs_total}</div>
          <div className="meta">Enseignes, preenseignes, publicites</div>
        </div>
        <div className="card kpi">
          <div className="label">Declarations recues</div>
          <div className="value">
            {operationnel.declarations_recues} / {operationnel.declarations_attendues}
          </div>
          <div className="meta">Taux : {formatPct(operationnel.taux_declaration)}</div>
        </div>
        <div className="card kpi">
          <div className="label">Contentieux ouverts</div>
          <div className="value">{operationnel.contentieux_ouverts}</div>
          <div className="meta">Dossiers en cours d'instruction</div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Repartition par categorie</h3>
          {totalCategories === 0 ? (
            <div className="empty">Aucun dispositif enregistre.</div>
          ) : (
            <div>
              {data.repartition_categories.map((r) => (
                <div key={r.categorie} style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span style={{ textTransform: 'capitalize' }}>{r.categorie}</span>
                    <span>{r.nb} ({formatPct(r.nb / totalCategories)})</span>
                  </div>
                  <div style={{ height: 8, background: '#eef0fb', borderRadius: 4, marginTop: 4 }}>
                    <div
                      style={{
                        width: `${(r.nb / totalCategories) * 100}%`,
                        height: '100%',
                        background: 'var(--c-primary)',
                        borderRadius: 4,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Derniers titres emis</h3>
          {data.derniers_titres.length === 0 ? (
            <div className="empty">Aucun titre emis.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Numero</th>
                  <th>Assujetti</th>
                  <th>Montant</th>
                  <th>Statut</th>
                </tr>
              </thead>
              <tbody>
                {data.derniers_titres.map((t) => (
                  <tr key={t.id}>
                    <td>{t.numero}</td>
                    <td>{t.raison_sociale}</td>
                    <td>{formatEuro(t.montant)}</td>
                    <td><StatutBadge statut={t.statut} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

function StatutBadge({ statut }: { statut: string }) {
  const cls =
    statut === 'paye' ? 'success'
    : statut === 'emis' ? 'info'
    : statut === 'paye_partiel' ? 'warn'
    : statut === 'impaye' || statut === 'mise_en_demeure' ? 'danger'
    : '';
  return <span className={`badge ${cls}`}>{statut.replace('_', ' ')}</span>;
}
