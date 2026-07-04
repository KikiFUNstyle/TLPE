/**
 * Route DGFiP Recettes Fiscales (US8.7 / §10.3)
 *
 * Export XML au format DGFiP de la déclaration des recettes fiscales
 * encaissées, avec sélecteur de période, contrôle de cohérence des
 * montants, et signature numérique optionnelle de l'ordonnateur.
 *
 * Rôles autorisés : admin, financier
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import { db } from '../db';
import { requireRole, authMiddleware } from '../auth';

// ---------------------------------------------------------------------------
// Schémas de validation
// ---------------------------------------------------------------------------

const dgfipRecettesSchema = z.object({
  annee: z.number().int().min(2020).max(2100),
  trimestre: z.number().int().min(1).max(4).optional(),
  signature: z
    .object({
      signataire: z.string().min(1).max(255),
      fonction: z.string().min(1).max(255),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Erreur métier
// ---------------------------------------------------------------------------

class DgfipRecettesError extends Error {
  status: number;
  constructor(message: string, status: number = 500) {
    super(message);
    this.name = 'DgfipRecettesError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Helper : localiser le schéma XSD
// ---------------------------------------------------------------------------

function resolveXsdPath(): string {
  const currentDir = __dirname;
  const candidates = [
    path.resolve(currentDir, '..', 'xsd', 'dgfip-recettes-fiscales.xsd'),
    path.resolve(currentDir, '..', '..', 'src', 'xsd', 'dgfip-recettes-fiscales.xsd'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new DgfipRecettesError('Schéma XSD DGFiP recettes introuvable', 500);
}

// ---------------------------------------------------------------------------
// Helper : rechercher xmllint (validation XSD)
// ---------------------------------------------------------------------------

function findXmllint(): string | null {
  try {
    const result = execSync('which xmllint 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper : échappement XML
// ---------------------------------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// Helper : date au format ISO
// ---------------------------------------------------------------------------

function toDateStr(d: string): string {
  return d ? d.slice(0, 10) : new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Génération XML
// ---------------------------------------------------------------------------

function buildRecettesXml(params: {
  collectivite: string;
  ordonnateur: string;
  siret: string;
  numeroBordereau: number;
  annee: number;
  trimestre: number | undefined;
  typePeriode: 'annuel' | 'trimestriel';
  titres: Array<{
    numero: string;
    assujetti_denomination: string;
    assujetti_siret: string;
    assujetti_adresse: string;
    date_emission: string;
    date_echeance: string;
    montant: number;
    montant_recouvre: number;
    montant_impaye: number;
    statut: string;
    paiements: Array<{
      date_paiement: string;
      montant: number;
      modalite: string;
      reference: string | null;
    }>;
  }>;
  totalMontantBrut: number;
  totalMontantRecouvre: number;
  totalMontantImpaye: number;
  coherenceOk: boolean;
  signature?: {
    signataire: string;
    fonction: string;
  };
}): string {
  const now = new Date().toISOString();
  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<DGFiPRecettesFiscales>');

  // Entête
  lines.push('  <Entete>');
  lines.push(`    <Collectivite>${escapeXml(params.collectivite)}</Collectivite>`);
  lines.push(`    <Siret>${escapeXml(params.siret)}</Siret>`);
  lines.push(`    <Ordonnateur>${escapeXml(params.ordonnateur)}</Ordonnateur>`);
  lines.push(`    <NumeroBordereau>${escapeXml(String(params.numeroBordereau))}</NumeroBordereau>`);
  lines.push(`    <HorodatageExport>${now}</HorodatageExport>`);
  lines.push(`    <TypePeriode>${params.typePeriode}</TypePeriode>`);
  lines.push(`    <Annee>${params.annee}</Annee>`);
  if (params.trimestre !== undefined) {
    lines.push(`    <Trimestre>${params.trimestre}</Trimestre>`);
  }
  lines.push('  </Entete>');

  // Récapitulatif
  lines.push('  <Recapitulatif>');
  lines.push(`    <TotalTitresEmis>${params.titres.length}</TotalTitresEmis>`);
  lines.push(`    <TotalMontantBrut>${params.totalMontantBrut.toFixed(2)}</TotalMontantBrut>`);
  lines.push(`    <TotalMontantRecouvre>${params.totalMontantRecouvre.toFixed(2)}</TotalMontantRecouvre>`);
  lines.push(`    <TotalMontantImpaye>${params.totalMontantImpaye.toFixed(2)}</TotalMontantImpaye>`);
  lines.push(`    <CoherenceVerifiee>${params.coherenceOk}</CoherenceVerifiee>`);
  lines.push(`    <DateArrete>${new Date().toISOString().slice(0, 10)}</DateArrete>`);
  lines.push('  </Recapitulatif>');

  // Titres
  lines.push('  <Titres>');
  for (const t of params.titres) {
    lines.push('    <Titre>');
    lines.push(`      <NumeroTitre>${escapeXml(t.numero)}</NumeroTitre>`);
    lines.push(`      <IdentifiantAssujetti>${escapeXml(t.assujetti_siret || t.assujetti_denomination)}</IdentifiantAssujetti>`);
    lines.push(`      <DenominationAssujetti>${escapeXml(t.assujetti_denomination)}</DenominationAssujetti>`);
    if (t.assujetti_siret) {
      lines.push(`      <SiretAssujetti>${escapeXml(t.assujetti_siret)}</SiretAssujetti>`);
    }
    if (t.assujetti_adresse) {
      lines.push(`      <AdresseAssujetti>${escapeXml(t.assujetti_adresse)}</AdresseAssujetti>`);
    }
    lines.push(`      <DateEmission>${toDateStr(t.date_emission)}</DateEmission>`);
    lines.push(`      <DateEcheance>${toDateStr(t.date_echeance)}</DateEcheance>`);
    lines.push(`      <MontantTitre>${t.montant.toFixed(2)}</MontantTitre>`);
    lines.push(`      <MontantRecouvre>${t.montant_recouvre.toFixed(2)}</MontantRecouvre>`);
    lines.push(`      <MontantImpaye>${t.montant_impaye.toFixed(2)}</MontantImpaye>`);
    lines.push(`      <Statut>${escapeXml(t.statut)}</Statut>`);

    if (t.paiements.length > 0) {
      lines.push('      <ModalitesPaiement>');
      for (const p of t.paiements) {
        lines.push('        <Paiement>');
        lines.push(`          <DatePaiement>${toDateStr(p.date_paiement)}</DatePaiement>`);
        lines.push(`          <Montant>${p.montant.toFixed(2)}</Montant>`);
        lines.push(`          <Modalite>${escapeXml(p.modalite)}</Modalite>`);
        if (p.reference) {
          lines.push(`          <Reference>${escapeXml(p.reference)}</Reference>`);
        }
        lines.push('        </Paiement>');
      }
      lines.push('      </ModalitesPaiement>');
    }

    lines.push('    </Titre>');
  }
  lines.push('  </Titres>');

  // Signature optionnelle
  if (params.signature) {
    // La signature est un hash SHA-256 du contenu XML (sans la balise signature)
    // pour garantir l'intégrité du document
    const contentForSignature = lines.join('\n');
    const signatureValue = crypto
      .createHash('sha256')
      .update(contentForSignature)
      .digest('hex')
      .toUpperCase();

    lines.push('  <SignatureOptionnelle>');
    lines.push(`    <Signataire>${escapeXml(params.signature.signataire)}</Signataire>`);
    lines.push(`    <Fonction>${escapeXml(params.signature.fonction)}</Fonction>`);
    lines.push(`    <DateSignature>${new Date().toISOString().slice(0, 10)}</DateSignature>`);
    lines.push(`    <ValeurSignature>${signatureValue}</ValeurSignature>`);
    lines.push('  </SignatureOptionnelle>');
  }

  lines.push('</DGFiPRecettesFiscales>');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helper : construire les données de l'export
// ---------------------------------------------------------------------------

function buildExportData(params: { annee: number; trimestre?: number }) {
  const { annee, trimestre } = params;

  // Déterminer la plage de dates selon le type de période
  let dateDebut: string;
  let dateFin: string;
  let typePeriode: 'annuel' | 'trimestriel';

  if (trimestre !== undefined) {
    typePeriode = 'trimestriel';
    const trimStartMonth = (trimestre - 1) * 3 + 1;
    dateDebut = `${annee}-${String(trimStartMonth).padStart(2, '0')}-01`;
    // Dernier jour du trimestre
    const trimEndMonth = trimestre * 3;
    dateFin =
      trimEndMonth === 12
        ? `${annee}-12-31`
        : `${annee}-${String(trimEndMonth + 1).padStart(2, '0')}-01`;
  } else {
    typePeriode = 'annuel';
    dateDebut = `${annee}-01-01`;
    dateFin = `${annee}-12-31`;
  }

  // Récupérer les titres émis dans la période avec leurs paiements
  const titres = db
    .prepare(
      `SELECT
        t.id, t.numero, t.montant, t.montant_paye,
        t.date_emission, t.date_echeance, t.statut,
        a.raison_sociale AS assujetti_denomination,
        a.siret AS assujetti_siret,
        a.adresse_rue AS assujetti_adresse
      FROM titres t
      JOIN assujettis a ON a.id = t.assujetti_id
      WHERE t.annee = ?${trimestre !== undefined ? ' AND t.date_emission >= ? AND t.date_emission < ?' : ''}
      ORDER BY t.numero`
    )
    .all(trimestre !== undefined ? [annee, dateDebut, dateFin] : [annee]) as Array<{
    id: number;
    numero: string;
    montant: number;
    montant_paye: number;
    date_emission: string;
    date_echeance: string;
    statut: string;
    assujetti_denomination: string;
    assujetti_siret: string;
    assujetti_adresse: string;
  }>;

  // Pour chaque titre, récupérer les paiements
  const titresWithPayments = titres.map((t) => {
    const paiements = db
      .prepare(
        `SELECT date_paiement, montant, modalite, reference
       FROM paiements
       WHERE titre_id = ? AND statut = 'confirme'
       ORDER BY date_paiement`
      )
      .all(t.id) as Array<{
      date_paiement: string;
      montant: number;
      modalite: string;
      reference: string | null;
    }>;

    const montant_recouvre = paiements.reduce((sum, p) => sum + p.montant, 0);
    const montant_impaye = Math.max(0, t.montant - montant_recouvre);

    return {
      numero: t.numero,
      assujetti_denomination: t.assujetti_denomination,
      assujetti_siret: t.assujetti_siret || '',
      assujetti_adresse: t.assujetti_adresse || '',
      date_emission: t.date_emission,
      date_echeance: t.date_echeance,
      montant: t.montant,
      montant_paye: t.montant_paye,
      montant_recouvre,
      montant_impaye,
      statut: t.statut,
      paiements,
    };
  });

  // Calcul des totaux
  const totalMontantBrut = titresWithPayments.reduce((s, t) => s + t.montant, 0);
  const totalMontantRecouvre = titresWithPayments.reduce((s, t) => s + t.montant_recouvre, 0);
  const totalMontantImpaye = titresWithPayments.reduce((s, t) => s + t.montant_impaye, 0);

  // Contrôle de cohérence : brut = recouvré + impayé
  const coherenceOk =
    Math.abs(totalMontantBrut - (totalMontantRecouvre + totalMontantImpaye)) < 0.01;

  // Récupérer les infos de la collectivité (première ligne de l'org)
  const communeInfo = db
    .prepare("SELECT raison_sociale AS denomination, siret FROM assujettis ORDER BY id LIMIT 1")
    .get() as { denomination: string; siret: string } | undefined;

  return {
    collectivite: communeInfo?.denomination || 'Collectivité TLPE',
    ordonnateur: 'Ordonnateur TLPE',
    siret: communeInfo?.siret || '',
    numeroBordereau: 0, // sera défini à la persistence
    annee,
    trimestre,
    typePeriode,
    dateDebut,
    dateFin,
    titres: titresWithPayments,
    totalMontantBrut: Math.round(totalMontantBrut * 100) / 100,
    totalMontantRecouvre: Math.round(totalMontantRecouvre * 100) / 100,
    totalMontantImpaye: Math.round(totalMontantImpaye * 100) / 100,
    coherenceOk,
  };
}

// ---------------------------------------------------------------------------
// Route POST /api/dgfip-recettes/export
// ---------------------------------------------------------------------------

const dgfipRecettesRouter = Router();
dgfipRecettesRouter.use(authMiddleware);

dgfipRecettesRouter.post(
  '/export',
  requireRole('admin', 'financier'),
  (req: Request, res: Response) => {
    try {
      const parsed = dgfipRecettesSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Parametres invalides',
          details: parsed.error.issues,
        });
      }

      const { annee, trimestre, signature } = parsed.data;
      const userId = (req as any).user?.id;

      // Construire les données d'export
      const exportData = buildExportData({ annee, trimestre });

      // Générer le prochain numéro de bordereau
      const lastBordereau = db
        .prepare(
          'SELECT COALESCE(MAX(numero_bordereau), 0) + 1 AS next_numero FROM dgfip_recettes_exports'
        )
        .get() as { next_numero: number };
      const numeroBordereau = lastBordereau.next_numero;
      exportData.numeroBordereau = numeroBordereau;

      // Construire le XML
      const xml = buildRecettesXml({
        ...exportData,
        signature: signature
          ? { signataire: signature.signataire, fonction: signature.fonction }
          : undefined,
        coherenceOk: exportData.coherenceOk,
      });
      const xmlHash = crypto.createHash('sha256').update(xml, 'utf-8').digest('hex');

      // Valider avec xmllint si disponible
      let xsdValidationOk = 0;
      let xsdValidationReport = '';
      const xmllint = findXmllint();
      if (xmllint) {
        const xsdPath = resolveXsdPath();
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlpe-dgfip-recettes-'));
        const xmlPath = path.join(tempDir, 'export.xml');
        try {
          fs.writeFileSync(xmlPath, xml, 'utf-8');
          try {
            const validationOutput = execSync(
              `${xmllint} --noout --schema "${xsdPath}" "${xmlPath}" 2>&1`,
              { encoding: 'utf-8', timeout: 15000 }
            );
            xsdValidationOk = 1;
            xsdValidationReport = validationOutput.trim() || 'Validation XSD OK';
          } catch (validationErr: any) {
            xsdValidationOk = 0;
            xsdValidationReport =
              validationErr.stderr?.trim() || validationErr.message || 'Echec validation XSD';
          }
        } finally {
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch {
            // nettoyage silencieux
          }
        }
      }

      // Persister l'export
      const filename = `dgfip-recettes-${String(numeroBordereau).padStart(6, '0')}.xml`;

      const insertExport = db.prepare(
        `INSERT INTO dgfip_recettes_exports (
          annee, trimestre, type_periode, numero_bordereau,
          xml_filename, xml_content, xml_hash,
          xsd_validation_ok, xsd_validation_report,
          total_montant_brut, total_montant_recouvre, total_montant_impaye,
          titres_count, coherence_ok, signature_ordonnateur,
          exported_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      const signatureJson = signature
        ? JSON.stringify(signature)
        : null;

      const result = insertExport.run(
        annee,
        trimestre ?? null,
        exportData.typePeriode,
        numeroBordereau,
        filename,
        xml,
        xmlHash,
        xsdValidationOk,
        xsdValidationReport,
        exportData.totalMontantBrut,
        exportData.totalMontantRecouvre,
        exportData.totalMontantImpaye,
        exportData.titres.length,
        exportData.coherenceOk ? 1 : 0,
        signatureJson,
        userId ?? null
      );
      const exportId = result.lastInsertRowid;

      // Lier les titres exportés
      const insertLien = db.prepare(
        `INSERT INTO dgfip_recettes_export_titres (export_id, titre_id, assujetti_id,
          montant_titre, montant_paye, montant_impaye, statut_titre)
        SELECT ?, t.id, t.assujetti_id, t.montant, t.montant_paye,
          MAX(0, t.montant - t.montant_paye), t.statut
        FROM titres t
        WHERE t.annee = ?${trimestre !== undefined ? ' AND t.date_emission >= ? AND t.date_emission < ?' : ''}`
      );
      insertLien.run(trimestre !== undefined ? [exportId, annee, exportData.dateDebut, exportData.dateFin] : [exportId, annee]);

      // Audit log
      const logAudit = db.prepare(
        `INSERT INTO audit_log (user_id, action, entite, entite_id, details)
       VALUES (?, 'export-dgfip-recettes', 'dgfip_recettes_exports', ?, ?)`
      );
      logAudit.run(
        userId ?? null,
        exportId,
        JSON.stringify({
          annee,
          trimestre: trimestre ?? null,
          filename,
          titres_count: exportData.titres.length,
          total_montant_brut: exportData.totalMontantBrut,
          coherence_ok: exportData.coherenceOk,
          xsd_valid: xsdValidationOk === 1,
          signature: signature ? true : false,
        })
      );

      // Réponse
      return res.status(201).json({
        export_id: exportId,
        numero_bordereau: numeroBordereau,
        filename,
        xml_hash: xmlHash,
        xsd_validation_ok: xsdValidationOk === 1,
        xsd_validation_report: xsdValidationReport || undefined,
        coherence_ok: exportData.coherenceOk,
        recapitulatif: {
          titres_count: exportData.titres.length,
          total_montant_brut: exportData.totalMontantBrut,
          total_montant_recouvre: exportData.totalMontantRecouvre,
          total_montant_impaye: exportData.totalMontantImpaye,
        },
      });
    } catch (error) {
      if (error instanceof DgfipRecettesError) {
        return res.status(error.status).json({
          error: error.status >= 500 ? 'Erreur interne export DGFiP recettes' : error.message,
        });
      }
      console.error('[TLPE] Erreur export DGFiP recettes inattendue', error);
      return res.status(500).json({ error: 'Erreur interne export DGFiP recettes' });
    }
  }
);

// ---------------------------------------------------------------------------
// Route GET /api/dgfip-recettes/exports — liste des exports
// ---------------------------------------------------------------------------

dgfipRecettesRouter.get(
  '/exports',
  requireRole('admin', 'financier'),
  (req: Request, res: Response) => {
    try {
      const exports = db
        .prepare(
          `SELECT id, annee, trimestre, type_periode, numero_bordereau,
            xml_filename, xml_hash, xsd_validation_ok,
            total_montant_brut, total_montant_recouvre, total_montant_impaye,
            titres_count, coherence_ok,
            exported_at, exported_by
          FROM dgfip_recettes_exports
          ORDER BY exported_at DESC
          LIMIT 50`
        )
        .all();

      return res.json({ exports });
    } catch (error) {
      console.error('[TLPE] Erreur liste exports DGFiP recettes', error);
      return res.status(500).json({ error: 'Erreur interne' });
    }
  }
);

// ---------------------------------------------------------------------------
// Route GET /api/dgfip-recettes/exports/:id/download — téléchargement XML
// ---------------------------------------------------------------------------

dgfipRecettesRouter.get(
  '/exports/:id/download',
  requireRole('admin', 'financier'),
  (req: Request, res: Response) => {
    try {
      const exportRow = db
        .prepare('SELECT xml_content, xml_filename FROM dgfip_recettes_exports WHERE id = ?')
        .get(Number(req.params.id)) as { xml_content: string; xml_filename: string } | undefined;

      if (!exportRow) {
        return res.status(404).json({ error: 'Export introuvable' });
      }

      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${exportRow.xml_filename}"`
      );
      return res.send(exportRow.xml_content);
    } catch (error) {
      console.error('[TLPE] Erreur download export DGFiP recettes', error);
      return res.status(500).json({ error: 'Erreur interne' });
    }
  }
);

export { dgfipRecettesRouter };
