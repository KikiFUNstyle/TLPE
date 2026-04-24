import { Router } from 'express';
import { z } from 'zod';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { electronicFormatIBAN, isValidBIC, isValidIBAN } from 'ibantools';
import { authMiddleware, requireRole } from '../auth';
import { db, logAudit } from '../db';

export const sepaRouter = Router();
sepaRouter.use(authMiddleware);

const DEFAULT_CREDITOR_NAME = 'Collectivite territoriale';
const DEFAULT_CREDITOR_IBAN = 'FR1420041010050500013M02606';
const DEFAULT_CREDITOR_BIC = 'PSSTFRPPPAR';
const DEFAULT_CREDITOR_ICS = 'FR12ZZZ123456';

export class SepaRouteError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SepaRouteError';
  }
}

type MandatRow = {
  id: number;
  assujetti_id: number;
  rum: string;
  iban: string;
  bic: string;
  date_signature: string;
  statut: 'actif' | 'revoque';
  date_revocation: string | null;
  created_at: string;
};

type DueTitreRow = {
  titre_id: number;
  numero: string;
  assujetti_id: number;
  raison_sociale: string;
  montant_restant: number;
  date_echeance: string;
  mandat_id: number;
  rum: string;
  iban: string;
  bic: string;
  date_signature: string;
};

type SepaOrder = DueTitreRow & {
  sequence_type: 'FRST' | 'RCUR';
};

type SepaValidationResult = {
  ok: boolean;
  report: string;
};

