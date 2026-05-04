import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomUUID } from 'node:crypto';
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
import { generateSync } from 'otplib';
import { authRouter } from './routes/auth';

initSchema();

function seedUser(email: string, password: string, role: string, actif = 1) {
  const hash = hashPassword(password);
  db.prepare(
    `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
     VALUES (?, ?, 'Test', 'User', ?, ?)`,
  ).run(email, hash, role, actif);
}

function uniqueEmail(prefix: string) {
  return `${prefix}-${randomUUID()}@tlpe.local`;
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
  const email = uniqueEmail('admin');
  seedUser(email, 'secret', 'admin');

  const found = loadUserByEmail(email.toLowerCase());
  assert.ok(found, 'Doit trouver l\'utilisateur');
  assert.equal(found!.role, 'admin');

  const upperFound = loadUserByEmail(email.toUpperCase());
  assert.ok(upperFound, 'Doit trouver par email en majuscules');
  assert.equal(upperFound!.email, email);
});

test('loadUserByEmail retourne undefined si email inconnu', () => {
  const notFound = loadUserByEmail('inconnu@tlpe.local');
  assert.equal(notFound, undefined);
});

test('loadUserByEmail expose le champ actif pour filtrage applicatif', () => {
  const email = uniqueEmail('inactif');
  seedUser(email, 'pwd', 'contribuable', 0);

  const user = loadUserByEmail(email);
  assert.ok(user, 'Doit retourner l\'enregistrement meme si inactif');
  assert.equal(user!.actif, 0);
});

// ─── flux 2FA / TOTP ──────────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

