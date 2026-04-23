import React from 'react';
import { getPayfipConfirmationMessage, getPayfipStatusVariant, type PayfipConfirmationStatus } from './payfip';

export interface PayfipConfirmationData {
  statut: PayfipConfirmationStatus;
  numeroTitre: string | null;
  reference: string | null;
  transactionId: string | null;
}

export function PayfipConfirmationView({ confirmation }: { confirmation: PayfipConfirmationData }) {
  return React.createElement(
    'div',
    { className: `alert ${getPayfipStatusVariant(confirmation.statut)}` },
    React.createElement('strong', null, 'Paiement en ligne :'),
    ' ',
    getPayfipConfirmationMessage(confirmation.statut, confirmation.numeroTitre),
    confirmation.reference ? ` Référence : ${confirmation.reference}.` : '',
    confirmation.transactionId ? ` Transaction : ${confirmation.transactionId}.` : '',
  );
}
