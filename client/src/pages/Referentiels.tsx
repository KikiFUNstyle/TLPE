import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatEuro } from '../format';

interface Bareme {
  id: number;
  annee: number;
  categorie: string;
  surface_min: number;
  surface_max: number | null;
  tarif_m2: number | null;
  tarif_fixe: number | null;
  exonere: number;
  libelle: string;
}
interface Zone { id: number; code: string; libelle: string; coefficient: number; }
interface Type { id: number; code: string; libelle: string; categorie: string; }

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
  const [rows, setRows] = useState<Bareme[]>([]);
  useEffect(() => { api<Bareme[]>('/api/referentiels/baremes').then(setRows); }, []);
  return (
    <div className="card" style={{ padding: 0 }}>
      <table className="table">
        <thead>
          <tr><th>Annee</th><th>Categorie</th><th>Tranche</th><th>Tarif/m²</th><th>Tarif fixe</th><th>Exonere</th></tr>
        </thead>
        <tbody>
          {rows.map((b) => (
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