async function request(params: {
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}) {
  const app = createApp();
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Impossible de determiner le port de test');
  }

  try {
    const res = await fetch(`http://127.0.0.1:${address.port}${params.path}`, {
      method: params.method,
      headers: {
        ...(params.body ? { 'Content-Type': 'application/json' } : {}),
        ...(params.headers || {}),
      },
      body: params.body ? JSON.stringify(params.body) : undefined,
    });

    const contentType = res.headers.get('content-type') || '';
    return {
      status: res.status,
      body: contentType.includes('application/json') ? await res.json() : await res.text(),
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('POST /api/auth/login active une session partielle quand le contribuable a la 2FA activée', async () => {
  const email = uniqueEmail('totp-login');
  seedUser(email, 'totp123', 'contribuable');
  const user = loadUserByEmail(email);
  assert.ok(user);

  const authUser: AuthUser = {
    id: user.id,
    email: user.email,
    role: user.role,
    nom: user.nom,
    prenom: user.prenom,
    assujetti_id: user.assujetti_id,
  };

  const setupResponse = await request({
    method: 'POST',
    path: '/api/auth/2fa/setup',
    headers: { Authorization: `Bearer ${signToken(authUser)}` },
  });
  const secret = (setupResponse.body as { secret: string }).secret;

  const enableResponse = await request({
    method: 'POST',
    path: '/api/auth/2fa/enable',
    headers: { Authorization: `Bearer ${signToken(authUser)}` },
    body: { code: generateSync({ secret, algorithm: 'sha1', digits: 6, period: 30 }) },
  });
  assert.equal(enableResponse.status, 200);

  const response = await request({
    method: 'POST',
    path: '/api/auth/login',
    body: { email, password: 'totp123' },
  });

  assert.equal(response.status, 200);
  const body = response.body as { requires_two_factor: boolean; challenge_token: string; user: { email: string } };
  assert.equal(body.requires_two_factor, true);
  assert.equal(typeof body.challenge_token, 'string');
  assert.equal(body.user.email, email);
});

test('flux 2FA: setup + activation + vérification TOTP + désactivation avec code', async () => {
  const email = uniqueEmail('totp-flow');
  seedUser(email, 'totp-flow', 'contribuable');
  const user = loadUserByEmail(email);
  assert.ok(user);

  const authUser: AuthUser = {
    id: user.id,
    email: user.email,
    role: user.role,
    nom: user.nom,
    prenom: user.prenom,
    assujetti_id: user.assujetti_id,
  };

  const setupResponse = await request({
    method: 'POST',
    path: '/api/auth/2fa/setup',
    headers: { Authorization: `Bearer ${signToken(authUser)}` },
  });

  assert.equal(setupResponse.status, 200);
  assert.equal(typeof (setupResponse.body as { secret: string }).secret, 'string');

  const secret = (setupResponse.body as { secret: string }).secret;
  const activationCode = generateSync({ secret, algorithm: 'sha1', digits: 6, period: 30 });

  const enableResponse = await request({
    method: 'POST',
    path: '/api/auth/2fa/enable',
    headers: { Authorization: `Bearer ${signToken(authUser)}` },
    body: { code: activationCode },
  });

  assert.equal(enableResponse.status, 200);
  const enableBody = enableResponse.body as { enabled: boolean; recovery_codes: string[] };
  assert.equal(enableBody.enabled, true);
  assert.equal(enableBody.recovery_codes.length, 10);

  const loginResponse = await request({
    method: 'POST',
    path: '/api/auth/login',
    body: { email, password: 'totp-flow' },
  });

  assert.equal(loginResponse.status, 200);
  const loginBody = loginResponse.body as { requires_two_factor: boolean; challenge_token: string };
  assert.equal(loginBody.requires_two_factor, true);
  assert.equal(typeof loginBody.challenge_token, 'string');

  const verifyResponse = await request({
    method: 'POST',
    path: '/api/auth/login/verify-2fa',
    body: {
      challenge_token: loginBody.challenge_token,
      code: generateSync({ secret, algorithm: 'sha1', digits: 6, period: 30 }),
    },
  });

  assert.equal(verifyResponse.status, 200);
  const verifyBody = verifyResponse.body as { token: string; recovery_code_used: boolean };
  assert.equal(typeof verifyBody.token, 'string');
  assert.equal(verifyBody.recovery_code_used, false);

  const disableResponse = await request({
    method: 'POST',
    path: '/api/auth/2fa/disable',
    headers: { Authorization: `Bearer ${verifyBody.token}` },
    body: { code: generateSync({ secret, algorithm: 'sha1', digits: 6, period: 30 }) },
  });

  assert.equal(disableResponse.status, 200);
  assert.deepEqual(disableResponse.body, { enabled: false });
});

test('les codes de récupération 2FA sont à usage unique', async () => {
  const email = uniqueEmail('totp-recovery');
  seedUser(email, 'totp-recovery', 'contribuable');
  const user = loadUserByEmail(email);
  assert.ok(user);

  const authUser: AuthUser = {
    id: user.id,
    email: user.email,
    role: user.role,
    nom: user.nom,
    prenom: user.prenom,
    assujetti_id: user.assujetti_id,
  };

  const setupResponse = await request({
    method: 'POST',
    path: '/api/auth/2fa/setup',
    headers: { Authorization: `Bearer ${signToken(authUser)}` },
  });
  const secret = (setupResponse.body as { secret: string }).secret;

  const enableResponse = await request({
    method: 'POST',
    path: '/api/auth/2fa/enable',
    headers: { Authorization: `Bearer ${signToken(authUser)}` },
    body: { code: generateSync({ secret, algorithm: 'sha1', digits: 6, period: 30 }) },
  });
  const recoveryCode = (enableResponse.body as { recovery_codes: string[] }).recovery_codes[0];

  const loginResponse = await request({
    method: 'POST',
    path: '/api/auth/login',
    body: { email, password: 'totp-recovery' },
  });
  const challengeToken = (loginResponse.body as { challenge_token: string }).challenge_token;

  const firstUse = await request({
    method: 'POST',
    path: '/api/auth/login/verify-2fa',
    body: { challenge_token: challengeToken, recovery_code: recoveryCode },
  });
  assert.equal(firstUse.status, 200);
  assert.equal((firstUse.body as { recovery_code_used: boolean }).recovery_code_used, true);

  const secondLogin = await request({
    method: 'POST',
    path: '/api/auth/login',
    body: { email, password: 'totp-recovery' },
  });
  const secondChallengeToken = (secondLogin.body as { challenge_token: string }).challenge_token;

  const secondUse = await request({
    method: 'POST',
    path: '/api/auth/login/verify-2fa',
    body: { challenge_token: secondChallengeToken, recovery_code: recoveryCode },
  });
  assert.equal(secondUse.status, 401);
});
