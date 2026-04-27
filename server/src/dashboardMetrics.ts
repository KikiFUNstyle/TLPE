import { db } from './db';

type DrilldownRow = {
  label: string;
  assujettis_attendus: number;
  declarations_soumises: number;
  declarations_validees: number;
  declarations_rejetees: number;
  taux_declaration: number;
};

function computeRate(received: number, expected: number): number {
  if (expected <= 0) return 0;
  return received / expected;
}

export function getDashboardMetrics(nowDateIso = new Date().toISOString().slice(0, 10)) {
  const currentYear = new Date().getFullYear();
  const campagne = db
    .prepare(
      `SELECT id, annee, date_ouverture, date_limite_declaration
       FROM campagnes
       ORDER BY CASE WHEN statut = 'ouverte' THEN 0 ELSE 1 END, annee DESC
       LIMIT 1`,
    )
    .get() as
    | { id: number; annee: number; date_ouverture: string; date_limite_declaration: string }
    | undefined;

  const annee = campagne?.annee ?? currentYear;

  const montantEmisN = (db.prepare('SELECT COALESCE(SUM(montant), 0) AS s FROM titres WHERE annee = ?').get(annee) as { s: number }).s;
  const montantEmisNm1 = (db.prepare('SELECT COALESCE(SUM(montant), 0) AS s FROM titres WHERE annee = ?').get(annee - 1) as { s: number }).s;
  const montantRecouvre = (
    db.prepare('SELECT COALESCE(SUM(montant_paye), 0) AS s FROM titres WHERE annee = ?').get(annee) as { s: number }
  ).s;

  const montantImpaye = (
    db
      .prepare(
        `SELECT COALESCE(SUM(montant - montant_paye), 0) AS s
         FROM titres
         WHERE statut IN ('emis','paye_partiel','impaye','mise_en_demeure')
           AND date_echeance < date('now')`,
      )
      .get() as { s: number }
  ).s;

  const assujettisActifs = (db.prepare("SELECT COUNT(*) AS c FROM assujettis WHERE statut = 'actif'").get() as { c: number }).c;
  const dispositifsTotal = (db.prepare('SELECT COUNT(*) AS c FROM dispositifs').get() as { c: number }).c;
  const declarationsSoumises = (
    db.prepare("SELECT COUNT(*) AS c FROM declarations WHERE annee = ? AND statut = 'soumise'").get(annee) as { c: number }
  ).c;
  const declarationsValidees = (
    db.prepare("SELECT COUNT(*) AS c FROM declarations WHERE annee = ? AND statut = 'validee'").get(annee) as { c: number }
  ).c;
  const declarationsRejetees = (
    db.prepare("SELECT COUNT(*) AS c FROM declarations WHERE annee = ? AND statut = 'rejetee'").get(annee) as { c: number }
  ).c;
  const declarationsRecues = declarationsSoumises + declarationsValidees + declarationsRejetees;

  const declarationsRecuesNm1 = (
    db
      .prepare("SELECT COUNT(*) AS c FROM declarations WHERE annee = ? AND statut IN ('soumise','validee','rejetee')")
      .get(annee - 1) as { c: number }
  ).c;

  const declarationsAttendues = assujettisActifs;
  const tauxDeclaration = computeRate(declarationsRecues, declarationsAttendues);
  const tauxDeclarationNm1 = computeRate(declarationsRecuesNm1, declarationsAttendues);

  const contentieuxOuverts = (
    db.prepare("SELECT COUNT(*) AS c FROM contentieux WHERE statut IN ('ouvert','instruction')").get() as { c: number }
  ).c;
  const montantLitige = (
    db.prepare("SELECT COALESCE(SUM(montant_litige),0) AS s FROM contentieux WHERE statut IN ('ouvert','instruction')").get() as { s: number }
  ).s;
  const contentieuxAlertesTotal = (
    db.prepare(
      `SELECT COUNT(*) AS c
       FROM contentieux
       WHERE statut IN ('ouvert','instruction')
         AND date_limite_reponse IS NOT NULL
         AND julianday(date_limite_reponse) - julianday(?) <= 30`,
    ).get(nowDateIso) as { c: number }
  ).c;
  const contentieuxAlertesOverdue = (
    db.prepare(
      `SELECT COUNT(*) AS c
       FROM contentieux
       WHERE statut IN ('ouvert','instruction')
         AND date_limite_reponse IS NOT NULL
         AND date_limite_reponse < ?`,
    ).get(nowDateIso) as { c: number }
  ).c;

  const repartitionCategories = db
    .prepare(
      `SELECT t.categorie, COUNT(d.id) AS nb
       FROM dispositifs d
       JOIN types_dispositifs t ON t.id = d.type_id
       GROUP BY t.categorie`,
    )
    .all();

  const derniersTitres = db
    .prepare(
      `SELECT t.*, a.raison_sociale
       FROM titres t
       LEFT JOIN assujettis a ON a.id = t.assujetti_id
       ORDER BY t.date_emission DESC
       LIMIT 8`,
    )
    .all();

  const byZoneRaw = db
    .prepare(
      `SELECT
         COALESCE(z.libelle, 'Non zone') AS label,
         COUNT(DISTINCT a.id) AS assujettis_attendus,
         COUNT(DISTINCT CASE WHEN dec.statut = 'soumise' THEN a.id END) AS declarations_soumises,
         COUNT(DISTINCT CASE WHEN dec.statut = 'validee' THEN a.id END) AS declarations_validees,
         COUNT(DISTINCT CASE WHEN dec.statut = 'rejetee' THEN a.id END) AS declarations_rejetees
       FROM assujettis a
       LEFT JOIN dispositifs d ON d.assujetti_id = a.id
       LEFT JOIN zones z ON z.id = d.zone_id
       LEFT JOIN declarations dec ON dec.assujetti_id = a.id AND dec.annee = ?
       WHERE a.statut = 'actif'
       GROUP BY COALESCE(z.libelle, 'Non zone')
       ORDER BY assujettis_attendus DESC, label ASC`,
    )
    .all(annee) as Array<Omit<DrilldownRow, 'taux_declaration'>>;

  const byTypeRaw = db
    .prepare(
      `SELECT
         COALESCE(NULLIF(a.forme_juridique, ''), 'Non renseigne') AS label,
         COUNT(*) AS assujettis_attendus,
         COUNT(CASE WHEN dec.statut = 'soumise' THEN 1 END) AS declarations_soumises,
         COUNT(CASE WHEN dec.statut = 'validee' THEN 1 END) AS declarations_validees,
         COUNT(CASE WHEN dec.statut = 'rejetee' THEN 1 END) AS declarations_rejetees
       FROM assujettis a
       LEFT JOIN declarations dec ON dec.assujetti_id = a.id AND dec.annee = ?
       WHERE a.statut = 'actif'
       GROUP BY COALESCE(NULLIF(a.forme_juridique, ''), 'Non renseigne')
       ORDER BY assujettis_attendus DESC, label ASC`,
    )
    .all(annee) as Array<Omit<DrilldownRow, 'taux_declaration'>>;

  const dateStart = campagne?.date_ouverture ?? `${annee}-01-01`;
  const dateEnd = campagne?.date_limite_declaration ?? new Date().toISOString().slice(0, 10);

  const evolutionJournaliere = db
    .prepare(
      `WITH RECURSIVE jours(date_jour) AS (
         SELECT date(?)
         UNION ALL
         SELECT date(date_jour, '+1 day')
         FROM jours
         WHERE date_jour < date(?)
       ),
       soumissions AS (
         SELECT
           date(COALESCE(date_soumission, created_at)) AS date_jour,
           COUNT(*) AS soumissions_jour
         FROM declarations
         WHERE annee = ?
           AND statut IN ('soumise','validee','rejetee')
         GROUP BY date(COALESCE(date_soumission, created_at))
       )
       SELECT
         j.date_jour AS date,
         COALESCE(s.soumissions_jour, 0) AS soumissions_jour,
         SUM(COALESCE(s.soumissions_jour, 0)) OVER (ORDER BY j.date_jour) AS cumul_soumissions
       FROM jours j
       LEFT JOIN soumissions s ON s.date_jour = j.date_jour
       ORDER BY j.date_jour ASC`,
    )
    .all(dateStart, dateEnd, annee);

  const withRate = (rows: Array<Omit<DrilldownRow, 'taux_declaration'>>) =>
    rows.map((row) => {
      const recues = row.declarations_soumises + row.declarations_validees + row.declarations_rejetees;
      return {
        ...row,
        taux_declaration: computeRate(recues, row.assujettis_attendus),
      };
    });

  return {
    annee,
    campagne: campagne
      ? {
          id: campagne.id,
          date_ouverture: campagne.date_ouverture,
          date_limite_declaration: campagne.date_limite_declaration,
        }
      : null,
    financier: {
      montant_emis_n: montantEmisN,
      montant_emis_nm1: montantEmisNm1,
      montant_recouvre: montantRecouvre,
      taux_recouvrement: computeRate(montantRecouvre, montantEmisN),
      montant_impaye: montantImpaye,
      montant_litige: montantLitige,
      evolution_n_nm1: montantEmisNm1 > 0 ? (montantEmisN - montantEmisNm1) / montantEmisNm1 : null,
    },
    operationnel: {
      assujettis_actifs: assujettisActifs,
      dispositifs_total: dispositifsTotal,
      declarations_recues: declarationsRecues,
      declarations_attendues: declarationsAttendues,
      declarations_soumises: declarationsSoumises,
      declarations_validees: declarationsValidees,
      declarations_rejetees: declarationsRejetees,
      taux_declaration: tauxDeclaration,
      evolution_taux_vs_nm1: tauxDeclarationNm1 > 0 ? tauxDeclaration - tauxDeclarationNm1 : null,
      contentieux_ouverts: contentieuxOuverts,
      contentieux_alertes_total: contentieuxAlertesTotal,
      contentieux_alertes_overdue: contentieuxAlertesOverdue,
    },
    repartition_categories: repartitionCategories,
    derniers_titres: derniersTitres,
    drilldown: {
      by_zone: withRate(byZoneRaw),
      by_type_assujetti: withRate(byTypeRaw),
    },
    evolution_journaliere: evolutionJournaliere,
  };
}