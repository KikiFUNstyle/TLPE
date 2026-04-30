import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
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
