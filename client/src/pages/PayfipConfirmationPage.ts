import React from 'react';
import { Link } from 'react-router-dom';
import { parsePayfipConfirmationSearch } from './payfip';
import { PayfipConfirmationView } from './PayfipConfirmation';

export function PayfipConfirmationPage({ search }: { search?: string }) {
  const confirmation = parsePayfipConfirmationSearch(search ?? (typeof window === 'undefined' ? '' : window.location.search));

  return React.createElement(
    'div',
    { className: 'card', style: { maxWidth: 720 } },
    React.createElement('h1', null, 'Confirmation de paiement PayFip'),
    React.createElement(
      'p',
      { style: { color: 'var(--c-muted)' } },
      'Le portail a bien enregistré le retour PayFip. Le rapprochement du titre est mis à jour selon le statut reçu.',
    ),
    React.createElement(PayfipConfirmationView, { confirmation }),
    React.createElement(
      'div',
      { className: 'actions', style: { marginTop: 16 } },
      React.createElement(Link, { className: 'btn', to: '/titres' }, 'Mes titres'),
    ),
  );
}
