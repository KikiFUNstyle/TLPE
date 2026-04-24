import test from 'node:test';
import assert from 'node:assert/strict';
import { db, initSchema } from './db';
import {
  authMiddleware,
  hashPassword,
  loadUserByEmail,
  requireRole,
  signToken,
  verifyPassword,
  type AuthUser,
} from './auth';

function resetUsers() {
  initSchema();
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('DELETE FROM notifications_email');
    db.exec('DELETE FROM invitation_magic_links');
    db.exec('DELETE FROM campagne_jobs');
    db.exec('DELETE FROM mises_en_demeure');
    db.exec('DELETE FROM declarations');
    db.exec('DELETE FROM campagnes');
    db.exec('DELETE FROM audit_log');
    db.exec('DELETE FROM users');
    db.exec('DELETE FROM assujettis');
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function seedUser(email: string, password: string, role: string, actif = 1) {
  const hash = hashPassword(password);
  db.prepare(
    `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
     VALUES (?, ?, 'Test', 'User', ?, ?)`,
  ).run(email, hash, role, actif);
}

// Minimal Express mock objects
function makeRes() {
  const res: { statusCode: number; _json: unknown; status: (c: number) => typeof res; json: (b: unknown) => typeof res } = {
    statusCode: 200,
    _json: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this._json = body; return this; },
  };
  return res;
}

// ─── hashPassword / verifyPassword ───────────────────────────────────────────

test('hashPassword genere un hash bcrypt verifiable', () => {
  const hash = hashPassword('motdepasse123');
  assert.ok(hash.startsWith('$2'), 'Le hash doit etre un hash bcrypt');
  assert.equal(verifyPassword('motdepasse123', hash), true);
  assert.equal(verifyPassword('mauvais_mdp', hash), false);
});

test('verifyPassword est sensible a la casse', () => {
  const hash = hashPassword('Secret');
  assert.equal(verifyPassword('secret', hash), false);
  assert.equal(verifyPassword('SECRET', hash), false);
  assert.equal(verifyPassword('Secret', hash), true);
});

// ─── signToken / authMiddleware ───────────────────────────────────────────────

const sampleUser: AuthUser = {
  id: 42,
  email: 'auth-test@tlpe.local',
  role: 'gestionnaire',
  nom: 'Dupont',
  prenom: 'Jean',
  assujetti_id: null,
};

test('signToken genere un JWT et authMiddleware accepte le token valide', () => {
  const token = signToken(sampleUser);
  assert.ok(typeof token === 'string');
  assert.ok(token.split('.').length === 3, 'Un JWT a trois parties');

  const req: { headers: Record<string, string>; user?: AuthUser } = {
    headers: { authorization: `Bearer ${token}` },
  };
  const res = makeRes();
  let nextCalled = false;
  authMiddleware(req as never, res as never, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.ok(req.user);
  assert.equal(req.user!.email, sampleUser.email);
  assert.equal(req.user!.role, sampleUser.role);
  assert.equal(req.user!.id, sampleUser.id);
  assert.equal(req.user!.assujetti_id, null);
});

test('authMiddleware rejette une requete sans en-tete Authorization', () => {
  const req: { headers: Record<string, string> } = { headers: {} };
  const res = makeRes();
  let nextCalled = false;
  authMiddleware(req as never, res as never, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.ok((res._json as { error: string }).error.includes('Authentification'));
});

test('authMiddleware rejette Authorization sans prefix Bearer', () => {
  const req: { headers: Record<string, string> } = {
    headers: { authorization: 'Basic dXNlcjpwYXNz' },
  };
  const res = makeRes();
  let nextCalled = false;
  authMiddleware(req as never, res as never, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('authMiddleware rejette un token malformé/expire', () => {
  const req: { headers: Record<string, string> } = {
    headers: { authorization: 'Bearer entete.payload.signature_invalide' },
  };
  const res = makeRes();
  let nextCalled = false;
  authMiddleware(req as never, res as never, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.ok((res._json as { error: string }).error.includes('invalide'));
});

test('authMiddleware preserve assujetti_id dans le payload utilisateur', () => {
  const contribuable: AuthUser = {
    id: 99,
    email: 'contri@tlpe.local',
    role: 'contribuable',
    nom: 'Martin',
    prenom: 'Alice',
    assujetti_id: 7,
  };
  const token = signToken(contribuable);
  const req: { headers: Record<string, string>; user?: AuthUser } = {
    headers: { authorization: `Bearer ${token}` },
  };
  const res = makeRes();
  authMiddleware(req as never, res as never, () => {});
  assert.equal(req.user!.assujetti_id, 7);
  assert.equal(req.user!.role, 'contribuable');
});

// ─── requireRole ─────────────────────────────────────────────────────────────

test('requireRole autorise le role exact', () => {
  const req: { user: AuthUser } = { user: { ...sampleUser, role: 'admin' } };
  const res = makeRes();
  let nextCalled = false;
  requireRole('admin')(req as never, res as never, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('requireRole autorise si le role est dans la liste', () => {
  const req: { user: AuthUser } = { user: { ...sampleUser, role: 'financier' } };
  const res = makeRes();
  let nextCalled = false;
  requireRole('admin', 'gestionnaire', 'financier')(req as never, res as never, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('requireRole rejette un role non liste', () => {
  const req: { user: AuthUser } = { user: { ...sampleUser, role: 'contribuable' } };
  const res = makeRes();
  let nextCalled = false;
  requireRole('admin', 'gestionnaire')(req as never, res as never, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.ok((res._json as { error: string }).error.includes('insuffisants'));
});

test('requireRole renvoie 401 si user absent de la requete', () => {
  const req: Record<string, unknown> = {};
  const res = makeRes();
  let nextCalled = false;
  requireRole('admin')(req as never, res as never, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

// ─── loadUserByEmail ──────────────────────────────────────────────────────────

test('loadUserByEmail retrouve un utilisateur (case-insensitive)', () => {
  resetUsers();
  seedUser('Admin@TLPE.local', 'secret', 'admin');

  const found = loadUserByEmail('admin@tlpe.local');
  assert.ok(found, 'Doit trouver l\'utilisateur');
  assert.equal(found!.role, 'admin');

  const upperFound = loadUserByEmail('ADMIN@TLPE.LOCAL');
  assert.ok(upperFound, 'Doit trouver par email en majuscules');
  assert.equal(upperFound!.email, 'Admin@TLPE.local');
});

test('loadUserByEmail retourne undefined si email inconnu', () => {
  const notFound = loadUserByEmail('inconnu@tlpe.local');
  assert.equal(notFound, undefined);
});

test('loadUserByEmail expose le champ actif pour filtrage applicatif', () => {
  resetUsers();
  seedUser('inactif@tlpe.local', 'pwd', 'contribuable', 0);

  const user = loadUserByEmail('inactif@tlpe.local');
  assert.ok(user, 'Doit retourner l\'enregistrement meme si inactif');
  assert.equal(user!.actif, 0);
});
