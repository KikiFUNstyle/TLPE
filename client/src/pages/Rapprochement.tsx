import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { formatDate, formatEuro } from '../format';

type StatementFormat = 'csv' | 'ofx' | 'mt940';
type DateFormat = 'auto' | 'yyyy-mm-dd' | 'dd/mm/yyyy' | 'yyyymmdd';
type WorkflowState = 'en_attente' | 'rapproche' | 'partiel' | 'excedentaire' | 'erreur_reference' | 'errone';
type RapprochementMode = 'auto' | 'manuel';

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
  workflow: WorkflowState;
  workflow_commentaire: string | null;
  numero_titre: string | null;
}

export interface RapprochementLog {
  id: number;
  ligne_releve_id: number;
  transaction_id: string;
  mode: RapprochementMode;
  resultat: Exclude<WorkflowState, 'en_attente'>;
  commentaire: string | null;
  numero_titre: string | null;
  paiement_id: number | null;
  user_id: number | null;
  user_display: string | null;
  created_at: string;
}

export interface RapprochementPayload {
  releves: ReleveBancaire[];
  lignes_non_rapprochees: LigneNonRapprochee[];
  journal_rapprochements: RapprochementLog[];
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

export interface ImportSummary {
  releve: ReleveBancaire;
  lignesImportees: number;
  lignesIgnorees: number;
  duplicates: Array<{ transaction_id: string; libelle: string; montant: number }>;
}

interface AutoRapprochementSummary {
  matched_count: number;
  pending_count: number;
  payment_count: number;
}

interface ManualRapprochementResponse {
  ok: true;
  mode: 'manuel';
  resultat: 'rapproche' | 'partiel';
  statut: string;
  montant_paye: number;
  paiement_id: number;
}

export function makeDuplicateRowKey(
  duplicate: { transaction_id: string; libelle: string; montant: number },
  index: number,
) {
  return `${duplicate.transaction_id}::${duplicate.libelle}::${duplicate.montant.toFixed(2)}::${index}`;
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

const workflowLabels: Record<WorkflowState, string> = {
  en_attente: 'En attente',
  rapproche: 'Rapproché',
  partiel: 'Partiel',
  excedentaire: 'Excédentaire',
  erreur_reference: 'Référence invalide',
  errone: 'Écriture erronée',
};

const workflowBadgeClass: Record<WorkflowState, string> = {
  en_attente: 'info',
  rapproche: 'success',
  partiel: 'warn',
  excedentaire: 'danger',
  erreur_reference: 'danger',
  errone: 'danger',
};

const modeLabels: Record<RapprochementMode, string> = {
  auto: 'Auto',
  manuel: 'Manuel',
};

interface RapprochementProps {
  initialData?: RapprochementPayload;
}

export default function Rapprochement({ initialData }: RapprochementProps = {}) {
  const [data, setData] = useState<RapprochementPayload>(
    initialData ?? { releves: [], lignes_non_rapprochees: [], journal_rapprochements: [] },
  );
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<StatementFormat>('csv');
  const [csvConfig, setCsvConfig] = useState<CsvConfigState>(defaultCsvConfig);
  const [loading, setLoading] = useState(false);
  const [autoLoading, setAutoLoading] = useState(false);
  const [manualLoading, setManualLoading] = useState<number | null>(null);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [manualTargets, setManualTargets] = useState<Record<number, string>>({});
  const [manualComments, setManualComments] = useState<Record<number, string>>({});

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

  const runAutoRapprochement = async () => {
    setErr(null);
    setInfo(null);
    setAutoLoading(true);
    try {
      const result = await api<AutoRapprochementSummary>('/api/rapprochement/auto', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setInfo(
        `Rapprochement automatique terminé : ${result.matched_count} ligne(s) rapprochée(s), ${result.pending_count} en attente, ${result.payment_count} paiement(s) créés.`,
      );
      load();
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setAutoLoading(false);
    }
  };

  const submitManualRapprochement = async (ligne: LigneNonRapprochee) => {
    const numeroTitre = (manualTargets[ligne.id] || '').trim().toUpperCase();
    if (!numeroTitre) {
      setErr('Veuillez saisir un numéro de titre pour le rapprochement manuel.');
      return;
    }

    setErr(null);
    setInfo(null);
    setManualLoading(ligne.id);
    try {
      const result = await api<ManualRapprochementResponse>('/api/rapprochement/manual', {
        method: 'POST',
        body: JSON.stringify({
          ligne_id: ligne.id,
          numero_titre: numeroTitre,
          commentaire: manualComments[ligne.id] || undefined,
        }),
      });
      setInfo(
        `Ligne ${ligne.transaction_id} rapprochée manuellement (${workflowLabels[result.resultat]} · statut titre ${result.statut.replace('_', ' ')}).`,
      );
      setManualTargets((prev) => ({ ...prev, [ligne.id]: '' }));
      setManualComments((prev) => ({ ...prev, [ligne.id]: '' }));
      load();
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setManualLoading(null);
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
          <p>Import des relevés, rapprochement automatique par référence et traitement manuel des exceptions.</p>
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
                      {importSummary.duplicates.map((duplicate, index) => (
                        <tr key={makeDuplicateRowKey(duplicate, index)}>
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

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ marginTop: 0, marginBottom: 4 }}>Rapprochement automatique</h2>
            <p style={{ margin: 0, color: 'var(--c-muted)' }}>
              Détecte le numéro de titre dans la référence ou le libellé, crée les paiements et classe les exceptions.
            </p>
          </div>
          <button type="button" className="btn" disabled={autoLoading} onClick={() => void runAutoRapprochement()}>
            {autoLoading ? 'Traitement...' : 'Lancer le rapprochement automatique'}
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 0, marginBottom: 16 }}>
        <div style={{ padding: 20, paddingBottom: 0 }}>
          <h2 style={{ marginTop: 0 }}>Lignes non rapprochées</h2>
          <p style={{ color: 'var(--c-muted)' }}>
            Les lignes non soldées restent visibles avec leur workflow et peuvent être affectées manuellement à un titre.
          </p>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Libellé</th>
              <th>Montant</th>
              <th>Référence</th>
              <th>Transaction</th>
              <th>Workflow</th>
              <th>Titre détecté</th>
              <th>Correspondance manuelle</th>
            </tr>
          </thead>
          <tbody>
            {data.lignes_non_rapprochees.length === 0 ? (
              <tr><td colSpan={8} className="empty">Aucune ligne en attente de rapprochement.</td></tr>
            ) : data.lignes_non_rapprochees.map((ligne) => (
              <tr key={ligne.id}>
                <td>{formatDate(ligne.date)}</td>
                <td>
                  <div>{ligne.libelle}</div>
                  {ligne.workflow_commentaire && (
                    <div className="hint" style={{ maxWidth: 280 }}>{ligne.workflow_commentaire}</div>
                  )}
                </td>
                <td>{formatEuro(ligne.montant)}</td>
                <td>{ligne.reference ?? '-'}</td>
                <td>{ligne.transaction_id}</td>
                <td>
                  <span className={`badge ${workflowBadgeClass[ligne.workflow]}`}>
                    {workflowLabels[ligne.workflow]}
                  </span>
                </td>
                <td>{ligne.numero_titre ?? '-'}</td>
                <td>
                  <div style={{ display: 'grid', gap: 6, minWidth: 220 }}>
                    <input
                      placeholder="TIT-2026-000123"
                      value={manualTargets[ligne.id] || ''}
                      onChange={(e) => setManualTargets((prev) => ({ ...prev, [ligne.id]: e.target.value.toUpperCase() }))}
                    />
                    <input
                      placeholder="Commentaire (optionnel)"
                      value={manualComments[ligne.id] || ''}
                      onChange={(e) => setManualComments((prev) => ({ ...prev, [ligne.id]: e.target.value }))}
                    />
                    <button
                      type="button"
                      className="btn small"
                      disabled={manualLoading === ligne.id}
                      onClick={() => void submitManualRapprochement(ligne)}
                    >
                      {manualLoading === ligne.id ? 'Affectation...' : 'Affecter manuellement'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: 20, paddingBottom: 0 }}>
          <h2 style={{ marginTop: 0 }}>Journal des rapprochements</h2>
          <p style={{ color: 'var(--c-muted)' }}>
            Historise le mode de rapprochement, le résultat, la ligne bancaire, le titre ciblé et l’auteur éventuel.
          </p>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Quand</th>
              <th>Mode</th>
              <th>Résultat</th>
              <th>Transaction</th>
              <th>Titre</th>
              <th>Utilisateur</th>
              <th>Commentaire</th>
            </tr>
          </thead>
          <tbody>
            {data.journal_rapprochements.length === 0 ? (
              <tr><td colSpan={7} className="empty">Aucun rapprochement journalisé pour le moment.</td></tr>
            ) : data.journal_rapprochements.map((entry) => (
              <tr key={entry.id}>
                <td>{formatDate(entry.created_at)}</td>
                <td>{modeLabels[entry.mode]}</td>
                <td>
                  <span className={`badge ${workflowBadgeClass[entry.resultat]}`}>
                    {workflowLabels[entry.resultat]}
                  </span>
                </td>
                <td>{entry.transaction_id}</td>
                <td>{entry.numero_titre ?? '-'}</td>
                <td>{entry.user_display ?? 'Système'}</td>
                <td>{entry.commentaire ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
