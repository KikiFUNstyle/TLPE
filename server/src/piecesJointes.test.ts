import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initSchema, db } from './db';
import { hashPassword } from './auth';
import { detectMimeFromMagicBytes } from './routes/piecesJointes';

const uploadsRoot = path.resolve(__dirname, '..', 'data', 'uploads');

function seedFixture() {
  initSchema();

  db.exec('DELETE FROM pesv2_export_titres');
  db.exec('DELETE FROM pesv2_exports');
  db.exec('DELETE FROM declaration_receipts');
  db.exec('DELETE FROM notifications_email');
  db.exec('DELETE FROM invitation_magic_links');
  db.exec('DELETE FROM campagne_jobs');
  db.exec('DELETE FROM mises_en_demeure');
  db.exec('DELETE FROM paiements');
  db.exec('DELETE FROM titres');
  db.exec('DELETE FROM pieces_jointes');
  db.exec('DELETE FROM contentieux');
  db.exec('DELETE FROM lignes_declaration');
  db.exec('DELETE FROM declarations');
  db.exec('DELETE FROM dispositifs');
  db.exec('DELETE FROM campagnes');
  db.exec('DELETE FROM audit_log');
  db.exec('DELETE FROM users');
  db.exec('DELETE FROM assujettis');
  db.exec('DELETE FROM types_dispositifs');

  const typeId = Number(
    db
      .prepare(`INSERT INTO types_dispositifs (code, libelle, categorie) VALUES ('ENS-PLAT', 'Enseigne', 'enseigne')`)
      .run().lastInsertRowid,
  );
  const assujettiId = Number(
    db
      .prepare(`INSERT INTO assujettis (identifiant_tlpe, raison_sociale) VALUES ('TLPE-T-1', 'Assujetti Test')`)
      .run().lastInsertRowid,
  );

  const dispositifId = Number(
    db
      .prepare(
        `INSERT INTO dispositifs (identifiant, assujetti_id, type_id, surface, nombre_faces)
         VALUES ('DSP-T-1', ?, ?, 8, 1)`,
      )
      .run(assujettiId, typeId).lastInsertRowid,
  );

  const declarationId = Number(
    db
      .prepare(
        `INSERT INTO declarations (numero, assujetti_id, annee, statut)
         VALUES ('DEC-T-1', ?, 2026, 'brouillon')`,
      )
      .run(assujettiId).lastInsertRowid,
  );

  const contentieuxId = Number(
    db
      .prepare(
        `INSERT INTO contentieux (numero, assujetti_id, type, description)
         VALUES ('CTX-T-1', ?, 'gracieux', 'test')`,
      )
      .run(assujettiId).lastInsertRowid,
  );

  const userContribId = Number(
    db
      .prepare(
        `INSERT INTO users (email, password_hash, nom, prenom, role, assujetti_id)
         VALUES ('contrib-test@tlpe.local', ?, 'Contrib', 'Test', 'contribuable', ?)`,
      )
      .run(hashPassword('x'), assujettiId).lastInsertRowid,
  );

  const userOtherContribId = Number(
    db
      .prepare(
        `INSERT INTO users (email, password_hash, nom, prenom, role, assujetti_id)
         VALUES ('other-test@tlpe.local', ?, 'Other', 'User', 'contribuable', NULL)`,
      )
      .run(hashPassword('x')).lastInsertRowid,
  );

  const userGestionnaireId = Number(
    db
      .prepare(
        `INSERT INTO users (email, password_hash, nom, prenom, role)
         VALUES ('gest-test@tlpe.local', ?, 'Gest', 'User', 'gestionnaire')`,
      )
      .run(hashPassword('x')).lastInsertRowid,
  );

  return {
    assujettiId,
    dispositifId,
    declarationId,
    contentieuxId,
    userContribId,
    userOtherContribId,
    userGestionnaireId,
  };
}

test('pieces_jointes schema supports deleted_at and indexes', () => {
  initSchema();
  const cols = db.prepare("PRAGMA table_info('pieces_jointes')").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));

  assert.ok(colNames.has('id'));
  assert.ok(colNames.has('entite'));
  assert.ok(colNames.has('entite_id'));
  assert.ok(colNames.has('nom'));
  assert.ok(colNames.has('mime_type'));
  assert.ok(colNames.has('taille'));
  assert.ok(colNames.has('chemin'));
  assert.ok(colNames.has('uploaded_by'));
  assert.ok(colNames.has('created_at'));
  assert.ok(colNames.has('deleted_at'));

  const indexes = db.prepare("PRAGMA index_list('pieces_jointes')").all() as Array<{ name: string }>;
  const names = new Set(indexes.map((i) => i.name));
  assert.ok(names.has('idx_pieces_jointes_entite'));
  assert.ok(names.has('idx_pieces_jointes_uploaded_by'));
});

