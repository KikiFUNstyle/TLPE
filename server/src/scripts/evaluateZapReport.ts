import fs from 'node:fs';
import { evaluateZapReport, type ZapEvaluationMode } from '../services/zapReport';

function main() {
  const reportPath = process.argv[2];
  const mode = (process.argv[3] as ZapEvaluationMode | undefined) || 'pull_request';

  if (!reportPath) {
    throw new Error('Usage: node dist/scripts/evaluateZapReport.js <report_json.json> <pull_request|push-main>');
  }

  if (mode !== 'pull_request' && mode !== 'push-main') {
    throw new Error(`Mode ZAP invalide: ${mode}`);
  }

  const raw = fs.readFileSync(reportPath, 'utf8');
  const report = JSON.parse(raw);
  const evaluation = evaluateZapReport(report, mode);

  console.log(`[ZAP] ${evaluation.summary}`);
  if (evaluation.hasAlertingFindings) {
    console.log(`::warning::${evaluation.summary}`);
  }

  if (evaluation.shouldFail) {
    console.log('::error::Déploiement production bloqué: findings High détectés par OWASP ZAP.');
    process.exit(1);
  }
}

main();
