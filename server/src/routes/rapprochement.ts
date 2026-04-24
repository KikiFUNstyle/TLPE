import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../auth';
import { importReleveBancaire, listLignesNonRapprochees, listRelevesBancaires } from '../rapprochement';
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

rapprochementRouter.get('/', (_req, res) => {
  res.json({
    releves: listRelevesBancaires(),
    lignes_non_rapprochees: listLignesNonRapprochees(),
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
