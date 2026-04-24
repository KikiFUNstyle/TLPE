import React from 'react';
import { formatDate } from '../format';

export type RecouvrementAction = {
  id: number;
  niveau: 'J+10' | 'J+30' | 'J+60';
  action_type: 'rappel_email' | 'mise_en_demeure' | 'transmission_comptable';
  statut: 'pending' | 'envoye' | 'echec' | 'transmis';
  created_at: string;
  email_destinataire: string | null;
  piece_jointe_path: string | null;
  details: string | null;
};

function parseDetails(details: string | null): Record<string, unknown> | null {
  if (!details) return null;
  try {
    return JSON.parse(details) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function actionLabel(actionType: RecouvrementAction['action_type']): string {
  switch (actionType) {
    case 'rappel_email':
      return 'Rappel automatique';
    case 'mise_en_demeure':
      return 'Mise en demeure';
    case 'transmission_comptable':
      return 'Comptable public';
    default:
      return actionType;
  }
}

function statusClass(statut: RecouvrementAction['statut']): string {
  if (statut === 'envoye' || statut === 'transmis') return 'success';
  if (statut === 'echec') return 'danger';
  return 'info';
}

export function TitreRecouvrementHistory({ actions }: { actions: RecouvrementAction[] }) {
  if (actions.length === 0) {
    return <div className="empty">Aucune action de recouvrement enregistrée.</div>;
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {actions.map((action) => {
        const details = parseDetails(action.details);
        const downloadUrl = typeof details?.download_url === 'string' ? details.download_url : null;
        return (
          <div key={action.id} className="card" style={{ padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <strong>
                {action.niveau} · {actionLabel(action.action_type)}
              </strong>
              <span className={`badge ${statusClass(action.statut)}`}>{action.statut}</span>
            </div>
            <div style={{ color: 'var(--c-muted)', fontSize: 13, marginTop: 6 }}>
              Déclenché le {formatDate(action.created_at)}
            </div>
            {action.email_destinataire && (
              <div style={{ marginTop: 8, fontSize: 13 }}>Destinataire : {action.email_destinataire}</div>
            )}
            {action.piece_jointe_path && (
              <div style={{ marginTop: 8, fontSize: 13 }}>
                Pièce jointe : <code>{action.piece_jointe_path}</code>
              </div>
            )}
            {downloadUrl && (
              <div style={{ marginTop: 8, fontSize: 13 }}>
                Titre exécutoire : <code>{downloadUrl}</code>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default TitreRecouvrementHistory;
