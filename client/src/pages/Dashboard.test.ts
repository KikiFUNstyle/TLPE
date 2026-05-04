import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChartData } from './Dashboard';

test('buildChartData retourne une liste vide quand aucune donnée n’est disponible', () => {
  assert.deepEqual(buildChartData([]), []);
});

test('buildChartData ajoute les labels de date attendus', () => {
  assert.deepEqual(
    buildChartData([
      { date: '2026-05-04', soumissions_jour: 3, cumul_soumissions: 3 },
      { date: '2026-05-05', soumissions_jour: 2, cumul_soumissions: 5 },
    ]),
    [
      { date: '2026-05-04', soumissions_jour: 3, cumul_soumissions: 3, label: '05-04' },
      { date: '2026-05-05', soumissions_jour: 2, cumul_soumissions: 5, label: '05-05' },
    ],
  );
});
