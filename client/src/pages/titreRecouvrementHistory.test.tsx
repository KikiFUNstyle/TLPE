import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TitreRecouvrementHistory } from './TitreRecouvrementHistory';

test('TitreRecouvrementHistory rend les actions J+10/J+30/J+60 avec pièces jointes et transmission', () => {
  const html = renderToStaticMarkup(
    React.createElement(TitreRecouvrementHistory, {
      actions: [
        {
          id: 1,
          niveau: 'J+10',
          action_type: 'rappel_email',
          statut: 'envoye',
          created_at: '2026-09-11 05:00:00',
          email_destinataire: 'alpha@example.fr',
          piece_jointe_path: null,
          details: null,
        },
        {
          id: 2,
          niveau: 'J+30',
          action_type: 'mise_en_demeure',
          statut: 'envoye',
          created_at: '2026-10-01 05:00:00',
          email_destinataire: 'alpha@example.fr',
          piece_jointe_path: 'mises_en_demeure/impayes/mise-en-demeure-1.pdf',
          details: null,
        },
        {
          id: 3,
          niveau: 'J+60',
          action_type: 'transmission_comptable',
          statut: 'transmis',
          created_at: '2026-10-31 05:00:00',
          email_destinataire: null,
          piece_jointe_path: null,
          details: JSON.stringify({ download_url: '/api/titres/1/pdf' }),
        },
        {
          id: 4,
          niveau: 'retour_comptable',
          action_type: 'admission_non_valeur',
          statut: 'classe',
          created_at: '2026-11-15 05:00:00',
          email_destinataire: null,
          piece_jointe_path: null,
          details: JSON.stringify({ commentaire: 'Retour comptable negatif - creance irrecouvrable' }),
        },
      ],
    }),
  );

  assert.match(html, /J\+10/);
  assert.match(html, /Rappel automatique/);
  assert.match(html, /Mise en demeure/);
  assert.match(html, /Comptable public/);
  assert.match(html, /Admission en non-valeur/);
  assert.match(html, /mises_en_demeure\/impayes\/mise-en-demeure-1.pdf/);
  assert.match(html, /\/api\/titres\/1\/pdf/);
  assert.match(html, /Retour comptable negatif - creance irrecouvrable/);
});
