import { Router } from 'express';
import { db } from '../db';
import { authMiddleware } from '../auth';

export const dashboardRouter = Router();

dashboardRouter.use(authMiddleware);

// Tableau de bord executif (section 10.1)
dashboardRouter.get('/', (_req, res) => {
  const currentYear = new Date().getFullYear();
  const n = (db.prepare('SELECT COALESCE(SUM(montant), 0) AS s FROM titres WHERE annee = ?').get(currentYear) as { s: number }).s;
  const nm1 = (db.prepare('SELECT COALESCE(SUM(montant), 0) AS s FROM titres WHERE annee = ?').get(currentYear - 1) as { s: number }).s;
  const recouvre = (db.prepare('SELECT COALESCE(SUM(montant_paye), 0) AS s FROM titres WHERE annee = ?').get(currentYear) as { s: number }).s;
  const impaye = (
    db
      .prepare(
        `SELECT COALESCE(SUM(montant - montant_paye), 0) AS s FROM titres
         WHERE statut IN ('emis','paye_partiel','impaye','mise_en_demeure')
         AND date_echeance < date('now')`,
      )
      .get() as { s: number }
  ).s;
  const assujettisActifs = (db.prepare("SELECT COUNT(*) AS c FROM assujettis WHERE statut = 'actif'").get() as { c: number }).c;
  const dispositifs = (db.prepare('SELECT COUNT(*) AS c FROM dispositifs').get() as { c: number }).c;
  const declarationsRecues = (db.prepare("SELECT COUNT(*) AS c FROM declarations WHERE annee = ? AND statut != 'brouillon'").get(currentYear) as { c: number }).c;
  const declarationsAttendues = assujettisActifs;
  const contentieuxOuverts = (db.prepare("SELECT COUNT(*) AS c FROM contentieux WHERE statut IN ('ouvert','instruction')").get() as { c: number }).c;
  const montantLitige = (db.prepare("SELECT COALESCE(SUM(montant_litige),0) AS s FROM contentieux WHERE statut IN ('ouvert','instruction')").get() as { s: number }).s;

  const tauxRecouvrement = n > 0 ? recouvre / n : 0;
  const evolution = nm1 > 0 ? (n - nm1) / nm1 : null;

  // Repartition par categorie de dispositif (pour graph)
  const repartitionCategories = db
    .prepare(
      `SELECT t.categorie, COUNT(d.id) AS nb
       FROM dispositifs d JOIN types_dispositifs t ON t.id = d.type_id
       GROUP BY t.categorie`,
    )
    .all();

  // Derniers titres
  const derniersTitres = db
    .prepare(
      `SELECT t.*, a.raison_sociale FROM titres t
       LEFT JOIN assujettis a ON a.id = t.assujetti_id
       ORDER BY t.date_emission DESC LIMIT 8`,
    )
    .all();

  res.json({
    annee: currentYear,
    financier: {
      montant_emis_n: n,
      montant_emis_nm1: nm1,
      montant_recouvre: recouvre,
      taux_recouvrement: tauxRecouvrement,
      montant_impaye: impaye,
      montant_litige: montantLitige,
      evolution_n_nm1: evolution,
    },
    operationnel: {
      assujettis_actifs: assujettisActifs,
      dispositifs_total: dispositifs,
      declarations_recues: declarationsRecues,
      declarations_attendues: declarationsAttendues,
      taux_declaration: declarationsAttendues > 0 ? declarationsRecues / declarationsAttendues : 0,
      contentieux_ouverts: contentieuxOuverts,
    },
    repartition_categories: repartitionCategories,
    derniers_titres: derniersTitres,
  });
});
