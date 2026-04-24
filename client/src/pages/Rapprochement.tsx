import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { formatDate, formatEuro } from '../format';

type StatementFormat = 'csv' | 'ofx' | 'mt940';

type DateFormat = 'auto' | 'yyyy-mm-dd' | 'dd/mm/yyyy' | 'yyyymmdd';

export interface ReleveBancaire {
  id: number;
  format: StatementFormat;
  fichier_nom: string;
  compte_bancaire: string | null;
  date_debut: string | null;
  date_fin: string | null;
  imported_at: string;
  imported_by: number | null;
  lignes_total: number;
  lignes_non_rapprochees: number;
}

export interface LigneNonRapprochee {
  id: number;
  releve_id: number;
  date: string;
  libelle: string;
  montant: number;
  reference: string | null;
  transaction_id: string;
  rapproche: number;
  paiement_id: number | null;
  raw_data: string | null;
}

export interface RapprochementPayload {
  releves: ReleveBancaire[];
  lignes_non_rapprochees: LigneNonRapprochee[];
}

interface CsvConfigState {
  delimiter: string;
  dateColumn: string;
  labelColumn: string;
  amountColumn: string;
  referenceColumn: string;
  transactionIdColumn: string;
  debitColumn: string;
  creditColumn: string;
  dateFormat: DateFormat;
}

interface ImportSummary {
  releve: ReleveBancaire;
  lignesImportees: number;
  lignesIgnorees: number;
  duplicates: Array<{ transaction_id: string; libelle: string; montant: number }>;
}

const defaultCsvConfig: CsvConfigState = {
  delimiter: ';',
  dateColumn: 'date',
  labelColumn: 'libelle',
  amountColumn: 'montant',
  referenceColumn: 'reference',
  transactionIdColumn: 'transaction_id',
  debitColumn: '',
  creditColumn: '',
  dateFormat: 'auto',
};

interface RapprochementProps {
  initialData?: RapprochementPayload;
}

