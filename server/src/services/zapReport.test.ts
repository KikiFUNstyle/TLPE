import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateZapReport } from './zapReport';

test('evaluateZapReport agrège les alertes High et Medium et bloque la prod uniquement sur High', () => {
  const report = {
    site: [
      {
        alerts: [
          { riskcode: '3', riskdesc: 'High (High)', name: 'SQL Injection' },
          { riskcode: '2', riskdesc: 'Medium (Medium)', name: 'X-Frame-Options Header Not Set' },
          { riskcode: '2', riskdesc: 'Medium (Medium)', name: 'CSP Header Not Set' },
          { riskcode: '1', riskdesc: 'Low (Low)', name: 'Information Disclosure - Suspicious Comments' },
        ],
      },
    ],
  };

  const pullRequest = evaluateZapReport(report, 'pull_request');
  assert.equal(pullRequest.counts.high, 1);
  assert.equal(pullRequest.counts.medium, 2);
  assert.equal(pullRequest.counts.low, 1);
  assert.equal(pullRequest.hasAlertingFindings, true);
  assert.equal(pullRequest.shouldFail, false);
  assert.match(pullRequest.summary, /High: 1/);
  assert.match(pullRequest.summary, /Medium: 2/);

  const production = evaluateZapReport(report, 'push-main');
  assert.equal(production.shouldFail, true);
  assert.match(production.summary, /bloque le déploiement production/i);
});

test('evaluateZapReport reste non bloquant sans High même si des Medium sont présents', () => {
  const report = {
    site: [
      {
        alerts: [{ riskcode: '2', riskdesc: 'Medium (Medium)', name: 'CSP Header Not Set' }],
      },
    ],
  };

  const result = evaluateZapReport(report, 'push-main');
  assert.equal(result.counts.high, 0);
  assert.equal(result.counts.medium, 1);
  assert.equal(result.hasAlertingFindings, true);
  assert.equal(result.shouldFail, false);
  assert.match(result.summary, /Alerte sécurité/);
});
