export interface TitreMiseEnDemeureCandidate {
  id: number;
  statut: string;
  montant: number;
  montant_paye: number;
}

export function canGenerateMiseEnDemeure(
  titre: TitreMiseEnDemeureCandidate,
  canManageTitres: boolean,
): boolean {
  if (!canManageTitres) return false;
  const solde = Number((titre.montant - titre.montant_paye).toFixed(2));
  return solde > 0 && titre.statut !== 'paye';
}

export function getMiseEnDemeureActionLabel(titre: TitreMiseEnDemeureCandidate): string {
  return titre.statut === 'mise_en_demeure' ? 'Télécharger mise en demeure' : 'Générer mise en demeure';
}

export function getBatchEligibleTitreIds(
  titres: TitreMiseEnDemeureCandidate[],
  canManageTitres: boolean,
  limit = 100,
): number[] {
  return titres
    .filter((titre) => canGenerateMiseEnDemeure(titre, canManageTitres))
    .slice(0, limit)
    .map((titre) => titre.id);
}
