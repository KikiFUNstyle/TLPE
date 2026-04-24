import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEuro } from '../format';
import { makeDuplicateRowKey, type RapprochementPayload } from './Rapprochement';

test('formatEuro restitue un montant négatif exploitable pour le rapprochement bancaire', () => {
  assert.match(formatEuro(-32.1), /-?32,10\s?€/);
});

test('les données de rapprochement décrivent un historique exploitable, des workflows et un journal horodaté', () => {
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
        lignes_total: 4,
        lignes_non_rapprochees: 2,
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
        workflow: 'excedentaire',
        workflow_commentaire: 'Montant supérieur au reste à payer',
        numero_titre: 'TIT-2026-000123',
      },
    ],
    journal_rapprochements: [
      {
        id: 99,
        ligne_releve_id: 10,
        transaction_id: 'csv:BANK-001',
        mode: 'auto',
        resultat: 'excedentaire',
        commentaire: 'Montant supérieur au reste à payer',
        numero_titre: 'TIT-2026-000123',
        paiement_id: null,
        user_id: 1,
        user_display: 'Fin Rappro',
        created_at: '2026-04-24 09:35:00',
      },
    ],
  };

  assert.equal(payload.releves.length, 1);
  assert.equal(payload.releves[0].fichier_nom, 'releve-avril.csv');
  assert.equal(payload.releves[0].lignes_non_rapprochees, 2);
  assert.equal(payload.lignes_non_rapprochees.length, 1);
  assert.equal(payload.lignes_non_rapprochees[0].workflow, 'excedentaire');
  assert.equal(payload.lignes_non_rapprochees[0].numero_titre, 'TIT-2026-000123');
  assert.equal(payload.journal_rapprochements.length, 1);
  assert.equal(payload.journal_rapprochements[0].mode, 'auto');
  assert.equal(payload.journal_rapprochements[0].resultat, 'excedentaire');
});

test('les workflows de rapprochement exposent aussi une écriture erronée pour les montants non encaissables', () => {
  const payload: RapprochementPayload = {
    releves: [],
    lignes_non_rapprochees: [
      {
        id: 11,
        releve_id: 1,
        date: '2026-04-03',
        libelle: 'REJET DE PRLV',
        montant: -15,
        reference: 'TIT-2026-000321',
        transaction_id: 'csv:BANK-ERR-1',
        rapproche: 0,
        paiement_id: null,
        raw_data: '{}',
        workflow: 'errone',
        workflow_commentaire: 'Montant bancaire invalide pour un encaissement TLPE (-15.00 €).',
        numero_titre: null,
      },
    ],
    journal_rapprochements: [],
  };

  assert.equal(payload.lignes_non_rapprochees[0].workflow, 'errone');
  assert.match(payload.lignes_non_rapprochees[0].workflow_commentaire ?? '', /encaissement TLPE/);
});

test('une clé de doublon combine transaction, libellé et index pour rester stable même si transaction_id se répète', () => {
  const duplicate = { transaction_id: 'csv:BANK-001', libelle: 'Virement Alpha', montant: 150.45 };
  const secondDuplicate = { transaction_id: 'csv:BANK-001', libelle: 'Virement Alpha bis', montant: 150.45 };

  assert.equal(makeDuplicateRowKey(duplicate, 0), 'csv:BANK-001::Virement Alpha::150.45::0');
  assert.equal(makeDuplicateRowKey(secondDuplicate, 1), 'csv:BANK-001::Virement Alpha bis::150.45::1');
});
