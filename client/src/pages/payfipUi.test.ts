import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import {
  parsePayfipConfirmationSearch,
  getPayfipConfirmationMessage,
  getPayfipStatusVariant,
} from './payfip';
import { PayfipConfirmationView } from './PayfipConfirmation';

test('parsePayfipConfirmationSearch extrait les paramètres utiles depuis l’URL de retour', () => {
  const parsed = parsePayfipConfirmationSearch(
    '?statut=success&numero_titre=TIT-2026-000777&reference=TLPE-PAYFIP-1&transaction_id=TX-42',
  );

  assert.equal(parsed.statut, 'success');
  assert.equal(parsed.numeroTitre, 'TIT-2026-000777');
  assert.equal(parsed.reference, 'TLPE-PAYFIP-1');
  assert.equal(parsed.transactionId, 'TX-42');
});

test('getPayfipConfirmationMessage adapte le libellé aux issues succès, annulation et refus', () => {
  assert.match(getPayfipConfirmationMessage('success', 'TIT-2026-000777'), /confirmé/i);
  assert.match(getPayfipConfirmationMessage('cancel', 'TIT-2026-000777'), /annulé/i);
  assert.match(getPayfipConfirmationMessage('failed', 'TIT-2026-000777'), /refusé/i);
  assert.match(getPayfipConfirmationMessage('unknown', 'TIT-2026-000777'), /statut/i);
});

test('getPayfipStatusVariant retourne une variante d’alerte cohérente pour la page de confirmation', () => {
  assert.equal(getPayfipStatusVariant('success'), 'success');
  assert.equal(getPayfipStatusVariant('cancel'), 'warning');
  assert.equal(getPayfipStatusVariant('failed'), 'error');
  assert.equal(getPayfipStatusVariant('unknown'), 'info');
});

test('PayfipConfirmationView restitue les métadonnées de confirmation dans la bannière', () => {
  const html = renderToStaticMarkup(
    React.createElement(PayfipConfirmationView, {
      confirmation: {
        statut: 'success',
        numeroTitre: 'TIT-2026-000777',
        reference: 'TLPE-PAYFIP-1',
        transactionId: 'TX-42',
      },
    }),
  );

  assert.match(html, /Paiement en ligne/);
  assert.match(html, /confirmé/i);
  assert.match(html, /TLPE-PAYFIP-1/);
  assert.match(html, /TX-42/);
});

test('PayfipConfirmationPage présente un retour dédié avec un lien vers les titres', async () => {
  const { PayfipConfirmationPage } = await import('./PayfipConfirmationPage');
  const html = renderToStaticMarkup(
    React.createElement(
      StaticRouter,
      { location: '/paiement/confirmation' },
      React.createElement(PayfipConfirmationPage, {
        search: '?statut=failed&numero_titre=TIT-2026-000777&reference=TLPE-PAYFIP-1&transaction_id=TX-42',
      }),
    ),
  );

  assert.match(html, /Confirmation de paiement/);
  assert.match(html, /refusé/i);
  assert.match(html, /Mes titres/);
  assert.match(html, /href="\/titres"/);
});