test('fixtures for attachment-linked entities are valid', () => {
  const fx = seedFixture();

  const dispositif = db.prepare('SELECT id, assujetti_id FROM dispositifs WHERE id = ?').get(fx.dispositifId) as
    | { id: number; assujetti_id: number }
    | undefined;
  assert.ok(dispositif);
  assert.equal(dispositif?.assujetti_id, fx.assujettiId);

  const declaration = db.prepare('SELECT id, assujetti_id FROM declarations WHERE id = ?').get(fx.declarationId) as
    | { id: number; assujetti_id: number }
    | undefined;
  assert.ok(declaration);
  assert.equal(declaration?.assujetti_id, fx.assujettiId);

  const contentieux = db.prepare('SELECT id, assujetti_id FROM contentieux WHERE id = ?').get(fx.contentieuxId) as
    | { id: number; assujetti_id: number }
    | undefined;
  assert.ok(contentieux);
  assert.equal(contentieux?.assujetti_id, fx.assujettiId);
});

test('size budget 50 Mo per entity can be checked from persisted rows', () => {
  const fx = seedFixture();

  db.prepare(
    `INSERT INTO pieces_jointes (entite, entite_id, nom, mime_type, taille, chemin, uploaded_by)
     VALUES ('dispositif', ?, 'a.pdf', 'application/pdf', ?, 'dispositif/test/a.pdf', ?)`,
  ).run(fx.dispositifId, 30 * 1024 * 1024, fx.userGestionnaireId);

  db.prepare(
    `INSERT INTO pieces_jointes (entite, entite_id, nom, mime_type, taille, chemin, uploaded_by)
     VALUES ('dispositif', ?, 'b.pdf', 'application/pdf', ?, 'dispositif/test/b.pdf', ?)`,
  ).run(fx.dispositifId, 15 * 1024 * 1024, fx.userGestionnaireId);

  const total = (
    db
      .prepare(
        `SELECT COALESCE(SUM(taille), 0) AS total
         FROM pieces_jointes
         WHERE entite = 'dispositif' AND entite_id = ? AND deleted_at IS NULL`,
      )
      .get(fx.dispositifId) as { total: number }
  ).total;

  assert.equal(total, 45 * 1024 * 1024);
  assert.ok(total + 6 * 1024 * 1024 > 50 * 1024 * 1024);
});

test('soft delete sets deleted_at and excludes row from active totals', () => {
  const fx = seedFixture();

  const created = db
    .prepare(
      `INSERT INTO pieces_jointes (entite, entite_id, nom, mime_type, taille, chemin, uploaded_by)
       VALUES ('declaration', ?, 'piece.pdf', 'application/pdf', 1024, 'declaration/test/piece.pdf', ?)`,
    )
    .run(fx.declarationId, fx.userContribId);

  const pieceId = Number(created.lastInsertRowid);

  db.prepare(`UPDATE pieces_jointes SET deleted_at = datetime('now') WHERE id = ?`).run(pieceId);

  const row = db.prepare('SELECT deleted_at FROM pieces_jointes WHERE id = ?').get(pieceId) as { deleted_at: string | null };
  assert.ok(row.deleted_at);

  const total = (
    db
      .prepare(
        `SELECT COALESCE(SUM(taille), 0) AS total
         FROM pieces_jointes
         WHERE entite = 'declaration' AND entite_id = ? AND deleted_at IS NULL`,
      )
      .get(fx.declarationId) as { total: number }
  ).total;

  assert.equal(total, 0);
});

test('storage path policy keeps files under server/data/uploads', () => {
  const relPath = path.posix.join('dispositif', '42', '2026', '04', 'x.pdf');
  const abs = path.join(uploadsRoot, relPath);

  assert.ok(abs.startsWith(uploadsRoot));

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from('test'));
  assert.ok(fs.existsSync(abs));

  fs.unlinkSync(abs);
  assert.ok(!fs.existsSync(abs));
});

test('detectMimeFromMagicBytes - detects allowed formats and rejects unknown payloads', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const pdf = Buffer.from('%PDF-1.7\n', 'utf8');
  const txt = Buffer.from('hello world', 'utf8');

  assert.equal(detectMimeFromMagicBytes(jpeg), 'image/jpeg');
  assert.equal(detectMimeFromMagicBytes(png), 'image/png');
  assert.equal(detectMimeFromMagicBytes(pdf), 'application/pdf');
  assert.equal(detectMimeFromMagicBytes(txt), null);
});
