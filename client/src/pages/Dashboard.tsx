import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { formatEuro, formatPct } from '../format';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export function formatContentieuxAlertMeta(total: number, overdue: number) {
  return {
    upcoming: `${total} alerte(s) <= J-30`,
    overdue: `${overdue} dossier(s) en dépassement`,
  };
}

interface DashboardData {
  annee: number;
  campagne: {
    id: number;
    date_ouverture: string;
    date_limite_declaration: string;
  } | null;
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
    declarations_soumises: number;
    declarations_validees: number;
    declarations_rejetees: number;
    taux_declaration: number;
    evolution_taux_vs_nm1: number | null;
    contentieux_ouverts: number;
    contentieux_alertes_total: number;
    contentieux_alertes_overdue: number;
  };
  drilldown: {
    by_zone: Array<{
      label: string;
      assujettis_attendus: number;
      declarations_soumises: number;
      declarations_validees: number;
      declarations_rejetees: number;
      taux_declaration: number;
    }>;
    by_type_assujetti: Array<{
      label: string;
      assujettis_attendus: number;
      declarations_soumises: number;
      declarations_validees: number;
      declarations_rejetees: number;
      taux_declaration: number;
    }>;
  };
  evolution_journaliere: Array<{ date: string; soumissions_jour: number; cumul_soumissions: number }>;
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
  const [drilldownMode, setDrilldownMode] = useState<'zone' | 'type'>('zone');

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const payload = await api<DashboardData>('/api/dashboard');
        if (!cancelled) {
          setData(payload);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    };

    load();
    const timer = window.setInterval(load, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (err) return <div className="alert error">{err}</div>;
  if (!data) return <div>Chargement...</div>;

  const { financier, operationnel } = data;
  const totalCategories = data.repartition_categories.reduce((s, r) => s + r.nb, 0);
  const contentieuxAlertMeta = formatContentieuxAlertMeta(
    operationnel.contentieux_alertes_total,
    operationnel.contentieux_alertes_overdue,
  );
  const evolutionTauxLabel =
    operationnel.evolution_taux_vs_nm1 === null
      ? 'Evolution N-1 indisponible'
      : `Evolution: ${(operationnel.evolution_taux_vs_nm1 * 100).toFixed(1)} pts vs N-1`;

  const drilldownRows = drilldownMode === 'zone' ? data.drilldown.by_zone : data.drilldown.by_type_assujetti;

  const chartData = useMemo(
    () =>
      data.evolution_journaliere.map((row) => ({
        ...row,
        label: row.date.slice(5),
      })),
    [data.evolution_journaliere],
  );

  const chartEmpty = chartData.every((row) => row.cumul_soumissions === 0);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Tableau de bord {data.annee}</h1>
          <p>Synthese financiere et operationnelle du cycle TLPE en cours.</p>
          {data.campagne && (
            <p style={{ marginTop: 6, color: '#475569' }}>
              Campagne #{data.campagne.id} du {data.campagne.date_ouverture} au {data.campagne.date_limite_declaration}
            </p>
          )}
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
          <div className="meta">{contentieuxAlertMeta.upcoming}</div>
          <div className="meta">{contentieuxAlertMeta.overdue}</div>
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
          <div className="value">{operationnel.declarations_recues} / {operationnel.declarations_attendues}</div>
          <div className="meta">Soumises: {operationnel.declarations_soumises}</div>
          <div className="meta">Validees: {operationnel.declarations_validees}</div>
          <div className="meta">Rejetees: {operationnel.declarations_rejetees}</div>
          <div className="meta">Taux: {formatPct(operationnel.taux_declaration)} — {evolutionTauxLabel}</div>
        </div>
        <div className="card kpi">
          <div className="label">Contentieux ouverts</div>
          <div className="value">{operationnel.contentieux_ouverts}</div>
          <div className="meta">Dossiers en cours d'instruction</div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Evolution journaliere des declarations</h3>
          {chartEmpty ? (
            <div className="empty">Aucune soumission sur la campagne.</div>
          ) : (
            <div style={{ width: '100%', height: 260 }}>
              <ResponsiveContainer>
                <AreaChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="tlpeCumul" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#4f46e5" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="label" minTickGap={24} />
                  <YAxis allowDecimals={false} />
                  <Tooltip
                    formatter={(value: number, key: string) => {
                      if (key === 'cumul_soumissions') return [`${value}`, 'Cumul soumissions'];
                      return [`${value}`, 'Soumissions jour'];
                    }}
                    labelFormatter={(label: string) => `Date: ${label}`}
                  />
                  <Area
                    type="monotone"
                    dataKey="cumul_soumissions"
                    stroke="#4f46e5"
                    strokeWidth={2}
                    fill="url(#tlpeCumul)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <h3 style={{ margin: 0 }}>Drilldown declarations</h3>
            <div style={{ display: 'inline-flex', gap: 8 }}>
              <button
                className="btn"
                onClick={() => setDrilldownMode('zone')}
                style={drilldownMode === 'zone' ? { background: 'var(--c-primary)', color: '#fff', borderColor: 'var(--c-primary)' } : {}}
              >
                Par zone
              </button>
              <button
                className="btn"
                onClick={() => setDrilldownMode('type')}
                style={drilldownMode === 'type' ? { background: 'var(--c-primary)', color: '#fff', borderColor: 'var(--c-primary)' } : {}}
              >
                Par type d'assujetti
              </button>
            </div>
          </div>

          {drilldownRows.length === 0 ? (
            <div className="empty" style={{ marginTop: 12 }}>Aucune donnee disponible.</div>
          ) : (
            <table className="table" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>{drilldownMode === 'zone' ? 'Zone' : "Type d'assujetti"}</th>
                  <th>Attendus</th>
                  <th>Soumises</th>
                  <th>Validees</th>
                  <th>Rejetees</th>
                  <th>Taux</th>
                </tr>
              </thead>
              <tbody>
                {drilldownRows.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    <td>{row.assujettis_attendus}</td>
                    <td>{row.declarations_soumises}</td>
                    <td>{row.declarations_validees}</td>
                    <td>{row.declarations_rejetees}</td>
                    <td>{formatPct(row.taux_declaration)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

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
