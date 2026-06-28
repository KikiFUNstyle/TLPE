import { Router, type Response } from 'express';
import { z } from 'zod';

import { authMiddleware, requireRole } from '../auth';
import { logAudit } from '../db';
import {
  getEmailTemplateDefinition,
  listEmailTemplateDefinitions,
  previewEmailTemplate,
  resetEmailTemplateOverride,
  upsertEmailTemplateOverride,
} from '../emailTemplates';

export const emailTemplatesRouter = Router();

emailTemplatesRouter.use(authMiddleware);
emailTemplatesRouter.use(requireRole('admin'));

const emailTemplateBodySchema = z.object({
  subject_template: z.string().min(1),
  html_template: z.string().min(1),
  text_template: z.string().min(1),
  description: z.string().trim().min(1).max(500).optional().nullable(),
});

const previewBodySchema = z.object({
  context: z.record(z.string(), z.unknown()).optional(),
}).optional();

function handleEmailTemplateError(res: Response, error: unknown) {
  if (error instanceof Error) {
    if (error.message.startsWith('Template email inconnu:')) {
      return res.status(404).json({ error: error.message });
    }
    return res.status(400).json({ error: error.message });
  }
  return res.status(500).json({ error: 'Erreur interne' });
}

emailTemplatesRouter.get('/', (_req, res) => {
  return res.json({ templates: listEmailTemplateDefinitions() });
});

emailTemplatesRouter.get('/:code', (req, res) => {
  try {
    return res.json({ template: getEmailTemplateDefinition(req.params.code) });
  } catch (error) {
    return handleEmailTemplateError(res, error);
  }
});

emailTemplatesRouter.post('/:code/preview', (req, res) => {
  const parsed = previewBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const preview = previewEmailTemplate({
      templateCode: req.params.code,
      context: parsed.data?.context,
    });
    return res.json({ preview });
  } catch (error) {
    return handleEmailTemplateError(res, error);
  }
});

emailTemplatesRouter.put('/:code', (req, res) => {
  const parsed = emailTemplateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const template = upsertEmailTemplateOverride({
      templateCode: req.params.code,
      subjectTemplate: parsed.data.subject_template,
      htmlTemplate: parsed.data.html_template,
      textTemplate: parsed.data.text_template,
      description: parsed.data.description ?? null,
      updatedBy: req.user!.id,
    });

    logAudit({
      userId: req.user!.id,
      action: 'upsert-email-template',
      entite: 'email_template',
      details: {
        code: req.params.code,
        description: parsed.data.description ?? null,
      },
      ip: req.ip ?? null,
    });

    return res.json({ template });
  } catch (error) {
    return handleEmailTemplateError(res, error);
  }
});

emailTemplatesRouter.delete('/:code', (req, res) => {
  try {
    const template = resetEmailTemplateOverride(req.params.code);

    logAudit({
      userId: req.user!.id,
      action: 'reset-email-template',
      entite: 'email_template',
      details: { code: req.params.code },
      ip: req.ip ?? null,
    });

    return res.json({ template });
  } catch (error) {
    return handleEmailTemplateError(res, error);
  }
});
