import * as crypto from 'node:crypto';
import { type Request, type Response, Router } from 'express';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../auth';
import {
  computeContentieuxResponseDeadline,
  summarizeContentieuxDeadline,
  todayIsoDate,
} from '../contentieuxDeadline';
import { db, logAudit } from '../db';

export const contentieuxRouter = Router();

contentieuxRouter.use(authMiddleware);

const timelineEventTypes = [
  'ouverture',
  'courrier',
  'statut',
  'decision',
  'jugement',
  'relance',
  'commentaire',
] as const;

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

type TimelineEventType = (typeof timelineEventTypes)[number];

type ContentieuxAttachmentType = 'courrier-admin' | 'courrier-contribuable' | 'decision' | 'jugement';

function isValidIsoCalendarDate(value: string): boolean {
  if (!isoDateRegex.test(value)) return false;
  const [yearRaw, monthRaw, dayRaw] = value.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

const createSchema = z.object({
  assujetti_id: z.number().int().positive(),
  titre_id: z.number().int().positive().nullable().optional(),
  type: z.enum(['gracieux', 'contentieux', 'moratoire', 'controle']),
  montant_litige: z.number().min(0).nullable().optional(),
  description: z.string().trim().min(1),
  date_ouverture: z.string().refine(isValidIsoCalendarDate, 'Date invalide (format calendrier attendu YYYY-MM-DD)').optional(),
});

const extendDeadlineSchema = z.object({
  date_limite_reponse: z.string().refine(isValidIsoCalendarDate, 'Date limite invalide (format calendrier attendu YYYY-MM-DD)'),
  justification: z.string().trim().min(5, 'Justification obligatoire (min. 5 caractères)'),
});

const decideSchema = z.object({
  statut: z.enum(['instruction', 'clos_maintenu', 'degrevement_partiel', 'degrevement_total', 'non_lieu']),
  decision: z.string().trim().optional().nullable(),
  montant_degreve: z.number().min(0).nullable().optional(),
});

const manualEventSchema = z.object({
  type: z.enum(['courrier', 'statut', 'decision', 'jugement', 'relance', 'commentaire']),
  date: z.string().refine(isValidIsoCalendarDate, 'Date invalide (format calendrier attendu YYYY-MM-DD)'),
  auteur: z.string().trim().min(1).max(120).optional().nullable(),
  description: z.string().trim().min(1),
  piece_jointe_id: z.number().int().positive().nullable().optional(),
});

type ContentieuxRow = {
  id: number;
  numero: string;
  assujetti_id: number;
  titre_id: number | null;
  type: string;
  montant_litige: number | null;
  montant_degreve: number | null;
  date_ouverture: string;
  date_limite_reponse: string | null;
  date_limite_reponse_initiale: string | null;
  delai_prolonge_justification: string | null;
  delai_prolonge_par: number | null;
  delai_prolonge_at: string | null;
  date_cloture: string | null;
  statut: string;
  description: string;
  decision: string | null;
  raison_sociale: string | null;
};

type TimelineEventRow = {
  id: number;
  contentieux_id: number;
  type: TimelineEventType;
  date: string;
  auteur: string | null;
  description: string;
  piece_jointe_id: number | null;
  created_at: string;
  piece_jointe_nom: string | null;
  piece_jointe_entite?: string | null;
  piece_jointe_entite_id?: number | null;
};

type ContentieuxAttachmentRow = {
  id: number;
  nom: string;
  mime_type: string;
  taille: number;
  type_piece: ContentieuxAttachmentType | null;
  uploaded_by: number | null;
  created_at: string;
  auteur_nom: string | null;
  auteur_role: string | null;
};

const eventTypeLabels: Record<TimelineEventType, string> = {
  ouverture: 'Ouverture',
  courrier: 'Courrier',
  statut: 'Statut',
  decision: 'Décision',
  jugement: 'Jugement',
  relance: 'Relance',
  commentaire: 'Commentaire',
};

const statusLabels: Record<string, string> = {
  ouvert: 'Ouvert',
  instruction: 'En instruction',
  clos_maintenu: 'Clos - titre maintenu',
  degrevement_partiel: 'Dégrevement partiel',
  degrevement_total: 'Dégrevement total',
  non_lieu: 'Non-lieu',
};

const attachmentTypeLabels: Record<ContentieuxAttachmentType, string> = {
  'courrier-admin': 'Courrier administration',
  'courrier-contribuable': 'Courrier contribuable',
  decision: 'Décision',
  jugement: 'Jugement',
};


function genNumero(): string {
  const year = new Date().getFullYear();
  const count = (
    db.prepare('SELECT COUNT(*) AS c FROM contentieux WHERE numero LIKE ?').get(`CTX-${year}-%`) as { c: number }
  ).c;
  return `CTX-${year}-${String(count + 1).padStart(5, '0')}`;
}

function displayUser(user: Request['user']): string {
  if (!user) return 'Système TLPE';
  const fullName = `${user.prenom} ${user.nom}`.trim();
  return fullName || user.email;
}

function loadContentieux(id: number): ContentieuxRow | undefined {
  return db
    .prepare(
      `SELECT c.*, a.raison_sociale
       FROM contentieux c
       LEFT JOIN assujettis a ON a.id = c.assujetti_id
       WHERE c.id = ?`,
    )
    .get(id) as ContentieuxRow | undefined;
}

function canAccessContentieux(user: Request['user'], contentieux: ContentieuxRow): boolean {
  if (!user) return false;
  if (user.role !== 'contribuable') return true;
  return user.assujetti_id !== null && user.assujetti_id === contentieux.assujetti_id;
}

function ensureContentieuxAccess(req: Request, res: Response): ContentieuxRow | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Identifiant de contentieux invalide' });
    return null;
  }

  const contentieux = loadContentieux(id);
  if (!contentieux) {
    res.status(404).json({ error: 'Introuvable' });
    return null;
  }

  if (!canAccessContentieux(req.user, contentieux)) {
    res.status(403).json({ error: 'Droits insuffisants' });
    return null;
  }

  return contentieux;
}

