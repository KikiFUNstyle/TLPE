import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { generateSync } from 'otplib';
import { authRouter } from './routes/auth';
import { db, initSchema } from './db';
import { hashPassword, signToken, type AuthUser } from './auth';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@tlpe.local`;
}

function resetAuthFixtures() {
  initSchema();
  db.exec('DELETE FROM codes_recuperation');
  db.exec('DELETE FROM audit_log');
  db.exec('DELETE FROM users');
}

function seedUser(email: string, role: AuthUser['role'] = 'contribuable') {
  const result = db.prepare(
    `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
     VALUES (?, ?, 'Test', 'User', ?, 1)`,
  ).run(email, hashPassword('secret123'), role);

  const id = Number(result.lastInsertRowid);
  return {
    id,
    email,
    role,
    nom: 'Test',
    prenom: 'User',
    assujetti_id: null,
  } satisfies AuthUser;
}

test('GET /api/auth/me retourne 401 sans bearer token', async () => {
  resetAuthFixtures();
  const app = createApp();

  const response = await request(app).get('/api/auth/me');

  assert.equal(response.status, 401);
  assert.match(String(response.body.error), /Authentification requise/i);
});

test('GET /api/auth/me retourne l’utilisateur courant avec un token valide', async () => {
  resetAuthFixtures();
  const app = createApp();
  const user = seedUser(uniqueEmail('me-valid'));

  const response = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${signToken(user)}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.user.email, user.email);
  assert.equal(response.body.user.id, user.id);
});

test('GET /api/auth/2fa/status retourne disabled et 0 code de récupération par défaut', async () => {
  resetAuthFixtures();
  const app = createApp();
  const user = seedUser(uniqueEmail('status-disabled'));

  const response = await request(app)
    .get('/api/auth/2fa/status')
    .set('Authorization', `Bearer ${signToken(user)}`);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    enabled: false,
    recovery_codes_remaining: 0,
  });
});

test('POST /api/auth/login/verify-2fa valide qu’un seul mode de code est fourni', async () => {
  resetAuthFixtures();
  const app = createApp();

  const missingCodes = await request(app).post('/api/auth/login/verify-2fa').send({
    challenge_token: 'challenge-inexistant',
  });
  assert.equal(missingCodes.status, 400);
  assert.match(JSON.stringify(missingCodes.body), /code TOTP ou un code de récupération est requis/i);

  const bothCodes = await request(app).post('/api/auth/login/verify-2fa').send({
    challenge_token: 'challenge-inexistant',
    code: '123456',
    recovery_code: 'ABCD-EFGH-IJKL',
  });
  assert.equal(bothCodes.status, 400);
  assert.match(JSON.stringify(bothCodes.body), /Utiliser soit un code TOTP, soit un code de récupération/i);
});

test('POST /api/auth/login/verify-2fa retourne 401 sur challenge invalide ou expiré', async () => {
  resetAuthFixtures();
  const app = createApp();

  const response = await request(app).post('/api/auth/login/verify-2fa').send({
    challenge_token: 'challenge-invalide',
    code: '123456',
  });

  assert.equal(response.status, 401);
  assert.match(String(response.body.error), /Challenge 2FA invalide ou expiré/i);
});

test('POST /api/auth/login rejette les payloads invalides, les utilisateurs inactifs et les mauvais mots de passe', async () => {
  resetAuthFixtures();
  const app = createApp();

  const invalidPayload = await request(app).post('/api/auth/login').send({ email: 'pas-un-email' });
  assert.equal(invalidPayload.status, 400);

  const inactiveEmail = uniqueEmail('inactive-login');
  db.prepare(
    `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
     VALUES (?, ?, 'Inactive', 'User', 'contribuable', 0)`,
  ).run(inactiveEmail, hashPassword('secret123'));

  const inactiveUser = await request(app).post('/api/auth/login').send({
    email: inactiveEmail,
    password: 'secret123',
  });
  assert.equal(inactiveUser.status, 401);

  const activeUser = seedUser(uniqueEmail('wrong-password'));
  const wrongPassword = await request(app).post('/api/auth/login').send({
    email: activeUser.email,
    password: 'bad-secret',
  });
  assert.equal(wrongPassword.status, 401);
  assert.match(String(wrongPassword.body.error), /Identifiants incorrects/i);
});

test('POST /api/auth/login retourne un token complet quand la 2FA est désactivée', async () => {
  resetAuthFixtures();
  const app = createApp();
  const user = seedUser(uniqueEmail('login-ok'));

  const response = await request(app).post('/api/auth/login').send({
    email: user.email,
    password: 'secret123',
  });

  assert.equal(response.status, 200);
  assert.equal(typeof response.body.token, 'string');
  assert.equal(response.body.user.email, user.email);
  assert.equal(response.body.user.id, user.id);
});

test('POST /api/auth/login/verify-2fa retourne 401 quand la session 2FA n’est plus valide ou que le code TOTP est faux', async () => {
  resetAuthFixtures();
  const app = createApp();
  const user = seedUser(uniqueEmail('verify-2fa'));

  const setupResponse = await request(app)
    .post('/api/auth/2fa/setup')
    .set('Authorization', `Bearer ${signToken(user)}`);
  assert.equal(setupResponse.status, 200);
  const secret = String(setupResponse.body.secret);

  const enableResponse = await request(app)
    .post('/api/auth/2fa/enable')
    .set('Authorization', `Bearer ${signToken(user)}`)
    .send({ code: generateSync({ secret, algorithm: 'sha1', digits: 6, period: 30 }) });
  assert.equal(enableResponse.status, 200);

  const loginResponse = await request(app).post('/api/auth/login').send({
    email: user.email,
    password: 'secret123',
  });
  assert.equal(loginResponse.status, 200);
  assert.equal(loginResponse.body.requires_two_factor, true);

  const wrongCode = await request(app).post('/api/auth/login/verify-2fa').send({
    challenge_token: loginResponse.body.challenge_token,
    code: '000000',
  });
  assert.equal(wrongCode.status, 401);
  assert.match(String(wrongCode.body.error), /Code 2FA invalide/i);

  db.prepare('UPDATE users SET actif = 0 WHERE id = ?').run(user.id);
  const invalidatedSession = await request(app).post('/api/auth/login/verify-2fa').send({
    challenge_token: loginResponse.body.challenge_token,
    code: generateSync({ secret, algorithm: 'sha1', digits: 6, period: 30 }),
  });
  assert.equal(invalidatedSession.status, 401);
  assert.match(String(invalidatedSession.body.error), /Session 2FA invalide/i);
});

test('POST /api/auth/2fa/setup retourne 404 si l’utilisateur authentifié n’existe plus', async () => {
  resetAuthFixtures();
  const app = createApp();
  const user = seedUser(uniqueEmail('setup-missing'));
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

  const response = await request(app)
    .post('/api/auth/2fa/setup')
    .set('Authorization', `Bearer ${signToken(user)}`);

  assert.equal(response.status, 404);
  assert.match(String(response.body.error), /Utilisateur introuvable/i);
});

test('POST /api/auth/2fa/enable et /disable valident le body et refusent les mauvais codes', async () => {
  resetAuthFixtures();
  const app = createApp();
  const user = seedUser(uniqueEmail('enable-disable'));

  const invalidEnablePayload = await request(app)
    .post('/api/auth/2fa/enable')
    .set('Authorization', `Bearer ${signToken(user)}`)
    .send({});
  assert.equal(invalidEnablePayload.status, 400);

  const setupResponse = await request(app)
    .post('/api/auth/2fa/setup')
    .set('Authorization', `Bearer ${signToken(user)}`);
  const secret = String(setupResponse.body.secret);

  const invalidEnableCode = await request(app)
    .post('/api/auth/2fa/enable')
    .set('Authorization', `Bearer ${signToken(user)}`)
    .send({ code: '111111' });
  assert.equal(invalidEnableCode.status, 400);

  const enableResponse = await request(app)
    .post('/api/auth/2fa/enable')
    .set('Authorization', `Bearer ${signToken(user)}`)
    .send({ code: generateSync({ secret, algorithm: 'sha1', digits: 6, period: 30 }) });
  assert.equal(enableResponse.status, 200);

  const invalidDisablePayload = await request(app)
    .post('/api/auth/2fa/disable')
    .set('Authorization', `Bearer ${signToken(user)}`)
    .send({});
  assert.equal(invalidDisablePayload.status, 400);

  const invalidDisableCode = await request(app)
    .post('/api/auth/2fa/disable')
    .set('Authorization', `Bearer ${signToken(user)}`)
    .send({ code: '111111' });
  assert.equal(invalidDisableCode.status, 400);
});

test('GET /api/auth/2fa/status retourne disabled quand l’utilisateur authentifié a été supprimé', async () => {
  resetAuthFixtures();
  const app = createApp();
  const user = seedUser(uniqueEmail('status-deleted'));
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

  const response = await request(app)
    .get('/api/auth/2fa/status')
    .set('Authorization', `Bearer ${signToken(user)}`);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    enabled: false,
    recovery_codes_remaining: 0,
  });
});
