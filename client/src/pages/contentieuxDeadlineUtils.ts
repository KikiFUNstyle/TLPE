export type ContentieuxAlertLevel = 'J-30' | 'J-7' | 'depasse' | null;

export interface ContentieuxDeadlineSummary {
  date_limite_reponse: string | null;
  date_limite_reponse_initiale: string | null;
  days_remaining: number | null;
  overdue: boolean;
  niveau_alerte: ContentieuxAlertLevel;
  extended: boolean;
  delai_prolonge_justification: string | null;
}

export function classifyContentieuxDeadline(summary: ContentieuxDeadlineSummary): 'danger' | 'warn' | 'info' | 'primary' {
  if (summary.overdue) return 'danger';
  if (summary.niveau_alerte === 'J-7') return 'warn';
  if (summary.extended) return 'info';
  return 'primary';
}

export function describeContentieuxDeadline(summary: ContentieuxDeadlineSummary): string {
  if (!summary.date_limite_reponse) return 'Aucune échéance renseignée';
  const parts = [`Échéance ${summary.date_limite_reponse}`];

  if (summary.overdue && summary.days_remaining !== null) {
    parts.push(`dépassée depuis ${Math.abs(summary.days_remaining)} jour(s)`);
  } else if (summary.days_remaining !== null) {
    parts.push(`dans ${summary.days_remaining} jour(s)`);
  }

  if (summary.extended) {
    parts.push(`Prolongé depuis ${summary.date_limite_reponse_initiale ?? 'échéance initiale inconnue'}`);
  }

  if (summary.delai_prolonge_justification) {
    parts.push(summary.delai_prolonge_justification);
  }

  return parts.join(' • ');
}