function insertTimelineEvent(params: {
  contentieuxId: number;
  type: TimelineEventType;
  date: string;
  auteur?: string | null;
  description: string;
  pieceJointeId?: number | null;
}): number {
  const result = db
    .prepare(
      `INSERT INTO evenements_contentieux (contentieux_id, type, date, auteur, description, piece_jointe_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.contentieuxId,
      params.type,
      params.date,
      params.auteur ?? null,
      params.description,
      params.pieceJointeId ?? null,
    );
  return Number(result.lastInsertRowid);
}

function loadTimeline(contentieuxId: number): TimelineEventRow[] {
  return db
    .prepare(
      `SELECT e.*, p.nom AS piece_jointe_nom, p.entite AS piece_jointe_entite, p.entite_id AS piece_jointe_entite_id
       FROM evenements_contentieux e
       LEFT JOIN pieces_jointes p ON p.id = e.piece_jointe_id AND p.deleted_at IS NULL
       WHERE e.contentieux_id = ?
       ORDER BY e.date ASC, e.created_at ASC, e.id ASC`,
    )
    .all(contentieuxId) as TimelineEventRow[];
}

function redactTimelineForUser(user: Request['user'], timeline: TimelineEventRow[]): TimelineEventRow[] {
  return timeline.map((event) => {
    if (!event.piece_jointe_id) return event;
    if (event.piece_jointe_entite === 'contentieux' && user?.role === 'financier') {
      return {
        ...event,
        piece_jointe_id: null,
        piece_jointe_nom: null,
        piece_jointe_entite: null,
        piece_jointe_entite_id: null,
      };
    }
    return event;
  });
}

function timelineDecisionEventDate(): string {
  return todayIsoDate();
}

function canAccessContentieuxAttachments(user: Request['user']): boolean {
  if (!user) return false;
  return user.role !== 'financier';
}

function resolveAttachmentTypeLabel(typePiece: ContentieuxAttachmentType | null): string {
  if (!typePiece) return 'Pièce jointe';
  return attachmentTypeLabels[typePiece] ?? 'Pièce jointe';
}

function loadContentieuxAttachments(contentieuxId: number): ContentieuxAttachmentRow[] {
  return db
    .prepare(
      `SELECT pj.id, pj.nom, pj.mime_type, pj.taille, pj.type_piece, pj.uploaded_by, pj.created_at,
              trim(COALESCE(u.prenom, '') || ' ' || COALESCE(u.nom, '')) AS auteur_nom,
              u.role AS auteur_role
       FROM pieces_jointes pj
       LEFT JOIN users u ON u.id = pj.uploaded_by
       WHERE pj.entite = 'contentieux' AND pj.entite_id = ? AND pj.deleted_at IS NULL
       ORDER BY pj.created_at DESC, pj.id DESC`,
    )
    .all(contentieuxId) as ContentieuxAttachmentRow[];
}

function loadAccessiblePieceJointeForTimeline(
  pieceJointeId: number,
  contentieux: ContentieuxRow,
  user: Request['user'],
): { id: number; nom: string | null } | null {
  const row = db
    .prepare(
      `SELECT id, nom, entite, entite_id
       FROM pieces_jointes
       WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(pieceJointeId) as { id: number; nom: string | null; entite: string; entite_id: number } | undefined;
  if (!row) return null;
  if (row.entite !== 'contentieux' || row.entite_id !== contentieux.id) return null;
  if (user?.role === 'financier') return null;
  return { id: row.id, nom: row.nom };
}

function buildTimelinePdfBuffer(contentieux: ContentieuxRow, events: TimelineEventRow[]) {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42 });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('Timeline contentieux', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#555').text(`Dossier ${contentieux.numero} • ${contentieux.raison_sociale ?? 'Assujetti inconnu'}`, {
      align: 'center',
    });
    doc.moveDown(1).fillColor('black');

    doc.fontSize(11);
    doc.text(`Type : ${contentieux.type}`);
    doc.text(`Statut : ${statusLabels[contentieux.statut] ?? contentieux.statut}`);
    doc.text(`Date d'ouverture : ${contentieux.date_ouverture}`);
    if (contentieux.date_cloture) doc.text(`Date de clôture : ${contentieux.date_cloture}`);
    if (contentieux.montant_litige !== null) doc.text(`Montant litigieux : ${contentieux.montant_litige.toFixed(2)} EUR`);
    doc.moveDown();

    doc.fontSize(12).text('Description initiale', { underline: true });
    doc.fontSize(10).text(contentieux.description || '-');
    doc.moveDown();

    doc.fontSize(12).text('Chronologie', { underline: true });
    doc.moveDown(0.5);

    if (events.length === 0) {
      doc.fontSize(10).text('Aucun événement enregistré.');
    } else {
      for (const event of events) {
        const title = `${event.date} • ${eventTypeLabels[event.type] ?? event.type}`;
        doc.fontSize(11).fillColor('#000091').text(title);
        doc.fontSize(9).fillColor('#555');
        if (event.auteur) {
          doc.text(`Auteur : ${event.auteur}`);
        }
        if (event.piece_jointe_nom) {
          doc.text(`Pièce jointe : ${event.piece_jointe_nom}`);
        }
        doc.fontSize(10).fillColor('black').text(event.description, {
          paragraphGap: 8,
        });
      }
    }

    doc.end();
  });
}