export const mandatCreateSchema = z.object({
  rum: z.string().trim().min(3).max(64),
  iban: z.string().trim().min(5).max(64),
  bic: z.string().trim().min(8).max(11),
  date_signature: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const exportBatchSchema = z
  .object({
    date_reference: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    date_prelevement: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .superRefine((data, ctx) => {
    if (data.date_reference > data.date_prelevement) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['date_prelevement'],
        message: 'date_prelevement doit être postérieure ou égale à date_reference',
      });
    }
  });

export const revokeMandatSchema = z.object({
  date_revocation: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

function normalizeIsoDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new SepaRouteError(`Date invalide: ${value}`, 400);
  }
  const normalized = parsed.toISOString().slice(0, 10);
  if (normalized !== value) {
    throw new SepaRouteError(`Date invalide: ${value}`, 400);
  }
  return normalized;
}

function normalizeRum(value: string): string {
  return value.trim().replace(/\s+/g, '-').slice(0, 64);
}

function normalizeIban(value: string): string {
  const normalized = electronicFormatIBAN(value) ?? value.replace(/\s+/g, '').toUpperCase();
  return normalized;
}

function normalizeBic(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

function maskIban(iban: string): string {
  const tail = iban.slice(-4);
  return `****${tail}`;
}

function xmlEscape(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function resolveSepaXsdPath(currentDir = __dirname): string {
  const candidates = [
    path.resolve(currentDir, '..', 'xsd', 'pain.008.001.02.xsd'),
    path.resolve(currentDir, '..', '..', 'src', 'xsd', 'pain.008.001.02.xsd'),
  ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved) {
    throw new SepaRouteError('XSD SEPA introuvable', 500);
  }
  return resolved;
}

function validateSepaXml(xml: string): SepaValidationResult {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlpe-sepa-'));
  const xmlPath = path.join(tempDir, 'pain.008.xml');
  const xsdPath = resolveSepaXsdPath();
  fs.writeFileSync(xmlPath, xml, 'utf8');
  try {
    const stdout = execFileSync('xmllint', ['--noout', '--schema', xsdPath, xmlPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      ok: true,
      report: (stdout || 'xmllint validation ok').trim(),
    };
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String((error as { stderr?: string | Buffer }).stderr ?? '').trim()
        : String(error);
    return {
      ok: false,
      report: stderr || 'Validation XSD SEPA en echec',
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function getSepaCreditorConfig() {
  const creditor = {
    name: process.env.TLPE_SEPA_CREDITOR_NAME || DEFAULT_CREDITOR_NAME,
    iban: normalizeIban(process.env.TLPE_SEPA_CREDITOR_IBAN || DEFAULT_CREDITOR_IBAN),
    bic: normalizeBic(process.env.TLPE_SEPA_CREDITOR_BIC || DEFAULT_CREDITOR_BIC),
    ics: process.env.TLPE_SEPA_CREDITOR_ICS || DEFAULT_CREDITOR_ICS,
  };

  if (!isValidIBAN(creditor.iban)) {
    throw new SepaRouteError('IBAN créancier invalide', 500);
  }
  if (!isValidBIC(creditor.bic)) {
    throw new SepaRouteError('BIC créancier invalide', 500);
  }

  return creditor;
}

function nextSepaNumeroLot(): number {
  const row = db.prepare('SELECT COALESCE(MAX(numero_lot), 0) + 1 AS next_numero FROM sepa_exports').get() as {
    next_numero: number;
  };
  return row.next_numero;
}

function loadDueTitres(dateReference: string): DueTitreRow[] {
  return db
    .prepare(
      `SELECT
         t.id AS titre_id,
         t.numero,
         t.assujetti_id,
         a.raison_sociale,
         ROUND(t.montant - COALESCE(t.montant_paye, 0), 2) AS montant_restant,
         t.date_echeance,
         m.id AS mandat_id,
         m.rum,
         m.iban,
         m.bic,
         m.date_signature
       FROM titres t
       JOIN assujettis a ON a.id = t.assujetti_id
       JOIN mandats_sepa m
         ON m.assujetti_id = t.assujetti_id
        AND m.statut = 'actif'
       LEFT JOIN sepa_prelevements sp ON sp.titre_id = t.id
       WHERE t.date_echeance <= ?
         AND t.statut IN ('emis', 'paye_partiel', 'impaye', 'mise_en_demeure')
         AND ROUND(t.montant - COALESCE(t.montant_paye, 0), 2) > 0
         AND sp.id IS NULL
       ORDER BY t.date_echeance, t.numero`,
    )
    .all(dateReference) as DueTitreRow[];
}

function buildSepaOrders(dateReference: string): SepaOrder[] {
  const dueTitres = loadDueTitres(dateReference);
  if (dueTitres.length === 0) {
    return [];
  }

  const priorRows = db
    .prepare(
      `SELECT mandat_id, COUNT(*) AS exported_count
       FROM sepa_prelevements
       WHERE statut = 'exporte'
       GROUP BY mandat_id`,
    )
    .all() as Array<{ mandat_id: number; exported_count: number }>;
  const priorByMandat = new Map(priorRows.map((row) => [row.mandat_id, row.exported_count]));
  const firstSeenThisBatch = new Set<number>();

  return dueTitres.map((titre) => {
    const priorCount = priorByMandat.get(titre.mandat_id) ?? 0;
    const isFirst = priorCount === 0 && !firstSeenThisBatch.has(titre.mandat_id);
    firstSeenThisBatch.add(titre.mandat_id);
    return {
      ...titre,
      sequence_type: isFirst ? 'FRST' : 'RCUR',
    };
  });
}

function buildSepaXml(orders: SepaOrder[], numeroLot: number, datePrelevement: string) {
  const creditor = getSepaCreditorConfig();
  const totalMontant = Number(orders.reduce((sum, order) => sum + order.montant_restant, 0).toFixed(2));
  const messageId = `TLPE-SEPA-${String(numeroLot).padStart(6, '0')}`;
  const createdAt = new Date().toISOString();

  const groups = new Map<'FRST' | 'RCUR', SepaOrder[]>();
  for (const order of orders) {
    const current = groups.get(order.sequence_type) ?? [];
    current.push(order);
    groups.set(order.sequence_type, current);
  }

  const paymentInfos = Array.from(groups.entries())
    .map(([sequenceType, group], groupIndex) => {
      const groupTotal = Number(group.reduce((sum, order) => sum + order.montant_restant, 0).toFixed(2));
      const txs = group
        .map(
          (order, orderIndex) => `
        <DrctDbtTxInf>
          <PmtId>
            <InstrId>${xmlEscape(`SEPA-${sequenceType}-${groupIndex + 1}-${orderIndex + 1}`)}</InstrId>
            <EndToEndId>${xmlEscape(`${order.rum}-${order.numero}`)}</EndToEndId>
          </PmtId>
          <InstdAmt Ccy="EUR">${order.montant_restant.toFixed(2)}</InstdAmt>
          <DrctDbtTx>
            <MndtRltdInf>
              <MndtId>${xmlEscape(order.rum)}</MndtId>
              <DtOfSgntr>${xmlEscape(order.date_signature)}</DtOfSgntr>
            </MndtRltdInf>
          </DrctDbtTx>
          <DbtrAgt>
            <FinInstnId>
              <BIC>${xmlEscape(order.bic)}</BIC>
            </FinInstnId>
          </DbtrAgt>
          <Dbtr>
            <Nm>${xmlEscape(order.raison_sociale)}</Nm>
          </Dbtr>
          <DbtrAcct>
            <Id>
              <IBAN>${xmlEscape(order.iban)}</IBAN>
            </Id>
          </DbtrAcct>
          <RmtInf>
            <Ustrd>${xmlEscape(`Titre ${order.numero}`)}</Ustrd>
          </RmtInf>
        </DrctDbtTxInf>`,
        )
        .join('');

      return `
    <PmtInf>
      <PmtInfId>${messageId}-${sequenceType}-${groupIndex + 1}</PmtInfId>
      <PmtMtd>DD</PmtMtd>
      <BtchBookg>true</BtchBookg>
      <NbOfTxs>${group.length}</NbOfTxs>
      <CtrlSum>${groupTotal.toFixed(2)}</CtrlSum>
      <PmtTpInf>
        <SvcLvl>
          <Cd>SEPA</Cd>
        </SvcLvl>
        <LclInstrm>
          <Cd>CORE</Cd>
        </LclInstrm>
        <SeqTp>${sequenceType}</SeqTp>
      </PmtTpInf>
      <ReqdColltnDt>${xmlEscape(datePrelevement)}</ReqdColltnDt>
      <Cdtr>
        <Nm>${xmlEscape(creditor.name)}</Nm>
      </Cdtr>
      <CdtrAcct>
        <Id>
          <IBAN>${xmlEscape(creditor.iban)}</IBAN>
        </Id>
      </CdtrAcct>
      <CdtrAgt>
        <FinInstnId>
          <BIC>${xmlEscape(creditor.bic)}</BIC>
        </FinInstnId>
      </CdtrAgt>
      <ChrgBr>SLEV</ChrgBr>
      <CdtrSchmeId>
        <Id>
          <PrvtId>
            <Othr>
              <Id>${xmlEscape(creditor.ics)}</Id>
              <SchmeNm>
                <Prtry>SEPA</Prtry>
              </SchmeNm>
            </Othr>
          </PrvtId>
        </Id>
      </CdtrSchmeId>${txs}
    </PmtInf>`;
    })
    .join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.02">
  <CstmrDrctDbtInitn>
    <GrpHdr>
      <MsgId>${messageId}</MsgId>
      <CreDtTm>${createdAt}</CreDtTm>
      <NbOfTxs>${orders.length}</NbOfTxs>
      <CtrlSum>${totalMontant.toFixed(2)}</CtrlSum>
      <InitgPty>
        <Nm>${xmlEscape(creditor.name)}</Nm>
      </InitgPty>
    </GrpHdr>${paymentInfos}
  </CstmrDrctDbtInitn>
</Document>
`;

  return {
    xml,
    totalMontant,
    filename: `pain.008-${String(numeroLot).padStart(6, '0')}.xml`,
    xmlHash: crypto.createHash('sha256').update(xml).digest('hex'),
  };
}

export function listMandatsForAssujetti(assujettiId: number) {
  return db
    .prepare(
      `SELECT id, rum, bic, date_signature, statut, date_revocation, created_at, updated_at,
              '****' || substr(iban, length(iban) - 3, 4) AS iban_masked
       FROM mandats_sepa
       WHERE assujetti_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(assujettiId);
}

function getActiveMandatForAssujetti(assujettiId: number, excludeMandatId?: number) {
  const row = db
    .prepare(
      `SELECT id
       FROM mandats_sepa
       WHERE assujetti_id = ?
         AND statut = 'actif'
         AND (? IS NULL OR id != ?)
       LIMIT 1`,
    )
    .get(assujettiId, excludeMandatId ?? null, excludeMandatId ?? null) as { id: number } | undefined;
  return row ?? null;
}

export function createMandatSepa(params: {
  assujettiId: number;
  userId: number;
  ip?: string | null;
  input: z.infer<typeof mandatCreateSchema>;
}) {
  const assujetti = db.prepare('SELECT id FROM assujettis WHERE id = ?').get(params.assujettiId) as { id: number } | undefined;
  if (!assujetti) {
    throw new SepaRouteError('Assujetti introuvable', 404);
  }

  const rum = normalizeRum(params.input.rum);
  const iban = normalizeIban(params.input.iban);
  const bic = normalizeBic(params.input.bic);
  const dateSignature = normalizeIsoDate(params.input.date_signature);

  if (!isValidIBAN(iban)) {
    throw new SepaRouteError('IBAN invalide (controle MOD-97)', 400);
  }
  if (!isValidBIC(bic)) {
    throw new SepaRouteError('BIC invalide', 400);
  }
  if (getActiveMandatForAssujetti(params.assujettiId)) {
    throw new SepaRouteError('Un mandat actif existe déjà pour cet assujetti', 409);
  }

  try {
    const info = db
      .prepare(
        `INSERT INTO mandats_sepa (assujetti_id, rum, iban, bic, date_signature, statut)
         VALUES (?, ?, ?, ?, ?, 'actif')`,
      )
      .run(params.assujettiId, rum, iban, bic, dateSignature);

    const mandatId = Number(info.lastInsertRowid);
    logAudit({
      userId: params.userId,
      action: 'create-mandat-sepa',
      entite: 'mandat_sepa',
      entiteId: mandatId,
      details: {
        assujetti_id: params.assujettiId,
        rum,
        iban_masked: maskIban(iban),
        bic,
        date_signature: dateSignature,
      },
      ip: params.ip ?? null,
    });

    return {
      id: mandatId,
      assujetti_id: params.assujettiId,
      rum,
      iban_masked: maskIban(iban),
      bic,
      date_signature: dateSignature,
      statut: 'actif' as const,
      mandats_sepa: listMandatsForAssujetti(params.assujettiId),
    };
  } catch (error) {
    const err = error as { message?: string };
    if ((err.message ?? '').includes('UNIQUE')) {
      throw new SepaRouteError('RUM déjà existante', 409);
    }
    throw error;
  }
}

export function revokeMandatSepa(params: {
  assujettiId: number;
  mandatId: number;
  userId: number;
  ip?: string | null;
  dateRevocation?: string;
}) {
  const mandat = db
    .prepare(
      `SELECT id, assujetti_id, rum, statut, date_revocation
       FROM mandats_sepa
       WHERE id = ?`,
    )
    .get(params.mandatId) as
    | { id: number; assujetti_id: number; rum: string; statut: 'actif' | 'revoque'; date_revocation: string | null }
    | undefined;

  if (!mandat || mandat.assujetti_id !== params.assujettiId) {
    throw new SepaRouteError('Mandat SEPA introuvable', 404);
  }
  if (mandat.statut === 'revoque') {
    throw new SepaRouteError('Mandat déjà révoqué', 409);
  }

  const dateRevocation = normalizeIsoDate(params.dateRevocation ?? new Date().toISOString().slice(0, 10));
  db.prepare(
    `UPDATE mandats_sepa
     SET statut = 'revoque',
         date_revocation = ?,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(dateRevocation, mandat.id);

  logAudit({
    userId: params.userId,
    action: 'revoke-mandat-sepa',
    entite: 'mandat_sepa',
    entiteId: mandat.id,
    details: {
      assujetti_id: params.assujettiId,
      rum: mandat.rum,
      date_revocation: dateRevocation,
    },
    ip: params.ip ?? null,
  });

  return {
    id: mandat.id,
    assujetti_id: params.assujettiId,
    rum: mandat.rum,
    statut: 'revoque' as const,
    date_revocation: dateRevocation,
    mandats_sepa: listMandatsForAssujetti(params.assujettiId),
  };
}

sepaRouter.post('/assujettis/:id/mandats-sepa', requireRole('admin', 'gestionnaire', 'financier'), (req, res) => {
  const parsed = mandatCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const payload = createMandatSepa({
      assujettiId: Number(req.params.id),
      userId: req.user!.id,
      ip: req.ip ?? null,
      input: parsed.data,
    });
    return res.status(201).json(payload);
  } catch (error) {
    if (error instanceof SepaRouteError) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
});

sepaRouter.post('/assujettis/:id/mandats-sepa/:mandatId/revoke', requireRole('admin', 'gestionnaire', 'financier'), (req, res) => {
  const parsed = revokeMandatSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const payload = revokeMandatSepa({
      assujettiId: Number(req.params.id),
      mandatId: Number(req.params.mandatId),
      userId: req.user!.id,
      ip: req.ip ?? null,
      dateRevocation: parsed.data.date_revocation,
    });
    return res.json(payload);
  } catch (error) {
    if (error instanceof SepaRouteError) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
});
sepaRouter.post('/export-batch', requireRole('admin', 'financier'), (req, res) => {
  const parsed = exportBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const dateReference = normalizeIsoDate(parsed.data.date_reference);
    const datePrelevement = normalizeIsoDate(parsed.data.date_prelevement);
    if (dateReference > datePrelevement) {
      return res.status(400).json({ error: 'date_prelevement doit être postérieure ou égale à date_reference' });
    }

    const orders = buildSepaOrders(dateReference);
    if (orders.length === 0) {
      return res.status(404).json({ error: 'Aucun ordre SEPA à exporter' });
    }

    const numeroLot = nextSepaNumeroLot();
    const built = buildSepaXml(orders, numeroLot, datePrelevement);
    const validation = validateSepaXml(built.xml);
    if (!validation.ok) {
      console.error('[TLPE] Validation XSD SEPA en échec', validation.report);
      return res.status(500).json({ error: 'Erreur interne export SEPA' });
    }

    const persistExport = db.transaction(() => {
      const exportInfo = db
        .prepare(
          `INSERT INTO sepa_exports (
             numero_lot, date_reference, date_prelevement, exported_by, filename,
             xml_hash, xsd_validation_ok, xsd_validation_report, ordres_count, total_montant
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          numeroLot,
          dateReference,
          datePrelevement,
          req.user!.id,
          built.filename,
          built.xmlHash,
          1,
          validation.report,
          orders.length,
          built.totalMontant,
        );

      const exportId = Number(exportInfo.lastInsertRowid);
      const insertOrder = db.prepare(
        `INSERT INTO sepa_prelevements (mandat_id, titre_id, montant, sequence_type, date_prelevement, statut)
         VALUES (?, ?, ?, ?, ?, 'exporte')`,
      );
      const linkOrder = db.prepare(
        `INSERT INTO sepa_export_items (export_id, prelevement_id)
         VALUES (?, ?)`,
      );

      for (const order of orders) {
        const orderInfo = insertOrder.run(
          order.mandat_id,
          order.titre_id,
          order.montant_restant,
          order.sequence_type,
          datePrelevement,
        );
        linkOrder.run(exportId, Number(orderInfo.lastInsertRowid));
      }

      logAudit({
        userId: req.user!.id,
        action: 'export-sepa',
        entite: 'sepa_export',
        entiteId: exportId,
        details: {
          numero_lot: numeroLot,
          date_reference: dateReference,
          date_prelevement: datePrelevement,
          ordres_count: orders.length,
          total_montant: built.totalMontant,
          xml_hash: built.xmlHash,
          xsd_validation_ok: true,
        },
        ip: req.ip ?? null,
      });

      return exportId;
    });

    persistExport();

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${built.filename}"`);
    res.send(built.xml);
  } catch (error) {
    if (error instanceof SepaRouteError) {
      return res.status(error.status).json({ error: error.status >= 500 ? 'Erreur interne export SEPA' : error.message });
    }

    console.error('[TLPE] Erreur export SEPA inattendue', error);
    return res.status(500).json({ error: 'Erreur interne export SEPA' });
  }
});

export type { MandatRow, SepaOrder };
