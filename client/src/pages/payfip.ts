export type PayfipConfirmationStatus = 'success' | 'cancel' | 'failed' | 'unknown';

export function parsePayfipConfirmationSearch(search: string) {
  const params = new URLSearchParams(search);
  const rawStatus = (params.get('statut') || '').toLowerCase();
  const statut: PayfipConfirmationStatus =
    rawStatus === 'success' || rawStatus === 'cancel' || rawStatus === 'failed' ? rawStatus : 'unknown';

  return {
    statut,
    numeroTitre: params.get('numero_titre') || null,
    reference: params.get('reference') || null,
    transactionId: params.get('transaction_id') || null,
  };
}

export function getPayfipStatusVariant(statut: PayfipConfirmationStatus) {
  if (statut === 'success') return 'success';
  if (statut === 'cancel') return 'warning';
  if (statut === 'failed') return 'error';
  return 'info';
}

export function getPayfipConfirmationMessage(statut: PayfipConfirmationStatus, numeroTitre: string | null) {
  const suffix = numeroTitre ? ` pour le titre ${numeroTitre}` : '';
  if (statut === 'success') return `Paiement confirmé${suffix}. Le rapprochement automatique est en cours.`;
  if (statut === 'cancel') return `Paiement annulé${suffix}. Vous pouvez relancer un paiement en ligne.`;
  if (statut === 'failed') return `Paiement refusé${suffix}. Vérifiez votre moyen de paiement ou contactez le service financier.`;
  return `Statut de paiement inconnu${suffix}. Vérifiez l'historique du titre.`;
}