contentieuxRouter.get('/', (req, res) => {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (req.user!.role === 'contribuable') {
    if (!req.user!.assujetti_id) return res.json([]);
    conditions.push('c.assujetti_id = ?');
    params.push(req.user!.assujetti_id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT c.*, a.raison_sociale
       FROM contentieux c
       LEFT JOIN assujettis a ON a.id = c.assujetti_id
       ${where}
       ORDER BY c.date_ouverture DESC, c.id DESC`,
    )
    .all(...params) as Array<ContentieuxRow>;
  res.json(
    rows.map((row) => ({
      ...row,
      ...summarizeContentieuxDeadline(
        {
          date_limite_reponse: row.date_limite_reponse,
          date_limite_reponse_initiale: row.date_limite_reponse_initiale,
          delai_prolonge_justification: row.delai_prolonge_justification,
        },
        todayIsoDate(),
      ),
    })),
  );
});

contentieuxRouter.post('/', requireRole('admin', 'gestionnaire', 'contribuable'), (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const payload = parsed.data;
  if (req.user!.role === 'contribuable' && req.user!.assujetti_id !== payload.assujetti_id) {
    return res.status(403).json({ error: 'Droits insuffisants' });
  }

  const numero = genNumero();
  const openedAt = payload.date_ouverture ?? todayIsoDate();
  const responseDeadline = computeContentieuxResponseDeadline(openedAt);
  const actor = displayUser(req.user);

  const created = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO contentieux (
          numero, assujetti_id, titre_id, type, montant_litige, montant_degreve, description,
          date_ouverture, date_limite_reponse, date_limite_reponse_initiale
        )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        numero,
        payload.assujetti_id,
        payload.titre_id ?? null,
        payload.type,
        payload.montant_litige ?? null,
        null,
        payload.description,
        openedAt,
        responseDeadline,
        responseDeadline,
      );

    const contentieuxId = Number(info.lastInsertRowid);
    insertTimelineEvent({
      contentieuxId,
      type: 'ouverture',
      date: openedAt,
      auteur: actor,
      description: payload.description,
    });

    logAudit({
      userId: req.user!.id,
      action: 'create',
      entite: 'contentieux',
      entiteId: contentieuxId,
      details: { numero, type: payload.type, opened_at: openedAt, date_limite_reponse: responseDeadline },
      ip: req.ip ?? null,
    });

    return { id: contentieuxId, numero, date_limite_reponse: responseDeadline };
  })();

  res.status(201).json(created);
});

contentieuxRouter.get('/:id/timeline', (req, res) => {
  const contentieux = ensureContentieuxAccess(req, res);
  if (!contentieux) return;
  res.json(redactTimelineForUser(req.user, loadTimeline(contentieux.id)));
});

contentieuxRouter.get('/:id/pieces-jointes', (req, res) => {
  const contentieux = ensureContentieuxAccess(req, res);
  if (!contentieux) return;
  if (!canAccessContentieuxAttachments(req.user)) {
    return res.status(403).json({ error: 'Droits insuffisants' });
  }

  const rows = loadContentieuxAttachments(contentieux.id);
  res.json(
    rows.map((row) => ({
      id: row.id,
      nom: row.nom,
      mime_type: row.mime_type,
      taille: row.taille,
      type_piece: row.type_piece,
      type_piece_label: resolveAttachmentTypeLabel(row.type_piece),
      created_at: row.created_at,
      auteur: row.auteur_nom?.trim() || 'Utilisateur inconnu',
      auteur_role: row.auteur_role,
      access_mode: req.user?.role === 'contribuable' ? 'lecture-seule' : 'gestion',
      can_delete: req.user?.role !== 'contribuable',
      download_url: `/api/pieces-jointes/${row.id}`,
    })),
  );
});

contentieuxRouter.post('/:id/evenements', requireRole('admin', 'gestionnaire', 'financier'), (req, res) => {
  const contentieux = ensureContentieuxAccess(req, res);
  if (!contentieux) return;

  const parsed = manualEventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const linkedPieceJointe = parsed.data.piece_jointe_id
    ? loadAccessiblePieceJointeForTimeline(parsed.data.piece_jointe_id, contentieux, req.user)
    : null;
  if (parsed.data.piece_jointe_id && !linkedPieceJointe) {
    return res.status(req.user?.role === 'financier' ? 403 : 400).json({ error: 'Pièce jointe introuvable ou inaccessible' });
  }

  const eventId = db.transaction(() => {
    const createdId = insertTimelineEvent({
      contentieuxId: contentieux.id,
      type: parsed.data.type,
      date: parsed.data.date,
      auteur: parsed.data.auteur?.trim() || displayUser(req.user),
      description: parsed.data.description,
      pieceJointeId: linkedPieceJointe?.id ?? null,
    });

    logAudit({
      userId: req.user!.id,
      action: 'timeline-event',
      entite: 'contentieux',
      entiteId: contentieux.id,
      details: {
        event_id: createdId,
        event_type: parsed.data.type,
        event_date: parsed.data.date,
        piece_jointe_id: linkedPieceJointe?.id ?? null,
      },
      ip: req.ip ?? null,
    });

    return createdId;
  })();

  res.status(201).json({ id: eventId });
});

contentieuxRouter.post('/:id/prolonger-delai', requireRole('admin', 'gestionnaire', 'financier'), (req, res) => {
  const contentieux = ensureContentieuxAccess(req, res);
  if (!contentieux) return;

  const parsed = extendDeadlineSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (!contentieux.date_limite_reponse) {
    return res.status(400).json({ error: 'Aucune échéance existante à prolonger' });
  }

  const nextDeadline = parsed.data.date_limite_reponse;
  if (nextDeadline <= contentieux.date_limite_reponse) {
    return res.status(400).json({ error: 'La nouvelle date limite doit être postérieure à la date actuelle' });
  }

  const justification = parsed.data.justification.trim();
  const actor = displayUser(req.user);
  const changedAt = new Date().toISOString();
  const eventDate = changedAt.slice(0, 10);
  const initialDeadline = contentieux.date_limite_reponse_initiale ?? contentieux.date_limite_reponse;

  db.transaction(() => {
    db.prepare(
      `UPDATE contentieux
       SET date_limite_reponse = ?,
           date_limite_reponse_initiale = ?,
           delai_prolonge_justification = ?,
           delai_prolonge_par = ?,
           delai_prolonge_at = ?
       WHERE id = ?`,
    ).run(nextDeadline, initialDeadline, justification, req.user!.id, changedAt, contentieux.id);

    insertTimelineEvent({
      contentieuxId: contentieux.id,
      type: 'relance',
      date: eventDate,
      auteur: actor,
      description: `Délai prolongé du ${contentieux.date_limite_reponse} au ${nextDeadline} — ${justification}`,
    });

    logAudit({
      userId: req.user!.id,
      action: 'extend-deadline',
      entite: 'contentieux',
      entiteId: contentieux.id,
      details: {
        previous_deadline: contentieux.date_limite_reponse,
        new_deadline: nextDeadline,
        justification,
      },
      ip: req.ip ?? null,
    });
  })();

  res.json({
    ok: true,
    date_limite_reponse: nextDeadline,
    date_limite_reponse_initiale: initialDeadline,
    delai_prolonge_justification: justification,
    delai_prolonge_at: changedAt,
  });
});

contentieuxRouter.post('/:id/decider', requireRole('admin', 'gestionnaire', 'financier'), (req, res) => {
  const contentieux = ensureContentieuxAccess(req, res);
  if (!contentieux) return;

  const parsed = decideSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const closed = parsed.data.statut !== 'instruction';
  const actor = displayUser(req.user);
  const eventDate = timelineDecisionEventDate();
  const shouldStoreDegrevement = parsed.data.statut === 'degrevement_partiel' || parsed.data.statut === 'degrevement_total';
  const montantLitige = contentieux.montant_litige ?? null;
  const fallbackDegrevement = parsed.data.statut === 'degrevement_total' ? montantLitige : null;
  const montantDegreve = shouldStoreDegrevement ? parsed.data.montant_degreve ?? fallbackDegrevement : null;

  if (parsed.data.statut === 'degrevement_partiel' && montantDegreve === null) {
    return res.status(400).json({ error: 'Le montant dégrevé est obligatoire pour un dégrèvement partiel' });
  }
  if (montantLitige !== null && montantDegreve !== null && montantDegreve > montantLitige) {
    return res.status(400).json({ error: 'Le montant dégrevé ne peut pas dépasser le montant en litige' });
  }

  db.transaction(() => {
    db.prepare(
      `UPDATE contentieux
       SET statut = ?,
           decision = ?,
           montant_degreve = ?,
           date_cloture = ${closed ? "date('now')" : 'NULL'}
       WHERE id = ?`,
    ).run(parsed.data.statut, parsed.data.decision ?? null, montantDegreve, contentieux.id);

    insertTimelineEvent({
      contentieuxId: contentieux.id,
      type: 'statut',
      date: eventDate,
      auteur: actor,
      description: `Statut mis à jour : ${statusLabels[parsed.data.statut] ?? parsed.data.statut}`,
    });

    if (parsed.data.decision) {
      insertTimelineEvent({
        contentieuxId: contentieux.id,
        type: 'decision',
        date: eventDate,
        auteur: actor,
        description: parsed.data.decision,
      });
    }

    logAudit({
      userId: req.user!.id,
      action: 'decide',
      entite: 'contentieux',
      entiteId: contentieux.id,
      details: parsed.data,
      ip: req.ip ?? null,
    });
  })();

  res.json({ ok: true });
});

contentieuxRouter.get('/:id/timeline/pdf', async (req, res) => {
  try {
    const contentieux = ensureContentieuxAccess(req, res);
    if (!contentieux) return;

    const events = redactTimelineForUser(req.user, loadTimeline(contentieux.id));
    const generatedAt = new Date().toISOString();
    const hash = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          generated_at: generatedAt,
          contentieux_id: contentieux.id,
          numero: contentieux.numero,
          events,
        }),
      )
      .digest('hex');
    const filename = `timeline-contentieux-${contentieux.numero}.pdf`;
    const pdf = await buildTimelinePdfBuffer(contentieux, events);

    logAudit({
      userId: req.user!.id,
      action: 'export-timeline-contentieux',
      entite: 'contentieux',
      entiteId: contentieux.id,
      details: {
        generated_at: generatedAt,
        hash,
        filename,
        events_count: events.length,
      },
      ip: req.ip ?? null,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(pdf.length));
    res.send(pdf);
  } catch (error) {
    console.error('[TLPE] Erreur export timeline contentieux', error);
    res.status(500).json({ error: 'Erreur interne export timeline contentieux' });
  }
});
