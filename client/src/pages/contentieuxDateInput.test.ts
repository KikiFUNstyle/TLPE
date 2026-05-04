import test from 'node:test';
import assert from 'node:assert/strict';
import { toLocalDateInputValue } from '../format';

test('toLocalDateInputValue renvoie la date locale YYYY-MM-DD pour un décalage négatif', () => {
  const fakeDate = {
    getTimezoneOffset: () => 300,
    getTime: () => Date.parse('2026-04-25T02:30:00.000Z'),
  } as unknown as Date;

  assert.equal(toLocalDateInputValue(fakeDate), '2026-04-24');
});

test('toLocalDateInputValue conserve la date locale pour un décalage positif', () => {
  const fakeDate = {
    getTimezoneOffset: () => -120,
    getTime: () => Date.parse('2026-04-24T21:15:00.000Z'),
  } as unknown as Date;

  assert.equal(toLocalDateInputValue(fakeDate), '2026-04-24');
});
