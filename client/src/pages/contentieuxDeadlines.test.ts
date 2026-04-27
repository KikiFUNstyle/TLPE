import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyContentieuxDeadline,
  describeContentieuxDeadline,
  type ContentieuxDeadlineSummary,
} from './contentieuxDeadlineUtils';

function makeSummary(overrides: Partial<ContentieuxDeadlineSummary> = {}): ContentieuxDeadlineSummary {
  return {
    date_limite_reponse: '2026-07-15',
    date_limite_reponse_initiale: null,
    days_remaining: 30,
    overdue: false,
    niveau_alerte: 'J-30',
    extended: false,
    delai_prolonge_justification: null,
    ...overrides,
  };
}

test('classifyContentieuxDeadline marque les dossiers en retard en danger', () => {
  assert.equal(classifyContentieuxDeadline(makeSummary({ overdue: true, days_remaining: -3, niveau_alerte: 'depasse' })), 'danger');
});

test('classifyContentieuxDeadline marque les alertes imminentes en warning', () => {
  assert.equal(classifyContentieuxDeadline(makeSummary({ days_remaining: 7, niveau_alerte: 'J-7' })), 'warn');
});

test('classifyContentieuxDeadline met en avant les délais prolongés sans retard en info', () => {
  assert.equal(
    classifyContentieuxDeadline(
      makeSummary({
        extended: true,
        date_limite_reponse_initiale: '2026-07-01',
        date_limite_reponse: '2026-08-15',
        delai_prolonge_justification: 'Attente mémoire complémentaire',
      }),
    ),
    'info',
  );
});

test('describeContentieuxDeadline expose la prolongation et la nouvelle échéance', () => {
  const description = describeContentieuxDeadline(
    makeSummary({
      extended: true,
      date_limite_reponse_initiale: '2026-07-01',
      date_limite_reponse: '2026-08-15',
      delai_prolonge_justification: 'Attente mémoire complémentaire',
      days_remaining: 12,
      niveau_alerte: 'J-7',
    }),
  );

  assert.match(description, /Prolongé/);
  assert.match(description, /2026-08-15/);
  assert.match(description, /2026-07-01/);
  assert.match(description, /Attente mémoire complémentaire/);
});
