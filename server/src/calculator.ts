// Moteur de calcul TLPE (specification section 6)
//
// Formule generale :
//   Montant TLPE = Surface effective x Tarif (EUR/m2) x Coefficient zone x Prorata temporis
//   Prorata temporis = Nombre de jours d'exploitation / 365
//
// Regles specifiques implementees :
//  - Double face : surface effective = surface unitaire x nombre_faces
//  - Bareme par tranche de surface et par categorie (publicitaire/preenseigne/enseigne)
//  - Certaines tranches sont exonerees (ex : enseignes <= 7 m2)
//  - Certaines tranches appliquent un tarif fixe (ex : enseignes 7-12 m2)
//  - Arrondis : montant par ligne conserve 2 decimales, total arrondi a l'euro inferieur
//
// Le moteur fonctionne en deux modes :
//  - simulation (stateless) : retourne le detail sans persistance
//  - calcul officiel : utilise par le moteur de declaration avant emission du titre
//
// Les entrees sont volontairement minimales pour pouvoir calculer hors-base
// (ex : depuis un simulateur public non authentifie).

import { db } from './db';

export interface CalculInput {
  annee: number;
  categorie: 'publicitaire' | 'preenseigne' | 'enseigne';
  surface: number;
  nombre_faces?: number;
  coefficient_zone?: number;
  date_pose?: string | null;
  date_depose?: string | null;
  exonere?: boolean;
  assujetti_id?: number;
}

export interface ExonerationRow {
  id: number;
  type: 'droit' | 'deliberee' | 'eco';
  critere: string;
  taux: number;
  date_debut: string | null;
  date_fin: string | null;
  active: number;
}

interface ExonerationCritere {
  categorie?: CalculInput['categorie'];
  assujetti_id?: number;
  surface_max?: number;
  surface_min?: number;
  coefficient_zone_max?: number;
  coefficient_zone_min?: number;
  annee_min?: number;
  annee_max?: number;
}

export interface BaremeRow {
  id: number;
  annee: number;
  categorie: 'publicitaire' | 'preenseigne' | 'enseigne';
  surface_min: number;
  surface_max: number | null;
  tarif_m2: number | null;
  tarif_fixe: number | null;
  exonere: number;
  libelle: string;
}

export interface CalculResult {
  montant: number;
  detail: {
    surface_unitaire: number;
    nombre_faces: number;
    surface_effective: number;
    categorie: string;
    tranche_libelle: string;
    bareme_id: number | null;
    tarif_m2: number | null;
    tarif_fixe: number | null;
    coefficient_zone: number;
    jours_exploitation: number;
    prorata: number;
    exonere: boolean;
    sous_total: number;
    montant_arrondi: number;
  };
}

export function findBareme(
  annee: number,
  categorie: CalculInput['categorie'],
  surfaceEffective: number,
): BaremeRow | null {
  // recherche la tranche applicable pour l'annee (ou l'annee la plus recente <= annee)
  const rows = db
    .prepare(
      `SELECT * FROM baremes
       WHERE categorie = ? AND annee <= ?
       ORDER BY annee DESC, surface_min ASC`,
    )
    .all(categorie, annee) as BaremeRow[];

  // garder uniquement la derniere annee trouvee
  const latestYear = rows.length > 0 ? rows[0].annee : null;
  if (latestYear === null) return null;
  const candidates = rows.filter((r) => r.annee === latestYear);

  for (const row of candidates) {
    const min = row.surface_min;
    const max = row.surface_max ?? Number.POSITIVE_INFINITY;
    if (surfaceEffective > min && surfaceEffective <= max) return row;
    if (surfaceEffective === min && min === 0 && max >= surfaceEffective) return row;
  }
  // fallback : derniere tranche (la plus grande)
  return candidates[candidates.length - 1] ?? null;
}

export function computeProrata(
  annee: number,
  datePose?: string | null,
  dateDepose?: string | null,
): { jours: number; prorata: number } {
  const start = new Date(`${annee}-01-01T00:00:00Z`).getTime();
  const end = new Date(`${annee}-12-31T00:00:00Z`).getTime();
  const msPerDay = 86_400_000;

  let poseTs = start;
  if (datePose) {
    const d = new Date(datePose + 'T00:00:00Z').getTime();
    if (!Number.isNaN(d) && d > start) poseTs = d;
  }
  let deposeTs = end;
  if (dateDepose) {
    const d = new Date(dateDepose + 'T00:00:00Z').getTime();
    if (!Number.isNaN(d) && d < end) deposeTs = d;
  }
  if (deposeTs < poseTs) return { jours: 0, prorata: 0 };
  const jours = Math.round((deposeTs - poseTs) / msPerDay) + 1;
  const prorata = Math.min(1, Math.max(0, jours / 365));
  return { jours, prorata: Math.round(prorata * 10000) / 10000 };
}

