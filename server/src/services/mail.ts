import nodemailer = require('nodemailer');
import SMTPTransport = require('nodemailer/lib/smtp-transport');

import { db, logAudit } from '../db';

export interface MailAttachmentInput {
  filename: string;
  contentType?: string | null;
  content: Buffer;
}

export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: MailAttachmentInput[];
}

export interface MailSendResult {
  messageId: string | null;
}

export interface MailService {
  mode: 'smtp' | 'stub' | 'log-only' | 'mailhog';
  sendMail(input: SendMailInput): Promise<MailSendResult>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
}

export interface QueuedEmailNotificationInput {
  assujettiId: number;
  campagneId: number | null;
  emailDestinataire: string;
  objet: string;
  corps: string;
  attachments?: MailAttachmentInput[];
  templateCode: string;
  relanceNiveau?: 'J-30' | 'J-15' | 'J-7' | 'depasse' | null;
  pieceJointePath?: string | null;
  magicLink?: string | null;
  mode?: 'auto' | 'manual';
  createdBy?: number | null;
  metadata?: Record<string, unknown>;
}

export interface PersistEmailNotificationResult {
  notificationId: number;
  status: 'pending' | 'envoye' | 'echec';
  error: string | null;
  sentAt: string | null;
  providerMessageId: string | null;
  attempts: number;
}

export interface RunPendingEmailNotificationsWorkerInput {
  mailService?: MailService;
  nowIso?: string;
  maxAttempts?: number;
  backoffMs?: number;
}

export interface RunPendingEmailNotificationsWorkerResult {
  processed: number;
  sent: number;
  failed: number;
}

export function resolveEmailDeliveryMode(): string {
  return (process.env.TLPE_EMAIL_DELIVERY_MODE ?? 'disabled').trim().toLowerCase();
}

export function isMockEmailDeliveryMode(mode = resolveEmailDeliveryMode()): boolean {
  return mode === 'mock-success' || mode === 'mock-failure';
}

export function resolveEmailWorkerEnabled(): boolean {
  if (isMockEmailDeliveryMode()) return false;
  const devMode = process.env.TLPE_SMTP_DEV_MODE?.trim().toLowerCase();
  if (devMode === 'mailhog' || devMode === 'log-only') return true;
  return createSmtpConfigFromEnv() !== null;
}

export function resolveEmailWorkerIntervalMs(): number {
  const value = Number(process.env.TLPE_SMTP_WORKER_INTERVAL_MS ?? '30000');
  if (!Number.isFinite(value) || value < 1000) {
    return 30000;
  }
  return Math.floor(value);
}

type NotificationRow = {
  id: number;
  campagne_id: number | null;
  assujetti_id: number;
  email_destinataire: string;
  objet: string;
  corps: string;
  template_code: string;
  relance_niveau: 'J-30' | 'J-15' | 'J-7' | 'depasse' | null;
  pieces_jointes_json: string | null;
  mode: 'auto' | 'manual';
  tentatives: number;
  created_by: number | null;
};

