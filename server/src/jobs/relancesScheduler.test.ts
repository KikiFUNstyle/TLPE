import test from 'node:test';
import assert from 'node:assert/strict';
import { runDailyJobs } from './relancesScheduler';

test('runDailyJobs exécute aussi l’escalade des impayés quand les relances déclaratives échouent', () => {
  let relancesCalls = 0;
  let impayesCalls = 0;

  const result = runDailyJobs({
    runRelances: () => {
      relancesCalls += 1;
      throw new Error('relances KO');
    },
    runImpayes: () => {
      impayesCalls += 1;
      return {
        run_date: '2026-09-11',
        processed: 1,
        sent: 1,
        failed: 0,
        generated_pdfs: 0,
        transmitted: 0,
        blocked: 0,
      };
    },
  });

  assert.equal(relancesCalls, 1);
  assert.equal(impayesCalls, 1);
  assert.equal(result.relances.ok, false);
  assert.match(result.relances.error ?? '', /relances KO/);
  assert.equal(result.impayes.ok, true);
  assert.equal(result.impayes.result?.processed, 1);
});
