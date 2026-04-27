export type ContentieuxAlertLevel = 'J-30' | 'J-7' | 'depasse';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeIsoDate(value: string): string {
  const match = ISO_DATE_RE.exec(value);
  if (!match) throw new Error(`Date invalide: ${value}`);

  const [yearRaw, monthRaw, dayRaw] = match[0].split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new Error(`Date invalide: ${value}`);
  }

  return match[0];
}

function formatUtcDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function todayIsoDate(now = new Date()): string {
  return formatUtcDate(now);
}

export function addMonthsClamped(isoDate: string, months: number): string {
  const normalized = normalizeIsoDate(isoDate);
  const [year, month, day] = normalized.split('-').map(Number);
  const totalMonths = (month - 1) + months;
  const targetYear = year + Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return formatUtcDate(new Date(Date.UTC(targetYear, targetMonth, targetDay)));
}

export function diffDays(fromIso: string, toIso: string): number {
  const from = Date.parse(`${normalizeIsoDate(fromIso)}T00:00:00.000Z`);
  const to = Date.parse(`${normalizeIsoDate(toIso)}T00:00:00.000Z`);
  return Math.round((to - from) / 86_400_000);
}

export function computeContentieuxResponseDeadline(dateOuverture: string): string {
  return addMonthsClamped(dateOuverture, 6);
}

export function classifyContentieuxAlertLevel(daysRemaining: number): ContentieuxAlertLevel | null {
  if (daysRemaining < 0) return 'depasse';
  if (daysRemaining === 7) return 'J-7';
  if (daysRemaining === 30) return 'J-30';
  return null;
}

export function isContentieuxDeadlineActive(statut: string): boolean {
  return statut === 'ouvert' || statut === 'instruction';
}

export interface ContentieuxDeadlineSnapshot {
  date_limite_reponse: string | null;
  date_limite_reponse_initiale: string | null;
  delai_prolonge_justification: string | null;
}

export function summarizeContentieuxDeadline(
  snapshot: ContentieuxDeadlineSnapshot,
  runDateIso: string,
): {
  date_limite_reponse: string | null;
  date_limite_reponse_initiale: string | null;
  days_remaining: number | null;
  overdue: boolean;
  niveau_alerte: ContentieuxAlertLevel | null;
  extended: boolean;
  delai_prolonge_justification: string | null;
} {
  if (!snapshot.date_limite_reponse) {
    return {
      date_limite_reponse: null,
      date_limite_reponse_initiale: snapshot.date_limite_reponse_initiale,
      days_remaining: null,
      overdue: false,
      niveau_alerte: null,
      extended: false,
      delai_prolonge_justification: snapshot.delai_prolonge_justification,
    };
  }

  const daysRemaining = diffDays(runDateIso, snapshot.date_limite_reponse);
  return {
    date_limite_reponse: snapshot.date_limite_reponse,
    date_limite_reponse_initiale: snapshot.date_limite_reponse_initiale,
    days_remaining: daysRemaining,
    overdue: daysRemaining < 0,
    niveau_alerte: classifyContentieuxAlertLevel(daysRemaining),
    extended:
      snapshot.date_limite_reponse_initiale !== null &&
      snapshot.date_limite_reponse_initiale !== snapshot.date_limite_reponse,
    delai_prolonge_justification: snapshot.delai_prolonge_justification,
  };
}
