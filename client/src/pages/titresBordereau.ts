export function canExportBordereau(params: { annee: string; canManage: boolean }) {
  return params.canManage && /^\d{4}$/.test(params.annee);
}

export function buildBordereauPath(annee: string, format: 'pdf' | 'xlsx') {
  return `/api/titres/bordereau?annee=${encodeURIComponent(annee)}&format=${format}`;
}

export function buildBordereauFilename(annee: string, format: 'pdf' | 'xlsx') {
  return `bordereau-titres-${annee}.${format}`;
}
