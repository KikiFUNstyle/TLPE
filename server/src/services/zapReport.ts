type ZapAlert = {
  riskcode?: string | number;
  riskdesc?: string;
  name?: string;
};

type ZapSite = {
  alerts?: ZapAlert[];
};

type ZapReport = {
  site?: ZapSite[];
};

export type ZapEvaluationMode = 'pull_request' | 'push-main';

export type ZapEvaluation = {
  counts: {
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  hasAlertingFindings: boolean;
  shouldFail: boolean;
  summary: string;
};

function normalizeRiskCode(alert: ZapAlert): number {
  const numeric = Number(alert.riskcode);
  if (Number.isFinite(numeric)) {
    return numeric;
  }

  const risk = (alert.riskdesc || '').toLowerCase();
  if (risk.includes('high')) return 3;
  if (risk.includes('medium')) return 2;
  if (risk.includes('low')) return 1;
  return 0;
}

export function evaluateZapReport(report: ZapReport, mode: ZapEvaluationMode): ZapEvaluation {
  const counts = { high: 0, medium: 0, low: 0, info: 0 };

  for (const site of report.site || []) {
    for (const alert of site.alerts || []) {
      const risk = normalizeRiskCode(alert);
      if (risk >= 3) {
        counts.high += 1;
      } else if (risk === 2) {
        counts.medium += 1;
      } else if (risk === 1) {
        counts.low += 1;
      } else {
        counts.info += 1;
      }
    }
  }

  const hasAlertingFindings = counts.high > 0 || counts.medium > 0;
  const shouldFail = mode === 'push-main' && counts.high > 0;
  const summaryParts = [
    `High: ${counts.high}`,
    `Medium: ${counts.medium}`,
    `Low: ${counts.low}`,
    `Info: ${counts.info}`,
  ];

  const suffix = shouldFail
    ? ' — bloque le déploiement production (findings High détectés).'
    : hasAlertingFindings
      ? ' — Alerte sécurité à traiter (findings High/Medium détectés).'
      : ' — Aucun finding High/Medium détecté.';

  return {
    counts,
    hasAlertingFindings,
    shouldFail,
    summary: `${summaryParts.join(', ')}${suffix}`,
  };
}
