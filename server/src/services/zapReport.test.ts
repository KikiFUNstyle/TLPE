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

test('evaluateZapReport classe les risques à partir de riskdesc si riskcode n’est pas numérique', () => {
  const report = {
    site: [
      {
        alerts: [
          { riskcode: 'n/a', riskdesc: 'High severity', name: 'Broken Access Control' },
          { riskcode: undefined, riskdesc: 'Low severity', name: 'Server banner' },
          { riskcode: 'unknown', riskdesc: 'Informational', name: 'Timestamp disclosure' },
        ],
      },
    ],
  };

  const result = evaluateZapReport(report, 'pull_request');
  assert.equal(result.counts.high, 1);
  assert.equal(result.counts.medium, 0);
  assert.equal(result.counts.low, 1);
  assert.equal(result.counts.info, 1);
  assert.equal(result.hasAlertingFindings, true);
  assert.equal(result.shouldFail, false);
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

test('evaluateZapReport annonce l’absence de findings High/Medium quand le rapport est vide ou informatif', () => {
  const result = evaluateZapReport({ site: [{ alerts: [{ riskcode: '0', riskdesc: 'Informational' }] }] }, 'push-main');
  assert.equal(result.counts.high, 0);
  assert.equal(result.counts.medium, 0);
  assert.equal(result.counts.low, 0);
  assert.equal(result.counts.info, 1);
  assert.equal(result.hasAlertingFindings, false);
  assert.equal(result.shouldFail, false);
  assert.match(result.summary, /Aucun finding High\/Medium détecté/);
});
