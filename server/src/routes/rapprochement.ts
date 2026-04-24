import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../auth';
import {
  applyManualRapprochement,
  importReleveBancaire,
  listLignesNonRapprochees,
  listRapprochementLogs,
  listRelevesBancaires,
  RapprochementWorkflowError,
  runAutoRapprochement,
} from '../rapprochement';
import { StatementImportValidationError } from '../rapprochementImport';

export const rapprochementRouter = Router();

rapprochementRouter.use(authMiddleware);
rapprochementRouter.use(requireRole('admin', 'financier'));

const csvConfigSchema = z
  .object({
    delimiter: z.string().min(1).max(1).optional(),
    dateColumn: z.string().min(1).optional(),
    labelColumn: z.string().min(1).optional(),
    amountColumn: z.string().min(1).optional(),
    referenceColumn: z.string().min(1).optional(),
    transactionIdColumn: z.string().min(1).optional(),
    debitColumn: z.string().min(1).optional(),
    creditColumn: z.string().min(1).optional(),
    dateFormat: z.enum(['auto', 'yyyy-mm-dd', 'dd/mm/yyyy', 'yyyymmdd']).optional(),
  })
  .optional();

const importSchema = z.object({
  fileName: z.string().min(1),
  contentBase64: z.string().min(1),
  format: z.enum(['csv', 'ofx', 'mt940']).optional(),
  csvConfig: csvConfigSchema,
});

const manualSchema = z.object({
  ligne_id: z.number().int().positive(),
  numero_titre: z.string().min(1),
  commentaire: z.string().trim().max(500).optional().nullable(),
});

rapprochementRouter.get('/', (_req, res) => {
  res.json({
    releves: listRelevesBancaires(),
    lignes_non_rapprochees: listLignesNonRapprochees(),
    journal_rapprochements: listRapprochementLogs(),
  });
});

rapprochementRouter.post('/import', (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const result = importReleveBancaire({
      fileName: parsed.data.fileName,
      contentBase64: parsed.data.contentBase64,
      format: parsed.data.format,
      csvConfig: parsed.data.csvConfig,
      userId: req.user!.id,
      ip: req.ip ?? null,
    });
    return res.status(201).json(result);
  } catch (error) {
    if (error instanceof StatementImportValidationError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('[TLPE] Erreur import rapprochement inattendue', error);
    return res.status(500).json({ error: 'Erreur interne import rapprochement' });
  }
});

rapprochementRouter.post('/auto', (req, res) => {
  try {
    const result = runAutoRapprochement(req.user!.id, req.ip ?? null);
    return res.json(result);
  } catch (error) {
    console.error('[TLPE] Erreur rapprochement automatique inattendue', error);
    return res.status(500).json({ error: 'Erreur interne rapprochement automatique' });
  }
});

rapprochementRouter.post('/manual', (req, res) => {
  const parsed = manualSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const result = applyManualRapprochement({
      ligneId: parsed.data.ligne_id,
      numeroTitre: parsed.data.numero_titre,
      commentaire: parsed.data.commentaire,
      userId: req.user!.id,
      ip: req.ip ?? null,
    });
    return res.status(201).json(result);
  } catch (error) {
    if (error instanceof RapprochementWorkflowError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('[TLPE] Erreur rapprochement manuel inattendue', error);
    return res.status(500).json({ error: 'Erreur interne rapprochement manuel' });
  }
});
