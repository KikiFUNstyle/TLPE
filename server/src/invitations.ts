import * as crypto from 'node:crypto';
import { db, logAudit } from './db';

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
}

interface CampagneInfo {
  id: number;
  annee: number;
  date_limite_declaration: string;
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

function createMagicLink(campagneId: number, assujettiId: number, userId?: number): string {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare(
    `INSERT INTO invitation_magic_links (campagne_id, assujetti_id, token, expires_at, created_by)
     VALUES (?, ?, ?, datetime('now', '+30 days'), ?)`,
  ).run(campagneId, assujettiId, token, userId ?? null);

  return `https://tlpe.local/activation?token=${token}`;
}

function buildInvitationEmail(input: {
  campagne: CampagneInfo;
  assujetti: AssujettiCible;
  magicLink: string | null;
}) {
  const { campagne, assujetti, magicLink } = input;
  const objet = `Campagne TLPE ${campagne.annee} - invitation a declarer`;
  const lignes = [
    `Bonjour ${assujetti.raison_sociale},`,
    '',
    `La campagne TLPE ${campagne.annee} est ouverte.`,
    `Votre identifiant TLPE: ${assujetti.identifiant_tlpe}.`,
    `Date limite de declaration: ${campagne.date_limite_declaration}.`,
    'Lien portail: https://tlpe.local/login',
  ];

  if (magicLink) {
    lignes.push(`Lien d'activation unique: ${magicLink}`);
  }

  lignes.push('', 'Cordialement,', 'Service TLPE');
  return { objet, corps: lignes.join('\n') };
}

export function sendInvitationsForCampagne(args: SendInvitationArgs): SendInvitationResult {
  const mode = args.mode ?? 'auto';
  const campagne = getCampagne(args.campagneId);
  const assujettis = listAssujettisEligibles(args.campagneId, args.assujettiId);

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  const insertNotif = db.prepare(
    `INSERT INTO notifications_email (
      campagne_id, assujetti_id, email_destinataire, objet, corps,
      template_code, magic_link, mode, statut, sent_at, created_by
    ) VALUES (?, ?, ?, ?, ?, 'invitation_campagne', ?, ?, 'envoye', datetime('now'), ?)`,
  );

  for (const assujetti of assujettis) {
    try {
      const hasPortal = hasContribuableAccount(assujetti.id);
      const magicLink = hasPortal ? null : createMagicLink(args.campagneId, assujetti.id, args.userId);
      const content = buildInvitationEmail({ campagne, assujetti, magicLink });

      insertNotif.run(
        args.campagneId,
        assujetti.id,
        assujetti.email,
        content.objet,
        content.corps,
        magicLink,
        mode,
        args.userId ?? null,
      );

      logAudit({
        userId: args.userId ?? null,
        action: mode === 'manual' ? 'resend-invitation' : 'send-invitation',
        entite: 'campagne',
        entiteId: args.campagneId,
        details: { assujetti_id: assujetti.id, email: assujetti.email, mode, annee: campagne.annee },
        ip: args.ip ?? null,
      });

      sent += 1;
    } catch {
      failed += 1;
    }
  }

  if (assujettis.length === 0) {
    skipped = args.assujettiId ? 1 : 0;
  }

  return { sent, failed, skipped };
}
