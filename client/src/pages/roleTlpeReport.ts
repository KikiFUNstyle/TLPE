export function canExportRoleTlpe(params: { annee: string; canManage: boolean }) {
  return params.canManage && /^\d{4}$/.test(params.annee);
}

export function buildRoleTlpePath(annee: string, format: 'pdf' | 'xlsx') {
  return `/api/rapports/role?annee=${encodeURIComponent(annee)}&format=${format}`;
}

export function buildRoleTlpeFilename(annee: string, format: 'pdf' | 'xlsx') {
  return `role-tlpe-${annee}.${format}`;
}
