export type TitreStatut =
  | 'emis'
  | 'paye_partiel'
  | 'paye'
  | 'impaye'
  | 'mise_en_demeure'
  | 'transmis_comptable'
  | 'admis_en_non_valeur';

export const TITRE_STATUS_OPTIONS: Array<{ value: '' | TitreStatut; label: string }> = [
  { value: '', label: 'Tous statuts' },
  { value: 'emis', label: 'Émis' },
  { value: 'paye_partiel', label: 'Payé partiel' },
  { value: 'paye', label: 'Payé' },
  { value: 'impaye', label: 'Impayé' },
  { value: 'mise_en_demeure', label: 'Mise en demeure' },
  { value: 'transmis_comptable', label: 'Transmis comptable' },
  { value: 'admis_en_non_valeur', label: 'Admis en non-valeur' },
];

export function getTitreStatusLabel(statut: string): string {
  const found = TITRE_STATUS_OPTIONS.find((option) => option.value === statut);
  return found?.label ?? statut;
}

export function getTitreStatusBadgeVariant(statut: string): 'success' | 'info' | 'warn' | 'primary' {
  switch (statut) {
    case 'paye':
      return 'success';
    case 'emis':
    case 'admis_en_non_valeur':
      return 'info';
    case 'transmis_comptable':
      return 'primary';
    default:
      return 'warn';
  }
}

export function canRendreExecutoire(statut: string, canManageTitres: boolean): boolean {
  return canManageTitres && statut === 'mise_en_demeure';
}

export function canAdmettreNonValeur(statut: string, canManageTitres: boolean): boolean {
  return canManageTitres && statut === 'transmis_comptable';
}

export function canViewRecouvrementHistory(statut: string, canManageTitres: boolean): boolean {
  return canManageTitres || statut === 'impaye' || statut === 'mise_en_demeure' || statut === 'transmis_comptable' || statut === 'admis_en_non_valeur';
}