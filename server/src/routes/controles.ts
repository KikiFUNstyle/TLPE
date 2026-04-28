import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../auth';
import { db, logAudit } from '../db';
import { normalizeIsoDate } from '../contentieuxDeadline';
import { findZoneIdByPoint } from '../zones';

export const controlesRouter = Router();

controlesRouter.use(authMiddleware);
controlesRouter.use(requireRole('admin', 'gestionnaire', 'controleur'));

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide (format attendu YYYY-MM-DD)');

const createDispositifSchema = z.object({
  assujetti_id: z.number().int().positive(),
  type_id: z.number().int().positive(),
  zone_id: z.number().int().positive().nullable().optional(),
  adresse_rue: z.string().trim().min(1).optional().nullable(),
  adresse_cp: z.string().trim().min(1).optional().nullable(),
  adresse_ville: z.string().trim().min(1).optional().nullable(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  surface: z.number().positive(),
  nombre_faces: z.number().int().min(1).max(4).default(1),
  statut: z.enum(['declare', 'controle', 'litigieux', 'depose', 'exonere']).optional(),
  notes: z.string().trim().min(1).optional().nullable(),
});

const controleSchema = z
  .object({
    dispositif_id: z.number().int().positive().nullable().optional(),
    create_dispositif: createDispositifSchema.nullable().optional(),
    date_controle: isoDateSchema,
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    surface_mesuree: z.number().positive(),
    nombre_faces_mesurees: z.number().int().min(1).max(4),
    ecart_detecte: z.boolean(),
    ecart_description: z.string().trim().max(2000).optional().nullable(),
    statut: z.enum(['saisi', 'cloture']).optional(),
  })
  .superRefine((value, ctx) => {
    const hasExisting = typeof value.dispositif_id === 'number';
    const hasCreate = Boolean(value.create_dispositif);
    if (!hasExisting && !hasCreate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dispositif_id'],
        message: 'Un contrôle doit être rattaché à un dispositif existant ou créer une nouvelle fiche dispositif',
      });
    }
    if (hasExisting && hasCreate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['create_dispositif'],
        message: 'Choisissez soit un dispositif existant, soit la création d’une nouvelle fiche',
      });
    }
    if (value.ecart_detecte && !value.ecart_description?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ecart_description'],
        message: 'La description de l’écart est obligatoire quand une anomalie est signalée',
      });
    }
  });

function generateDispositifIdentifiant(): string {
  const year = new Date().getFullYear();
  const maxId = (db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM dispositifs').get() as { max_id: number }).max_id;
  return `DSP-${year}-${String(Number(maxId) + 1).padStart(6, '0')}`;
}

function createDispositifFromControle(input: z.infer<typeof createDispositifSchema>, userId: number) {
  const computedZoneId =
    input.zone_id ??
    (input.latitude !== null && input.latitude !== undefined && input.longitude !== null && input.longitude !== undefined
      ? findZoneIdByPoint({ latitude: input.latitude, longitude: input.longitude })
      : null);
  const identifiant = generateDispositifIdentifiant();
  const info = db
    .prepare(
      `INSERT INTO dispositifs (
        identifiant, assujetti_id, type_id, zone_id,
        adresse_rue, adresse_cp, adresse_ville,
        latitude, longitude, surface, nombre_faces,
        statut, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      identifiant,
      input.assujetti_id,
      input.type_id,
      computedZoneId,
      input.adresse_rue ?? null,
      input.adresse_cp ?? null,
      input.adresse_ville ?? null,
      input.latitude ?? null,
      input.longitude ?? null,
      input.surface,
      input.nombre_faces,
      input.statut ?? 'controle',
      input.notes ?? 'Créé depuis un constat terrain',
    );

  const dispositifId = Number(info.lastInsertRowid);
  logAudit({
    userId,
    action: 'create',
    entite: 'dispositif',
    entiteId: dispositifId,
    details: { origine: 'controle-terrain', identifiant },
  });

  return { dispositifId, identifiant };
}

function isForeignKeyConstraintError(error: unknown): boolean {
  return error instanceof Error && /foreign key constraint failed/i.test(error.message);
}

function ensureDispositifExists(dispositifId: number) {
  return db.prepare('SELECT id, identifiant, surface, nombre_faces FROM dispositifs WHERE id = ?').get(dispositifId) as
    | { id: number; identifiant: string; surface: number; nombre_faces: number }
    | undefined;
}

controlesRouter.get('/', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT c.id,
              c.dispositif_id,
              c.agent_id,
              c.date_controle,
              c.latitude,
              c.longitude,
              c.surface_mesuree,
              c.nombre_faces_mesurees,
              c.ecart_detecte,
              c.ecart_description,
              c.statut,
              c.created_at,
              c.updated_at,
              d.identifiant AS dispositif_identifiant,
              d.surface AS dispositif_surface,
              d.nombre_faces AS dispositif_nombre_faces,
              a.raison_sociale AS assujetti_raison_sociale,
              trim(coalesce(u.prenom, '') || ' ' || coalesce(u.nom, '')) AS agent_nom,
              COALESCE((
                SELECT COUNT(*)
                FROM pieces_jointes pj
                WHERE pj.entite = 'controle'
                  AND pj.entite_id = c.id
                  AND pj.deleted_at IS NULL
              ), 0) AS photos_count
       FROM controles c
       LEFT JOIN dispositifs d ON d.id = c.dispositif_id
       LEFT JOIN assujettis a ON a.id = d.assujetti_id
       LEFT JOIN users u ON u.id = c.agent_id
       ORDER BY c.date_controle DESC, c.id DESC`,
    )
    .all() as Array<Record<string, unknown>>;

  res.json(
    rows.map((row) => ({
      ...row,
      ecart_detecte: Number(row.ecart_detecte) === 1,
      photos_count: Number(row.photos_count ?? 0),
    })),
  );
});

