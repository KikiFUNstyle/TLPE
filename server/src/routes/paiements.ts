import express, { Router } from 'express';
import { z } from 'zod';
import * as crypto from 'node:crypto';
import { db, logAudit } from '../db';
import { requireRole } from '../auth';

type TitreRow = {
  id: number;
  numero: string;
  assujetti_id: number;
  montant: number;
  montant_paye: number;
  statut: string;
  raison_sociale: string;
  identifiant_tlpe: string;
};

type PayfipCallbackStatus = 'success' | 'cancel' | 'failed';
type PayfipPaymentStatus = 'confirme' | 'annule' | 'refuse';

const callbackSchema = z.object({
  numero_titre: z.string().min(1),
  reference: z.string().min(1),
  montant: z.number().positive(),
  statut: z.enum(['success', 'cancel', 'failed']),
  transaction_id: z.string().min(1),
  mac: z.string().min(32),
});

export const paiementsRouter = Router();

function getPayfipConfig() {
  return {
    secret: process.env.TLPE_PAYFIP_SECRET || 'payfip-secret-demo',
    baseUrl: process.env.TLPE_PAYFIP_BASE_URL || 'https://payfip.example.local/payer',
    collectivite: process.env.TLPE_PAYFIP_COLLECTIVITE || '00000',
    returnUrl: process.env.TLPE_PAYFIP_RETURN_URL || 'http://localhost:5173/paiement/confirmation',
    callbackUrl: process.env.TLPE_PAYFIP_CALLBACK_URL || 'http://localhost:4000/api/paiements/callback/payfip',
  };
}

function computePayfipMac(input: {
  numeroTitre: string;
  reference: string;
  montant: number;
  statut: PayfipCallbackStatus;
  transactionId: string;
}) {
  return crypto
    .createHmac('sha256', getPayfipConfig().secret)
    .update(`${input.numeroTitre}|${input.reference}|${input.montant.toFixed(2)}|${input.statut}|${input.transactionId}`)
    .digest('hex');
}

function buildPayfipReference(titre: Pick<TitreRow, 'id' | 'numero'>) {
  const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `TLPE-PAYFIP-${titre.id}-${suffix}`;
}

function loadTitreById(id: number) {
  return db
    .prepare(
      `SELECT t.id, t.numero, t.assujetti_id, t.montant, t.montant_paye, t.statut,
              a.raison_sociale, a.identifiant_tlpe
       FROM titres t
       JOIN assujettis a ON a.id = t.assujetti_id
       WHERE t.id = ?`,
    )
    .get(id) as TitreRow | undefined;
}

function loadTitreByNumero(numero: string) {
  return db
    .prepare(
      `SELECT t.id, t.numero, t.assujetti_id, t.montant, t.montant_paye, t.statut,
              a.raison_sociale, a.identifiant_tlpe
       FROM titres t
       JOIN assujettis a ON a.id = t.assujetti_id
       WHERE t.numero = ?`,
    )
    .get(numero) as TitreRow | undefined;
}

function updateTitrePaiement(titre: Pick<TitreRow, 'id' | 'montant' | 'statut'>, montantPaye: number) {
  let statut = titre.statut;
  if (montantPaye >= titre.montant) statut = 'paye';
  else if (montantPaye > 0) statut = 'paye_partiel';
  db.prepare('UPDATE titres SET montant_paye = ?, statut = ? WHERE id = ?').run(Number(montantPaye.toFixed(2)), statut, titre.id);
  return statut;
}

function mapCallbackToPaymentStatus(statut: PayfipCallbackStatus): PayfipPaymentStatus {
  if (statut === 'success') return 'confirme';
  if (statut === 'cancel') return 'annule';
  return 'refuse';
}

function computePayfipRedirectMac(input: {
  collectivite: string;
  numeroTitre: string;
  montant: number;
  reference: string;
  returnUrl: string;
  callbackUrl: string;
}) {
  return crypto
    .createHmac('sha256', getPayfipConfig().secret)
    .update(
      `${input.collectivite}|${input.numeroTitre}|${input.montant.toFixed(2)}|${input.reference}|${input.returnUrl}|${input.callbackUrl}`,
    )
    .digest('hex');
}