function normalizeIso(value?: string): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Horodatage invalide: ${value}`);
  }
  return parsed.toISOString();
}

function computeNextAttemptIso(nowIso: string, backoffMs: number, attemptNumber: number) {
  return new Date(new Date(nowIso).getTime() + backoffMs * attemptNumber).toISOString();
}

function parseBooleanFlag(value: string | undefined, defaultValue: boolean) {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'oui', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'non', 'off'].includes(normalized)) return false;
  return defaultValue;
}

export function createSmtpConfigFromEnv(): SmtpConfig | null {
  const host = process.env.TLPE_SMTP_HOST?.trim();
  const portRaw = process.env.TLPE_SMTP_PORT?.trim();
  const user = process.env.TLPE_SMTP_USER?.trim();
  const password = process.env.TLPE_SMTP_PASSWORD?.trim();
  const from = process.env.TLPE_SMTP_FROM?.trim();

  if (!host || !portRaw || !user || !password || !from) {
    return null;
  }

  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }

  const secure = parseBooleanFlag(process.env.TLPE_SMTP_SECURE, port === 465);
  return { host, port, secure, user, password, from };
}

function serializeAttachments(attachments: MailAttachmentInput[] | undefined) {
  return JSON.stringify(
    (attachments ?? []).map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType ?? null,
      contentBase64: attachment.content.toString('base64'),
      size: attachment.content.length,
    })),
  );
}

function deserializeAttachments(value: string | null): MailAttachmentInput[] {
  if (!value) return [];

  const parsed = JSON.parse(value) as Array<{
    filename: string;
    contentType?: string | null;
    contentBase64: string;
  }>;

  return parsed.map((attachment) => ({
    filename: attachment.filename,
    contentType: attachment.contentType ?? null,
    content: Buffer.from(attachment.contentBase64, 'base64'),
  }));
}

function isInvalidRecipientError(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? (error as { code?: string }).code : undefined;
  if (code === 'EMAIL_INVALID') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /invalid|invalide|recipient/i.test(message);
}

function createTransport(config: SmtpConfig) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user && config.password
      ? {
          user: config.user,
          pass: config.password,
        }
      : undefined,
  });
}

function createMailhogConfigFromEnv(): SmtpConfig {
  const rawUrl = process.env.TLPE_SMTP_MAILHOG_URL?.trim() || 'smtp://127.0.0.1:1025';
  const parsed = new URL(rawUrl.includes('://') ? rawUrl : `smtp://${rawUrl}`);
  const secure = parsed.protocol === 'smtps:';
  const port = parsed.port ? Number(parsed.port) : secure ? 465 : 1025;

  if (!parsed.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Configuration MailHog invalide: ${rawUrl}`);
  }

  return {
    host: parsed.hostname,
    port,
    secure,
    user: parsed.username || undefined,
    password: parsed.password || undefined,
    from: process.env.TLPE_SMTP_FROM?.trim() || 'noreply@tlpe.local',
  };
}

export function createMailService(input?: {
  mode?: 'smtp' | 'stub' | 'log-only' | 'mailhog';
  sendImpl?: (input: SendMailInput) => Promise<{ messageId?: string | null }>;
}): MailService {
  const explicitMode = input?.mode;
  const devMode = process.env.TLPE_SMTP_DEV_MODE?.trim().toLowerCase();
  const smtpConfig = createSmtpConfigFromEnv();
  const mode: MailService['mode'] = explicitMode
    ?? (devMode === 'mailhog'
      ? 'mailhog'
      : devMode === 'log-only'
        ? 'log-only'
        : smtpConfig
          ? 'smtp'
          : 'log-only');

  if (input?.sendImpl) {
    return {
      mode,
      async sendMail(sendInput) {
        const result = await input.sendImpl!(sendInput);
        return { messageId: result.messageId ?? null };
      },
    };
  }

  if (mode === 'stub' || mode === 'log-only') {
    return {
      mode,
      async sendMail(sendInput) {
        // eslint-disable-next-line no-console
        console.info('[TLPE][mail]', { mode, to: sendInput.to, subject: sendInput.subject, attachments: sendInput.attachments?.length ?? 0 });
        return { messageId: `${mode}-${Date.now()}` };
      },
    };
  }

  if (mode === 'mailhog') {
    const transport = createTransport(createMailhogConfigFromEnv());
    return {
      mode,
      async sendMail(sendInput) {
        const info = await transport.sendMail({
          from: process.env.TLPE_SMTP_FROM?.trim() || 'noreply@tlpe.local',
          to: sendInput.to,
          subject: sendInput.subject,
          html: sendInput.html,
          text: sendInput.text,
          attachments: (sendInput.attachments ?? []).map((attachment) => ({
            filename: attachment.filename,
            contentType: attachment.contentType ?? undefined,
            content: attachment.content,
          })),
        });
        return { messageId: info.messageId ?? null };
      },
    };
  }

  if (!smtpConfig) {
    throw new Error('Configuration SMTP incomplète');
  }

  const transporter = createTransport(smtpConfig);
  return {
    mode: 'smtp',
    async sendMail(sendInput) {
      const info = await transporter.sendMail({
        from: smtpConfig.from,
        to: sendInput.to,
        subject: sendInput.subject,
        html: sendInput.html,
        text: sendInput.text,
        attachments: (sendInput.attachments ?? []).map((attachment) => ({
          filename: attachment.filename,
          contentType: attachment.contentType ?? undefined,
          content: attachment.content,
        })),
      });

      return { messageId: info.messageId ?? null };
    },
  };
}

export function queueEmailNotification(input: QueuedEmailNotificationInput): number {
  const result = db.prepare(
    `INSERT INTO notifications_email (
      campagne_id, assujetti_id, email_destinataire, objet, corps,
      template_code, relance_niveau, piece_jointe_path, pieces_jointes_json, magic_link,
      mode, statut, tentatives, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
  ).run(
    input.campagneId,
    input.assujettiId,
    input.emailDestinataire,
    input.objet,
    input.corps,
    input.templateCode,
    input.relanceNiveau ?? null,
    input.pieceJointePath ?? null,
    serializeAttachments(input.attachments),
    input.magicLink ?? null,
    input.mode ?? 'auto',
    input.createdBy ?? null,
  );

  const notificationId = Number(result.lastInsertRowid);
  logAudit({
    userId: input.createdBy ?? null,
    action: 'queue-email-notification',
    entite: 'notification_email',
    entiteId: notificationId,
    details: {
      assujetti_id: input.assujettiId,
      campagne_id: input.campagneId,
      template_code: input.templateCode,
      relance_niveau: input.relanceNiveau ?? null,
      piece_jointe_path: input.pieceJointePath ?? null,
      magic_link: input.magicLink ?? null,
      attachments: input.attachments?.map((attachment) => attachment.filename) ?? [],
      metadata: input.metadata ?? null,
    },
  });

  return notificationId;
}

