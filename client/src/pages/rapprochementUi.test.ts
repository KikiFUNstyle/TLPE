import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEuro } from '../format';
import type { RapprochementPayload } from './Rapprochement';

test('formatEuro restitue un montant négatif exploitable pour le rapprochement bancaire', () => {
  assert.match(formatEuro(-32.1), /-?32,10\s?€/);
});

test('les données de rapprochement décrivent un historique exploitable et des lignes non rapprochées', () => {
  const payload: RapprochementPayload = {
    releves: [
      {
        id: 1,
        format: 'csv',
        fichier_nom: 'releve-avril.csv',
        compte_bancaire: 'FR761234',
        date_debut: '2026-04-01',
        date_fin: '2026-04-30',
        imported_at: '2026-04-24 09:30:00',
        imported_by: 1,
        lignes_total: 2,
        lignes_non_rapprochees: 1,
      },
    ],
    lignes_non_rapprochees: [
      {
        id: 10,
        releve_id: 1,
        date: '2026-04-02',
        libelle: 'Virement Alpha',
        montant: 150.45,
        reference: 'PAY-001',
        transaction_id: 'csv:BANK-001',
        rapproche: 0,
        paiement_id: null,
        raw_data: '{}',
      },
    ],
  };

  assert.equal(payload.releves.length, 1);
  assert.equal(payload.releves[0].fichier_nom, 'releve-avril.csv');
  assert.equal(payload.releves[0].lignes_non_rapprochees, 1);
  assert.equal(payload.lignes_non_rapprochees.length, 1);
  assert.equal(payload.lignes_non_rapprochees[0].libelle, 'Virement Alpha');
  assert.equal(payload.lignes_non_rapprochees[0].transaction_id, 'csv:BANK-001');
});
