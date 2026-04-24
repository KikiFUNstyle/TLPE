export function formatEuro(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-';
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(v);
}

export function formatPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-';
  return new Intl.NumberFormat('fr-FR', {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(v);
}

export function formatDate(v: string | null | undefined): string {
  if (!v) return '-';
  try {
    const d = new Date(v);
    return d.toLocaleDateString('fr-FR');
  } catch {
    return v;
  }
}

export function toLocalDateInputValue(date = new Date()): string {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}