controlesRouter.post('/', (req, res) => {
  const parsed = controleSchema.safeParse(req.body);
  if (!parsed.success) {
    const flattened = parsed.error.flatten();
    const firstFieldError = Object.values(flattened.fieldErrors).flat().find((message): message is string => Boolean(message));
    const firstFormError = flattened.formErrors.find((message): message is string => Boolean(message));
    return res.status(400).json({
      error: firstFieldError ?? firstFormError ?? 'Payload de contrôle invalide',
      details: flattened,
    });
  }

  const input = parsed.data;
  const userId = req.user!.id;

  try {
    normalizeIsoDate(input.date_controle);
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Date invalide (format attendu YYYY-MM-DD)',
    });
  }

  let dispositifId = input.dispositif_id ?? null;
  let createdDispositifIdentifiant: string | null = null;

  if (input.create_dispositif) {
    try {
      const created = createDispositifFromControle(input.create_dispositif, userId);
      dispositifId = created.dispositifId;
      createdDispositifIdentifiant = created.identifiant;
    } catch (error) {
      if (isForeignKeyConstraintError(error)) {
        return res.status(400).json({
          error: 'Référentiel invalide pour le dispositif créé (assujetti, type ou zone introuvable)',
        });
      }
      throw error;
    }
  } else if (dispositifId !== null) {
    const existingDispositif = ensureDispositifExists(dispositifId);
    if (!existingDispositif) {
      return res.status(404).json({ error: 'Dispositif introuvable' });
    }
  }

  const info = db
    .prepare(
      `INSERT INTO controles (
        dispositif_id, agent_id, date_controle, latitude, longitude,
        surface_mesuree, nombre_faces_mesurees, ecart_detecte, ecart_description, statut
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      dispositifId,
      userId,
      input.date_controle,
      input.latitude,
      input.longitude,
      input.surface_mesuree,
      input.nombre_faces_mesurees,
      input.ecart_detecte ? 1 : 0,
      input.ecart_description?.trim() || null,
      input.statut ?? 'saisi',
    );

  const controleId = Number(info.lastInsertRowid);

  if (dispositifId !== null) {
    db.prepare(`UPDATE dispositifs SET statut = 'controle', updated_at = datetime('now') WHERE id = ?`).run(dispositifId);
  }

  logAudit({
    userId,
    action: 'create',
    entite: 'controle',
    entiteId: controleId,
    details: {
      dispositif_id: dispositifId,
      created_dispositif_identifiant: createdDispositifIdentifiant,
      ecart_detecte: input.ecart_detecte,
      date_controle: input.date_controle,
    },
    ip: req.ip ?? null,
  });

  res.status(201).json({
    id: controleId,
    dispositif_id: dispositifId,
    created_dispositif_identifiant: createdDispositifIdentifiant,
    photos_count: 0,
  });
});
