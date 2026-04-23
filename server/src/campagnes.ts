import { db, logAudit } from './db';
import { sendInvitationsForCampagne } from './invitations';
import { runRelancesDeclarations } from './relances';

export type CampagneStatut = 'brouillon' | 'ouverte' | 'cloturee';

export interface CampagneInput {
  annee: number;
  date_ouverture: string;
  date_limite_declaration: string;
  date_cloture: string;
  relance_j7_courrier?: boolean;
  created_by: number;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertIsoDate(value: string, field: string) {
  if (!ISO_DATE_RE.test(value)) {
    throw new Error(`${field} invalide (format YYYY-MM-DD attendu)`);
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const isValid =
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;

  if (!isValid) {
    throw new Error(`${field} invalide (date calendrier invalide)`);
  }
}

function validateTimeline(input: Omit<CampagneInput, 'created_by'>) {
  assertIsoDate(input.date_ouverture, 'date_ouverture');
  assertIsoDate(input.date_limite_declaration, 'date_limite_declaration');
  assertIsoDate(input.date_cloture, 'date_cloture');

  if (input.date_limite_declaration < input.date_ouverture) {
    throw new Error('date_limite_declaration doit etre >= date_ouverture');
  }
  if (input.date_cloture < input.date_limite_declaration) {
    throw new Error('date_cloture doit etre >= date_limite_declaration');
  }
}

export function listCampagnes() {
  return db
    .prepare(
      `SELECT c.*, u.email AS created_by_email
       FROM campagnes c
       LEFT JOIN users u ON u.id = c.created_by
       ORDER BY c.annee DESC`,
    )
    .all();
}

export function getCampagneActive() {
  return db
    .prepare(
      `SELECT c.*, u.email AS created_by_email
       FROM campagnes c
       LEFT JOIN users u ON u.id = c.created_by
       WHERE c.statut = 'ouverte'
       ORDER BY c.annee DESC
       LIMIT 1`,
    )
    .get();
}

export function createCampagne(input: CampagneInput) {
  validateTimeline(input);

  const existing = db.prepare('SELECT id FROM campagnes WHERE annee = ?').get(input.annee) as { id: number } | undefined;
  if (existing) {
    throw new Error(`Une campagne existe deja pour l'annee ${input.annee}`);
  }

  const info = db
    .prepare(
      `INSERT INTO campagnes (annee, date_ouverture, date_limite_declaration, date_cloture, statut, relance_j7_courrier, created_by)
       VALUES (?, ?, ?, ?, 'brouillon', ?, ?)`,
    )
    .run(
      input.annee,
      input.date_ouverture,
      input.date_limite_declaration,
      input.date_cloture,
      input.relance_j7_courrier ? 1 : 0,
      input.created_by,
    );

  const campagneId = Number(info.lastInsertRowid);
  logAudit({
    userId: input.created_by,
    action: 'create',
    entite: 'campagne',
    entiteId: campagneId,
    details: {
      annee: input.annee,
      date_ouverture: input.date_ouverture,
      date_limite_declaration: input.date_limite_declaration,
      date_cloture: input.date_cloture,
      relance_j7_courrier: input.relance_j7_courrier ? 1 : 0,
    },
  });

  return campagneId;
}

export function openCampagne(campagneId: number, userId: number, ip?: string | null) {
  const tx = db.transaction(() => {
    const campagne = db.prepare('SELECT * FROM campagnes WHERE id = ?').get(campagneId) as
      | { id: number; annee: number; statut: CampagneStatut }
      | undefined;
    if (!campagne) throw new Error('Campagne introuvable');
    if (campagne.statut === 'ouverte') throw new Error('La campagne est deja ouverte');
    if (campagne.statut === 'cloturee') throw new Error('Une campagne cloturee ne peut pas etre reouverte');

    db.prepare("UPDATE campagnes SET statut = 'brouillon', updated_at = datetime('now') WHERE statut = 'ouverte' AND id != ?").run(campagneId);

    db.prepare("UPDATE campagnes SET statut = 'ouverte', updated_at = datetime('now') WHERE id = ?").run(campagneId);

    const pendingInvitations = (
      db
        .prepare(
          `SELECT COUNT(*) AS c
           FROM campagne_jobs
           WHERE campagne_id = ? AND type = 'invitation' AND statut = 'pending'`,
        )
        .get(campagneId) as { c: number }
    ).c;

    if (pendingInvitations === 0) {
      db.prepare(
        `INSERT INTO campagne_jobs (campagne_id, type, statut, payload)
         VALUES (?, 'invitation', 'pending', ?)`,
      ).run(campagneId, JSON.stringify({ annee: campagne.annee }));
    }

    const invitations = sendInvitationsForCampagne({
      campagneId,
      userId,
      mode: 'auto',
      ip: ip ?? null,
    });

    db.prepare(
      `UPDATE campagne_jobs
       SET statut = 'done', started_at = datetime('now'), completed_at = datetime('now'),
           payload = json_set(
             json_set(
               json_set(COALESCE(payload, '{}'), '$.invitations_preparees', ?),
               '$.invitations_failed', ?
             ),
             '$.invitations_skipped', ?
           )
       WHERE campagne_id = ? AND type = 'invitation' AND statut = 'pending'`,
    ).run(invitations.prepared, invitations.failed, invitations.skipped, campagneId);

    logAudit({
      userId,
      action: 'open',
      entite: 'campagne',
      entiteId: campagneId,
      details: {
        annee: campagne.annee,
        invitations_preparees: invitations.prepared,
        invitations_failed: invitations.failed,
        invitations_skipped: invitations.skipped,
      },
      ip: ip ?? null,
    });

    return { annee: campagne.annee, invitations_preparees: invitations.prepared };
  });

  return tx();
}

export function closeCampagne(campagneId: number, userId: number, ip?: string | null) {
  const tx = db.transaction(() => {
    const campagne = db.prepare('SELECT * FROM campagnes WHERE id = ?').get(campagneId) as
      | { id: number; annee: number; statut: CampagneStatut; date_limite_declaration: string }
      | undefined;
    if (!campagne) throw new Error('Campagne introuvable');
    if (campagne.statut !== 'ouverte') throw new Error('Seule une campagne ouverte peut etre cloturee');

    const runDate = campagne.date_limite_declaration;
    const relances = runRelancesDeclarations({
      runDateIso: runDate,
      userId,
      ip: ip ?? null,
    });

    db.prepare("UPDATE campagnes SET statut = 'cloturee', updated_at = datetime('now') WHERE id = ?").run(campagneId);

    const brouillons = db
      .prepare(
        `SELECT id
         FROM declarations
         WHERE annee = ? AND statut = 'brouillon'`,
      )
      .all(campagne.annee) as Array<{ id: number }>;

    const updateDecl = db.prepare(
      `UPDATE declarations
       SET statut = 'en_instruction', updated_at = datetime('now')
       WHERE id = ?`,
    );
    const insertMise = db.prepare(
      `INSERT INTO mises_en_demeure (campagne_id, declaration_id, statut)
       VALUES (?, ?, 'a_traiter')
       ON CONFLICT(declaration_id) DO NOTHING`,
    );

    for (const decl of brouillons) {
      updateDecl.run(decl.id);
      insertMise.run(campagneId, decl.id);
    }

    const changed = brouillons.length;

    db.prepare(
      `INSERT INTO campagne_jobs (campagne_id, type, statut, payload, started_at, completed_at)
       VALUES (?, 'cloture', 'done', ?, datetime('now'), datetime('now'))`,
    ).run(campagneId, JSON.stringify({ brouillons_bascules: changed, relances }));

    logAudit({
      userId,
      action: 'close',
      entite: 'campagne',
      entiteId: campagneId,
      details: { annee: campagne.annee, brouillons_bascules: changed, relances },
      ip: ip ?? null,
    });

    return { annee: campagne.annee, brouillons_bascules: changed, relances };
  });

  return tx();
}
