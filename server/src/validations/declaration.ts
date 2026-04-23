export interface DeclarationSubmissionLine {
  id: number;
  dispositif_id: number;
  surface_declaree: number;
  nombre_faces: number;
  date_pose: string | null;
  date_depose: string | null;
  type_id: number | null;
  categorie: 'publicitaire' | 'preenseigne' | 'enseigne' | null;
  adresse_rue: string | null;
  adresse_cp: string | null;
  adresse_ville: string | null;
}

export interface ValidateDeclarationSubmissionInput {
  lignes: DeclarationSubmissionLine[];
  previousYearSurfaceTotal: number;
}

export interface ValidateDeclarationSubmissionResult {
  blockingErrors: string[];
  warnings: string[];
  hasManagerAlert: boolean;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function parseIsoDateStrict(raw: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString().slice(0, 10);
  return iso === raw ? d : null;
}

export function validateDeclarationSubmission(
  input: ValidateDeclarationSubmissionInput,
): ValidateDeclarationSubmissionResult {
  const blockingErrors: string[] = [];
  const warnings: string[] = [];

  if (input.lignes.length === 0) {
    blockingErrors.push('Aucun dispositif déclaré.');
    return { blockingErrors, warnings, hasManagerAlert: false };
  }

  const duplicateKeyToLineId = new Map<string, number>();

  for (const l of input.lignes) {
    if (!Number.isFinite(l.surface_declaree) || l.surface_declaree <= 0) {
      blockingErrors.push(`Ligne #${l.id}: surface déclarée invalide (doit être > 0).`);
    }

    if (!Number.isFinite(l.nombre_faces) || l.nombre_faces < 1) {
      blockingErrors.push(`Ligne #${l.id}: nombre de faces invalide.`);
    }

    if (!l.type_id || !l.categorie) {
      blockingErrors.push(`Ligne #${l.id}: type de dispositif manquant.`);
    }

    let datePose: Date | null = null;
    let dateDepose: Date | null = null;

    if (l.date_pose) {
      datePose = parseIsoDateStrict(l.date_pose);
      if (!datePose) {
        blockingErrors.push(`Ligne #${l.id}: date de pose invalide (format attendu YYYY-MM-DD).`);
      }
    }

    if (l.date_depose) {
      dateDepose = parseIsoDateStrict(l.date_depose);
      if (!dateDepose) {
        blockingErrors.push(`Ligne #${l.id}: date de dépose invalide (format attendu YYYY-MM-DD).`);
      }
    }

    if (datePose && dateDepose && datePose.getTime() > dateDepose.getTime()) {
      blockingErrors.push(`Ligne #${l.id}: la date de pose doit être antérieure ou égale à la date de dépose.`);
    }

    const adresseKey = [normalizeText(l.adresse_rue), normalizeText(l.adresse_cp), normalizeText(l.adresse_ville)]
      .filter(Boolean)
      .join('|');

    if (adresseKey && l.type_id) {
      const duplicateKey = `${l.type_id}|${adresseKey}`;
      const firstLineId = duplicateKeyToLineId.get(duplicateKey);
      if (firstLineId !== undefined) {
        blockingErrors.push(
          `Doublon détecté: lignes #${firstLineId} et #${l.id} ont la même adresse et le même type de dispositif.`,
        );
      } else {
        duplicateKeyToLineId.set(duplicateKey, l.id);
      }
    }
  }

  const currentSurfaceTotal = input.lignes.reduce((sum, l) => sum + (Number.isFinite(l.surface_declaree) ? l.surface_declaree : 0), 0);
  let hasManagerAlert = false;

  if (input.previousYearSurfaceTotal > 0) {
    const variationRatio = Math.abs(currentSurfaceTotal - input.previousYearSurfaceTotal) / input.previousYearSurfaceTotal;
    if (variationRatio > 0.3) {
      hasManagerAlert = true;
      warnings.push(
        `Variation de surface N vs N-1 supérieure à 30% (${(variationRatio * 100).toFixed(1)}%).`,
      );
    }
  }

  return { blockingErrors, warnings, hasManagerAlert };
}