function critereMatches(
  critere: ExonerationCritere,
  context: {
    annee: number;
    categorie: CalculInput['categorie'];
    assujettiId?: number;
    surfaceEffective: number;
    coefficientZone: number;
  },
): boolean {
  if (critere.categorie && critere.categorie !== context.categorie) return false;
  if (critere.assujetti_id !== undefined && critere.assujetti_id !== context.assujettiId) return false;
  if (critere.surface_max !== undefined && context.surfaceEffective > critere.surface_max) return false;
  if (critere.surface_min !== undefined && context.surfaceEffective < critere.surface_min) return false;
  if (critere.coefficient_zone_max !== undefined && context.coefficientZone > critere.coefficient_zone_max) return false;
  if (critere.coefficient_zone_min !== undefined && context.coefficientZone < critere.coefficient_zone_min) return false;
  if (critere.annee_min !== undefined && context.annee < critere.annee_min) return false;
  if (critere.annee_max !== undefined && context.annee > critere.annee_max) return false;
  return true;
}

export function findExoneration(
  annee: number,
  categorie: CalculInput['categorie'],
  surfaceEffective: number,
  coefficientZone: number,
  assujettiId?: number,
): ExonerationRow | null {
  const rows = db
    .prepare(
      `SELECT id, type, critere, taux, date_debut, date_fin, active
       FROM exonerations
       WHERE active = 1
         AND (date_debut IS NULL OR date_debut <= ?)
         AND (date_fin IS NULL OR date_fin >= ?)
       ORDER BY type ASC, id ASC`,
    )
    .all(`${annee}-12-31`, `${annee}-01-01`) as ExonerationRow[];

  for (const row of rows) {
    let critere: ExonerationCritere;
    try {
      critere = JSON.parse(row.critere) as ExonerationCritere;
    } catch {
      continue;
    }

    if (
      critereMatches(critere, {
        annee,
        categorie,
        assujettiId,
        surfaceEffective,
        coefficientZone,
      })
    ) {
      return row;
    }
  }

  return null;
}

export function calculerTLPE(input: CalculInput): CalculResult {
  const nombreFaces = input.nombre_faces ?? 1;
  const surfaceEffective = input.surface * nombreFaces;
  const coefficient = input.coefficient_zone ?? 1;
  const { jours, prorata } = computeProrata(input.annee, input.date_pose, input.date_depose);

  // Exoneration directe : pas de recherche de bareme
  if (input.exonere) {
    return {
      montant: 0,
      detail: {
        surface_unitaire: input.surface,
        nombre_faces: nombreFaces,
        surface_effective: surfaceEffective,
        categorie: input.categorie,
        tranche_libelle: 'Exoneration',
        bareme_id: null,
        tarif_m2: null,
        tarif_fixe: null,
        coefficient_zone: coefficient,
        jours_exploitation: jours,
        prorata,
        exonere: true,
        sous_total: 0,
        montant_arrondi: 0,
      },
    };
  }

  const bareme = findBareme(input.annee, input.categorie, surfaceEffective);
  if (!bareme) {
    throw new Error(
      `Aucun bareme TLPE trouve pour categorie=${input.categorie} annee<=${input.annee}`,
    );
  }

  if (bareme.exonere) {
    return {
      montant: 0,
      detail: {
        surface_unitaire: input.surface,
        nombre_faces: nombreFaces,
        surface_effective: surfaceEffective,
        categorie: input.categorie,
        tranche_libelle: bareme.libelle,
        bareme_id: bareme.id,
        tarif_m2: null,
        tarif_fixe: null,
        coefficient_zone: coefficient,
        jours_exploitation: jours,
        prorata,
        exonere: true,
        sous_total: 0,
        montant_arrondi: 0,
      },
    };
  }

  const exoneration = findExoneration(
    input.annee,
    input.categorie,
    surfaceEffective,
    coefficient,
    input.assujetti_id,
  );

  let sousTotal: number;
  if (bareme.tarif_fixe !== null) {
    sousTotal = bareme.tarif_fixe * coefficient * prorata;
  } else if (bareme.tarif_m2 !== null) {
    sousTotal = surfaceEffective * bareme.tarif_m2 * coefficient * prorata;
  } else {
    sousTotal = 0;
  }
  const montantApresReduction = exoneration ? sousTotal * (1 - exoneration.taux) : sousTotal;
  const montantArrondi = Math.max(0, Math.floor(montantApresReduction));

  return {
    montant: montantArrondi,
    detail: {
      surface_unitaire: input.surface,
      nombre_faces: nombreFaces,
      surface_effective: surfaceEffective,
      categorie: input.categorie,
      tranche_libelle: exoneration
        ? `${bareme.libelle} (${exoneration.type} -${Math.round(exoneration.taux * 100)}%)`
        : bareme.libelle,
      bareme_id: bareme.id,
      tarif_m2: bareme.tarif_m2,
      tarif_fixe: bareme.tarif_fixe,
      coefficient_zone: coefficient,
      jours_exploitation: jours,
      prorata,
      exonere: exoneration ? exoneration.taux >= 1 : false,
      sous_total: Math.round(montantApresReduction * 100) / 100,
      montant_arrondi: montantArrondi,
    },
  };
}
