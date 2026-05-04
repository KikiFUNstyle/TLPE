import test from 'node:test';
import assert from 'node:assert/strict';
import { formatContentieuxAlertMeta } from './Dashboard';

test('formatContentieuxAlertMeta formate les KPI d’alertes contentieux', () => {
  const labels = formatContentieuxAlertMeta(3, 1);

  assert.deepEqual(labels, {
    upcoming: '3 alerte(s) <= J-30',
    overdue: '1 dossier(s) en dépassement',
  });
});