export function persistEmailNotification(input: QueuedEmailNotificationInput & {
  status: PersistEmailNotificationResult['status'];
  error?: string | null;
  sentAt?: string | null;
  providerMessageId?: string | null;
  attempts?: number;
}): PersistEmailNotificationResult {
  const result = db.prepare(
    `INSERT INTO notifications_email (
      campagne_id, assujetti_id, email_destinataire, objet, corps,
      template_code, relance_niveau, piece_jointe_path, pieces_jointes_json, magic_link,
      mode, statut, tentatives, erreur, sent_at, provider_message_id, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.campagneId,
    input.assujettiId,
    input.emailDestinataire,
    input.objet,
    input.corps,
    input.templateCode,
    input.relanceNiveau ?? null,
    input.pieceJointePath ?? null,
    serializeAttachments(input.attachments),
    input.magicLink ?? null,
    input.mode ?? 'auto',
    input.status,
    input.attempts ?? (input.status === 'envoye' || input.status === 'echec' ? 1 : 0),
    input.error ?? null,
    input.sentAt ?? null,
    input.providerMessageId ?? null,
    input.createdBy ?? null,
  );

  const notificationId = Number(result.lastInsertRowid);
  logAudit({
    userId: input.createdBy ?? null,
    action: 'persist-email-notification',
    entite: 'notification_email',
    entiteId: notificationId,
    details: {
      assujetti_id: input.assujettiId,
      campagne_id: input.campagneId,
      template_code: input.templateCode,
      relance_niveau: input.relanceNiveau ?? null,
      statut: input.status,
      erreur: input.error ?? null,
      provider_message_id: input.providerMessageId ?? null,
      piece_jointe_path: input.pieceJointePath ?? null,
      magic_link: input.magicLink ?? null,
      attachments: input.attachments?.map((attachment) => attachment.filename) ?? [],
      metadata: input.metadata ?? null,
    },
  });

  return {
    notificationId,
    status: input.status,
    error: input.error ?? null,
    sentAt: input.sentAt ?? null,
    providerMessageId: input.providerMessageId ?? null,
    attempts: input.attempts ?? (input.status === 'envoye' || input.status === 'echec' ? 1 : 0),
  };
}

export function markAssujettiEmailInvalide(assujettiId: number) {
  db.prepare(
    `UPDATE assujettis
     SET statut = 'email_invalide',
         email_invalide = 1,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(assujettiId);
}

function listDueNotifications(nowIso: string) {
  return db.prepare(
    `SELECT id, campagne_id, assujetti_id, email_destinataire, objet, corps,
            template_code, relance_niveau, pieces_jointes_json, mode,
            tentatives, created_by
     FROM notifications_email
     WHERE statut = 'pending'
       AND (prochain_essai_at IS NULL OR prochain_essai_at <= ?)
     ORDER BY id ASC`,
  ).all(nowIso) as NotificationRow[];
}

export async function runPendingEmailNotificationsWorker(
  input: RunPendingEmailNotificationsWorkerInput = {},
): Promise<RunPendingEmailNotificationsWorkerResult> {
  const nowIso = normalizeIso(input.nowIso);
  const maxAttempts = input.maxAttempts ?? Number(process.env.TLPE_SMTP_MAX_ATTEMPTS ?? '3');
  const backoffMs = input.backoffMs ?? Number(process.env.TLPE_SMTP_BACKOFF_MS ?? '60000');
  const mailService = input.mailService ?? createMailService();

  const notifications = listDueNotifications(nowIso);
  let sent = 0;
  let failed = 0;

  for (const notification of notifications) {
    const nextAttemptNumber = notification.tentatives + 1;
    try {
      const result = await mailService.sendMail({
        to: notification.email_destinataire,
        subject: notification.objet,
        html: notification.corps,
        attachments: deserializeAttachments(notification.pieces_jointes_json),
      });

      db.prepare(
        `UPDATE notifications_email
         SET statut = 'envoye',
             tentatives = ?,
             sent_at = ?,
             erreur = NULL,
             prochain_essai_at = NULL,
             provider_message_id = ?
         WHERE id = ?`,
      ).run(nextAttemptNumber, nowIso, result.messageId, notification.id);

      logAudit({
        userId: notification.created_by,
        action: 'send-email-notification',
        entite: 'notification_email',
        entiteId: notification.id,
        details: {
          statut: 'envoye',
          attempt: nextAttemptNumber,
          provider_message_id: result.messageId,
          template_code: notification.template_code,
        },
      });
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const invalidRecipient = isInvalidRecipientError(error);

      if (invalidRecipient) {
        markAssujettiEmailInvalide(notification.assujetti_id);
        db.prepare(
          `UPDATE notifications_email
           SET statut = 'echec',
               tentatives = ?,
               erreur = ?,
               prochain_essai_at = NULL
           WHERE id = ?`,
        ).run(nextAttemptNumber, message, notification.id);
      } else if (nextAttemptNumber >= maxAttempts) {
        db.prepare(
          `UPDATE notifications_email
           SET statut = 'echec',
               tentatives = ?,
               erreur = ?,
               prochain_essai_at = NULL
           WHERE id = ?`,
        ).run(nextAttemptNumber, message, notification.id);
      } else {
        db.prepare(
          `UPDATE notifications_email
           SET tentatives = ?,
               erreur = ?,
               prochain_essai_at = ?
           WHERE id = ?`,
        ).run(nextAttemptNumber, message, computeNextAttemptIso(nowIso, backoffMs, nextAttemptNumber), notification.id);
      }

      logAudit({
        userId: notification.created_by,
        action: 'send-email-notification',
        entite: 'notification_email',
        entiteId: notification.id,
        details: {
          statut: invalidRecipient || nextAttemptNumber >= maxAttempts ? 'echec' : 'pending',
          attempt: nextAttemptNumber,
          erreur: message,
          invalid_recipient: invalidRecipient,
          template_code: notification.template_code,
        },
      });
      failed += 1;
    }
  }

  return {
    processed: notifications.length,
    sent,
    failed,
  };
}