export function buildPayfipRedirectPayload(titre: TitreRow) {
  const config = getPayfipConfig();
  const montantRestant = Number(Math.max(titre.montant - titre.montant_paye, 0).toFixed(2));
  const reference = buildPayfipReference(titre);
  const mac = computePayfipRedirectMac({
    collectivite: config.collectivite,
    numeroTitre: titre.numero,
    montant: montantRestant,
    reference,
    returnUrl: config.returnUrl,
    callbackUrl: config.callbackUrl,
  });
  const search = new URLSearchParams({
    collectivite: config.collectivite,
    numero_titre: titre.numero,
    montant: montantRestant.toFixed(2),
    reference,
    return_url: config.returnUrl,
    callback_url: config.callbackUrl,
    mac,
  });
  return {
    redirect_url: `${config.baseUrl}?${search.toString()}`,
    reference,
    return_url: config.returnUrl,
    callback_url: config.callbackUrl,
    montant: montantRestant,
    numero_titre: titre.numero,
    mac,
  };
}

paiementsRouter.use(expressJsonFallback());

function expressJsonFallback() {
  return express.json({
    type: () => true,
    limit: '256kb',
  });
}

paiementsRouter.post('/callback/payfip', (req, res) => {
  const parsed = callbackSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const payload = parsed.data;
  const expectedMac = computePayfipMac({
    numeroTitre: payload.numero_titre,
    reference: payload.reference,
    montant: payload.montant,
    statut: payload.statut,
    transactionId: payload.transaction_id,
  });
  if (expectedMac !== payload.mac) {
    return res.status(400).json({ error: 'Signature PayFip invalide' });
  }

  const titre = loadTitreByNumero(payload.numero_titre);
  if (!titre) {
    return res.status(404).json({ error: 'Titre introuvable' });
  }

  const existing = db.prepare('SELECT id FROM paiements WHERE transaction_id = ?').get(payload.transaction_id) as { id: number } | undefined;
  if (existing) {
    return res.json({ ok: true, duplicated: true });
  }

  const paiementStatut = mapCallbackToPaymentStatus(payload.statut);
  db.prepare(
    `INSERT INTO paiements (
      titre_id, montant, date_paiement, modalite, reference, commentaire,
      provider, statut, transaction_id, callback_payload
    ) VALUES (?, ?, date('now'), 'tipi', ?, ?, 'payfip', ?, ?, ?)`,
  ).run(
    titre.id,
    payload.montant,
    payload.reference,
    `Callback PayFip ${payload.statut} (${payload.transaction_id})`,
    paiementStatut,
    payload.transaction_id,
    JSON.stringify(payload),
  );

  let newMontantPaye = titre.montant_paye;
  let titreStatut = titre.statut;
  if (paiementStatut === 'confirme') {
    newMontantPaye = Number((titre.montant_paye + payload.montant).toFixed(2));
    titreStatut = updateTitrePaiement(titre, newMontantPaye);
  }

  logAudit({
    userId: null,
    action: 'payment-payfip-callback',
    entite: 'titre',
    entiteId: titre.id,
    details: {
      numero_titre: titre.numero,
      montant: payload.montant,
      reference: payload.reference,
      transaction_id: payload.transaction_id,
      statut_callback: payload.statut,
      statut_paiement: paiementStatut,
    },
  });

  return res.json({ ok: true, statut: paiementStatut === 'confirme' ? titreStatut : paiementStatut, montant_paye: newMontantPaye });
});

export function registerPayfipTitresRoutes(titresRouter: Router) {
  titresRouter.post('/:id/payfip/initiate', requireRole('contribuable'), (req, res) => {
    const titre = loadTitreById(Number(req.params.id));
    if (!titre) return res.status(404).json({ error: 'Titre introuvable' });
    if (req.user!.assujetti_id !== titre.assujetti_id) {
      return res.status(403).json({ error: 'Droits insuffisants' });
    }
    if (titre.statut === 'paye') {
      return res.status(409).json({ error: 'Titre déjà payé' });
    }

    const payload = buildPayfipRedirectPayload(titre);
    if (payload.montant <= 0) {
      return res.status(409).json({ error: 'Titre déjà soldé' });
    }

    logAudit({
      userId: req.user!.id,
      action: 'payfip-initiate',
      entite: 'titre',
      entiteId: titre.id,
      details: {
        numero_titre: titre.numero,
        montant: payload.montant,
        reference: payload.reference,
      },
      ip: req.ip ?? null,
    });
    res.json(payload);
  });
}