export default function Rapprochement({ initialData }: RapprochementProps = {}) {
  const [data, setData] = useState<RapprochementPayload>(initialData ?? { releves: [], lignes_non_rapprochees: [] });
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<StatementFormat>('csv');
  const [csvConfig, setCsvConfig] = useState<CsvConfigState>(defaultCsvConfig);
  const [loading, setLoading] = useState(false);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);

  const load = () => {
    api<RapprochementPayload>('/api/rapprochement')
      .then((payload) => {
        setData(payload);
        setErr(null);
      })
      .catch((error) => setErr((error as Error).message));
  };

  useEffect(() => {
    if (initialData) return;
    load();
  }, [initialData]);

  const relevesCountLabel = useMemo(() => `${data.releves.length} relevé(s) importé(s)`, [data.releves.length]);

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

  const submitImport = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) {
      setErr('Veuillez sélectionner un fichier à importer');
      return;
    }

    setErr(null);
    setInfo(null);
    setImportSummary(null);
    setLoading(true);

    try {
      const contentBase64 = await readFileBase64(file);
      const payload = await api<ImportSummary>('/api/rapprochement/import', {
        method: 'POST',
        body: JSON.stringify({
          fileName: file.name,
          contentBase64,
          format,
          csvConfig:
            format === 'csv'
              ? {
                  ...csvConfig,
                  amountColumn: csvConfig.amountColumn || undefined,
                  referenceColumn: csvConfig.referenceColumn || undefined,
                  transactionIdColumn: csvConfig.transactionIdColumn || undefined,
                  debitColumn: csvConfig.debitColumn || undefined,
                  creditColumn: csvConfig.creditColumn || undefined,
                }
              : undefined,
        }),
      });
      setImportSummary(payload);
      setInfo(`Import terminé : ${payload.lignesImportees} ligne(s) importée(s), ${payload.lignesIgnorees} doublon(s) ignoré(s).`);
      setFile(null);
      load();
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const updateCsvConfig = (key: keyof CsvConfigState, value: string) => {
    setCsvConfig((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Rapprochement bancaire</h1>
          <p>Import des relevés OFX, CSV et MT940 puis suivi des lignes non rapprochées.</p>
        </div>
      </div>

      {err && <div className="alert error">{err}</div>}
      {info && <div className="alert info">{info}</div>}

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Importer un relevé</h2>
          <form className="form" onSubmit={submitImport}>
            <div>
              <label>Format du relevé</label>
              <select value={format} onChange={(e) => setFormat(e.target.value as StatementFormat)}>
                <option value="csv">CSV paramétrable</option>
                <option value="ofx">OFX</option>
                <option value="mt940">MT940</option>
              </select>
            </div>
            <div>
              <label>Fichier</label>
              <input
                type="file"
                accept={format === 'csv' ? '.csv,text/csv' : format === 'ofx' ? '.ofx' : '.mt940,.sta,.940'}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>

            {format === 'csv' && (
              <div className="grid cols-2">
                <div>
                  <label>Délimiteur</label>
                  <input value={csvConfig.delimiter} maxLength={1} onChange={(e) => updateCsvConfig('delimiter', e.target.value || ';')} />
                </div>
                <div>
                  <label>Format date</label>
                  <select value={csvConfig.dateFormat} onChange={(e) => updateCsvConfig('dateFormat', e.target.value)}>
                    <option value="auto">Détection auto</option>
                    <option value="yyyy-mm-dd">YYYY-MM-DD</option>
                    <option value="dd/mm/yyyy">DD/MM/YYYY</option>
                    <option value="yyyymmdd">YYYYMMDD</option>
                  </select>
                </div>
                <div>
                  <label>Colonne date</label>
                  <input value={csvConfig.dateColumn} onChange={(e) => updateCsvConfig('dateColumn', e.target.value)} />
                </div>
                <div>
                  <label>Colonne libellé</label>
                  <input value={csvConfig.labelColumn} onChange={(e) => updateCsvConfig('labelColumn', e.target.value)} />
                </div>
                <div>
                  <label>Colonne montant</label>
                  <input value={csvConfig.amountColumn} onChange={(e) => updateCsvConfig('amountColumn', e.target.value)} />
                  <div className="hint">Laisser vide si vous utilisez débit/crédit séparés.</div>
                </div>
                <div>
                  <label>Colonne référence</label>
                  <input value={csvConfig.referenceColumn} onChange={(e) => updateCsvConfig('referenceColumn', e.target.value)} />
                </div>
                <div>
                  <label>Colonne transaction bancaire</label>
                  <input value={csvConfig.transactionIdColumn} onChange={(e) => updateCsvConfig('transactionIdColumn', e.target.value)} />
                </div>
                <div>
                  <label>Colonne débit</label>
                  <input value={csvConfig.debitColumn} onChange={(e) => updateCsvConfig('debitColumn', e.target.value)} />
                </div>
                <div>
                  <label>Colonne crédit</label>
                  <input value={csvConfig.creditColumn} onChange={(e) => updateCsvConfig('creditColumn', e.target.value)} />
                </div>
              </div>
            )}

            <div className="actions">
              <button type="submit" className="btn" disabled={loading}>{loading ? 'Import...' : 'Importer le relevé'}</button>
            </div>
          </form>

          {importSummary && (
            <div className="card" style={{ marginTop: 12 }}>
              <p><strong>Fichier :</strong> {importSummary.releve.fichier_nom}</p>
              <p><strong>Lignes importées :</strong> {importSummary.lignesImportees}</p>
              <p><strong>Doublons ignorés :</strong> {importSummary.lignesIgnorees}</p>
              {importSummary.duplicates.length > 0 && (
                <div style={{ maxHeight: 180, overflow: 'auto' }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Transaction bancaire</th>
                        <th>Libellé</th>
                        <th>Montant</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importSummary.duplicates.map((duplicate) => (
                        <tr key={duplicate.transaction_id}>
                          <td>{duplicate.transaction_id}</td>
                          <td>{duplicate.libelle}</td>
                          <td>{formatEuro(duplicate.montant)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Historique des relevés</h2>
          <p style={{ color: 'var(--c-muted)', marginTop: 0 }}>{relevesCountLabel}</p>
          {data.releves.length === 0 ? (
            <div className="empty">Aucun relevé importé pour le moment.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Fichier</th>
                  <th>Format</th>
                  <th>Période</th>
                  <th>Lignes</th>
                  <th>Non rapprochées</th>
                </tr>
              </thead>
              <tbody>
                {data.releves.map((releve) => (
                  <tr key={releve.id}>
                    <td>{releve.fichier_nom}</td>
                    <td>{releve.format.toUpperCase()}</td>
                    <td>
                      {formatDate(releve.date_debut)}
                      {' → '}
                      {formatDate(releve.date_fin)}
                    </td>
                    <td>{releve.lignes_total}</td>
                    <td>{releve.lignes_non_rapprochees}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: 20, paddingBottom: 0 }}>
          <h2 style={{ marginTop: 0 }}>Lignes non rapprochées</h2>
          <p style={{ color: 'var(--c-muted)' }}>
            Ces écritures restent disponibles pour le rapprochement automatique de l’US suivante.
          </p>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Libellé</th>
              <th>Montant</th>
              <th>Référence</th>
              <th>Transaction bancaire</th>
              <th>Relevé</th>
            </tr>
          </thead>
          <tbody>
            {data.lignes_non_rapprochees.length === 0 ? (
              <tr><td colSpan={6} className="empty">Aucune ligne en attente de rapprochement.</td></tr>
            ) : data.lignes_non_rapprochees.map((ligne) => (
              <tr key={ligne.id}>
                <td>{formatDate(ligne.date)}</td>
                <td>{ligne.libelle}</td>
                <td>{formatEuro(ligne.montant)}</td>
                <td>{ligne.reference ?? '-'}</td>
                <td>{ligne.transaction_id}</td>
                <td>#{ligne.releve_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
