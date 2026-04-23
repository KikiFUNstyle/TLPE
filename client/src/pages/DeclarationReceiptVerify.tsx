import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

interface ReceiptVerificationResponse {
  declaration_id: number;
  numero: string;
  assujetti: {
    raison_sociale: string;
    identifiant_tlpe: string;
  };
  date_soumission: string | null;
  generated_at: string;
  hash_soumission: string;
  verification_token: string;
  verified: boolean;
}

export default function DeclarationReceiptVerify() {
  const { token } = useParams();
  const [data, setData] = useState<ReceiptVerificationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    async function run() {
      if (!token) {
        setError('Jeton de vérification manquant');
        return;
      }
      try {
        const res = await fetch(`/api/declarations/receipt/verify/${encodeURIComponent(token)}`);
        const body = await res.json();
        if (!res.ok) {
          throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${res.status}`);
        }
        if (mounted) setData(body as ReceiptVerificationResponse);
      } catch (e) {
        if (mounted) setError((e as Error).message);
      }
    }

    run();
    return () => {
      mounted = false;
    };
  }, [token]);

  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <div>Vérification en cours...</div>;

  return (
    <div className="card" style={{ maxWidth: 920 }}>
      <h1>Vérification accusé de réception TLPE</h1>
      <div className="alert success" style={{ marginBottom: 16 }}>
        Hash vérifié : cet accusé est authentique et correspond à une soumission enregistrée.
      </div>

      <table className="table">
        <tbody>
          <tr>
            <th style={{ width: 260 }}>Numéro de déclaration</th>
            <td>{data.numero}</td>
          </tr>
          <tr>
            <th>Déclarant</th>
            <td>
              {data.assujetti.raison_sociale} ({data.assujetti.identifiant_tlpe})
            </td>
          </tr>
          <tr>
            <th>Date de soumission</th>
            <td>{data.date_soumission || '-'}</td>
          </tr>
          <tr>
            <th>Date de génération accusé</th>
            <td>{data.generated_at}</td>
          </tr>
          <tr>
            <th>Hash SHA-256</th>
            <td style={{ fontFamily: 'monospace', fontSize: 13, wordBreak: 'break-all' }}>{data.hash_soumission}</td>
          </tr>
          <tr>
            <th>Jeton de vérification</th>
            <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{data.verification_token}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
