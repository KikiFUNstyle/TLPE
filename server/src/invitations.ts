import * as crypto from 'node:crypto';
import { db, logAudit } from './db';
import { renderEmailTemplate } from './emailTemplates';
import { isMockEmailDeliveryMode, persistEmailNotification, queueEmailNotification } from './services/mail';

export type InvitationMode = 'auto' | 'manual';

interface SendInvitationArgs {
  campagneId: number;
  userId?: number;
  assujettiId?: number;
  mode?: InvitationMode;
  ip?: string | null;
}

interface SendInvitationResult {
  sent: number;
  failed: number;
  skipped: number;
  pending: number;
  nonEligible: number;
  prepared: number;
}

interface CampagneInfo {
  id: number;
  annee: number;
  date_limite_declaration: string;
}

type DeliveryStatus = 'envoye' | 'pending' | 'echec';

interface DeliveryResult {
  status: DeliveryStatus;
  erreur: string | null;
  sentAt: string | null;
  providerMessageId: string | null;
  attempts: number;
}

const PORTAL_BASE_URL = (process.env.TLPE_PORTAL_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function redactMagicLink(link: string): string {
  return link.replace(/(invitation_token=)[^&]+/, '$1[redacted]');
}

function deliverInvitationEmail(): DeliveryResult {
  const mode = process.env.TLPE_EMAIL_DELIVERY_MODE ?? 'disabled';

  if (mode === 'mock-success') {
    return {
      status: 'envoye',
      erreur: null,
      sentAt: new Date().toISOString(),
      providerMessageId: `mock-success-${Date.now()}`,
      attempts: 1,
    };
  }

  if (mode === 'mock-failure') {
    return {
      status: 'echec',
      erreur: "Echec d'envoi (mode mock-failure)",
      sentAt: null,
      providerMessageId: null,
      attempts: 1,
    };
  }

  return {
    status: 'pending',
    erreur: 'Envoi differe: service SMTP non configure',
    sentAt: null,
    providerMessageId: null,
    attempts: 0,
  };
}

function persistInvitationDelivery(input: {
  campagneId: number;
  assujettiId: number;
  emailDestinataire: string;
  objet: string;
  corps: string;
  magicLink: string | null;
  mode: InvitationMode;
  createdBy: number | null;
  delivery: DeliveryResult;
  metadata: Record<string, unknown>;
}) {
  if (isMockEmailDeliveryMode()) {
    persistEmailNotification({
      campagneId: input.campagneId,
      assujettiId: input.assujettiId,
      emailDestinataire: input.emailDestinataire,
      objet: input.objet,
      corps: input.corps,
      templateCode: 'invitation_campagne',
      magicLink: input.magicLink,
      mode: input.mode,
      createdBy: input.createdBy,
      status: input.delivery.status,
      error: input.delivery.erreur,
      sentAt: input.delivery.sentAt,
      providerMessageId: input.delivery.providerMessageId,
      attempts: input.delivery.attempts,
      metadata: input.metadata,
    });
    return;
  }

  queueEmailNotification({
    campagneId: input.campagneId,
    assujettiId: input.assujettiId,
    emailDestinataire: input.emailDestinataire,
    objet: input.objet,
    corps: input.corps,
    templateCode: 'invitation_campagne',
    magicLink: input.magicLink,
    mode: input.mode,
    createdBy: input.createdBy,
    metadata: {
      ...input.metadata,
      initial_delivery_status: input.delivery.status,
      initial_delivery_error: input.delivery.erreur,
    },
  });
}

interface AssujettiCible {
  id: number;
  identifiant_tlpe: string;
  raison_sociale: string;
  email: string | null;
}

function getCampagne(campagneId: number): CampagneInfo {
  const campagne = db
    .prepare('SELECT id, annee, date_limite_declaration FROM campagnes WHERE id = ?')
    .get(campagneId) as CampagneInfo | undefined;

  if (!campagne) throw new Error('Campagne introuvable');
  return campagne;
}

function listAssujettisEligibles(_campagneId: number, assujettiId?: number): AssujettiCible[] {
  const assujettiClause = assujettiId ? ' AND a.id = ?' : '';

  return db
    .prepare(
      `SELECT a.id, a.identifiant_tlpe, a.raison_sociale, a.email
       FROM assujettis a
       WHERE a.statut = 'actif'
         AND a.email IS NOT NULL
         AND trim(a.email) != ''
         ${assujettiClause}
       ORDER BY a.id`,
    )
    .all(...(assujettiId ? [assujettiId] : [])) as AssujettiCible[];
}

function hasContribuableAccount(assujettiId: number): boolean {
  const row = db
    .prepare(
      `SELECT id
       FROM users
       WHERE role = 'contribuable' AND assujetti_id = ? AND actif = 1
       LIMIT 1`,
    )
    .get(assujettiId) as { id: number } | undefined;
  return !!row;
}

function createMagicLink(campagneId: number, assujettiId: number, userId?: number): { link: string; tokenHash: string } {
  const token = crypto.randomBytes(24).toString('hex');
  const tokenHash = hashToken(token);
  db.prepare(
    `INSERT INTO invitation_magic_links (campagne_id, assujetti_id, token, expires_at, created_by)
     VALUES (?, ?, ?, datetime('now', '+30 days'), ?)`,
  ).run(campagneId, assujettiId, tokenHash, userId ?? null);

  return { link: `${PORTAL_BASE_URL}/login?invitation_token=${token}`, tokenHash };
}

function buildInvitationEmail(input: {
  campagne: CampagneInfo;
  assujetti: AssujettiCible;
  magicLink: string | null;
}) {
  const { campagne, assujetti, magicLink } = input;
  const portalLink = `${PORTAL_BASE_URL}/login`;
  const rendered = renderEmailTemplate({
    templateCode: 'invitation_campagne',
    context: {
      campagne_annee: campagne.annee,
      annee: campagne.annee,
      date_limite_declaration: campagne.date_limite_declaration,
      identifiant: assujetti.identifiant_tlpe,
      identifiant_tlpe: assujetti.identifiant_tlpe,
      raison_sociale: assujetti.raison_sociale,
      lien: magicLink ?? portalLink,
      portail_url: portalLink,
      service: 'Service TLPE',
      service_label: 'Service: Service TLPE',
    },
  });

  return { objet: rendered.subject, corps: rendered.text };
}

export function sendInvitationsForCampagne(args: SendInvitationArgs): SendInvitationResult {
  const mode = args.mode ?? 'auto';
  const campagne = getCampagne(args.campagneId);
  const assujettis = listAssujettisEligibles(args.campagneId, args.assujettiId);

  let sent = 0;
  let failed = 0;
  let pending = 0;
  let nonEligible = 0;

  for (const assujetti of assujettis) {
    try {
      const hasPortal = hasContribuableAccount(assujetti.id);
      const magic = hasPortal ? null : createMagicLink(args.campagneId, assujetti.id, args.userId);
      const magicLink = magic?.link ?? null;
      const delivery = deliverInvitationEmail();
      const content = buildInvitationEmail({ campagne, assujetti, magicLink });
      const storedCorps = magicLink ? content.corps.replace(magicLink, redactMagicLink(magicLink)) : content.corps;

      persistInvitationDelivery({
        campagneId: args.campagneId,
        assujettiId: assujetti.id,
        emailDestinataire: assujetti.email ?? '',
        objet: content.objet,
        corps: storedCorps,
        magicLink: magicLink ? redactMagicLink(magicLink) : null,
        mode,
        createdBy: args.userId ?? null,
        delivery,
        metadata: {
          magic_link_token_hash: magic?.tokenHash ?? null,
        },
      });

      logAudit({
        userId: args.userId ?? null,
        action: mode === 'manual' ? 'resend-invitation' : 'send-invitation',
        entite: 'campagne',
        entiteId: args.campagneId,
        details: {
          assujetti_id: assujetti.id,
          email: assujetti.email,
          mode,
          annee: campagne.annee,
          statut: delivery.status,
          erreur: delivery.erreur,
          magic_link_token_hash: magic?.tokenHash ?? null,
        },
        ip: args.ip ?? null,
      });

      if (delivery.status === 'envoye') {
        sent += 1;
      } else if (delivery.status === 'pending') {
        pending += 1;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }

  if (assujettis.length === 0 && args.assujettiId) {
    nonEligible = 1;
  }

  const skipped = nonEligible;
  const prepared = assujettis.length;

  return { sent, failed, skipped, pending, nonEligible, prepared };
}
