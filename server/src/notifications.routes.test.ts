import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';

import type { AuthUser } from './auth';

type NotificationsRoutesTestContext = {
  db: typeof import('./db').db;
  initSchema: typeof import('./db').initSchema;
  hashPassword: typeof import('./auth').hashPassword;
  signToken: typeof import('./auth').signToken;
  notificationsRouter: typeof import('./routes/notifications').notificationsRouter;
  cleanup: () => void;
};

const TEST_MODULES = ['./db', './auth', './routes/notifications'] as const;

function clearModuleCache() {
  for (const modulePath of TEST_MODULES) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // ignore cache misses during cleanup
    }
  }
}

function createContext(): NotificationsRoutesTestContext {
  const tempDir = path.join(
    os.tmpdir(),
    `tlpe-notifications-routes-test-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  fs.mkdirSync(tempDir, { recursive: true });
  const dbPath = path.join(tempDir, 'tlpe.db');
  const previousDbPath = process.env.TLPE_DB_PATH;
  process.env.TLPE_DB_PATH = dbPath;
  clearModuleCache();

  const dbModule = require('./db') as typeof import('./db');
  const authModule = require('./auth') as typeof import('./auth');
  const notificationsRouteModule = require('./routes/notifications') as typeof import('./routes/notifications');

  return {
    db: dbModule.db,
    initSchema: dbModule.initSchema,
    hashPassword: authModule.hashPassword,
    signToken: authModule.signToken,
    notificationsRouter: notificationsRouteModule.notificationsRouter,
    cleanup: () => {
      try {
        dbModule.db.close();
      } catch {
        // ignore close errors
      }
      clearModuleCache();
      if (previousDbPath === undefined) {
        delete process.env.TLPE_DB_PATH;
      } else {
        process.env.TLPE_DB_PATH = previousDbPath;
      }
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    },
  };
}

let ctx: NotificationsRoutesTestContext;
let app: express.Express;
let adminUser: AuthUser;
let gestionnaireUser: AuthUser;

beforeEach(() => {
  ctx = createContext();
  ctx.initSchema();

  app = express();
  app.use(express.json());
  app.use('/api/notifications', ctx.notificationsRouter);

  ctx.db.pragma('foreign_keys = OFF');

  const adminId = Number(
    ctx.db.prepare(`INSERT INTO users (email, password_hash, nom, prenom, role, actif)
      VALUES ('admin@test.fr', ?, 'Admin', 'Test', 'admin', 1)`).run(ctx.hashPassword('password123')).lastInsertRowid,
  );
  adminUser = {
    id: adminId,
    email: 'admin@test.fr',
    role: 'admin',
    nom: 'Admin',
    prenom: 'Test',
    assujetti_id: null,
  };

  const gestId = Number(
    ctx.db.prepare(`INSERT INTO users (email, password_hash, nom, prenom, role, actif)
      VALUES ('gest@test.fr', ?, 'Gest', 'Test', 'gestionnaire', 1)`).run(ctx.hashPassword('password123')).lastInsertRowid,
  );
  gestionnaireUser = {
    id: gestId,
    email: 'gest@test.fr',
    role: 'gestionnaire',
    nom: 'Gest',
    prenom: 'Test',
    assujetti_id: null,
  };

  ctx.db.prepare(`INSERT INTO assujettis (siret, raison_sociale, identifiant_tlpe, adresse_rue, adresse_cp, adresse_ville, statut)
    VALUES ('12345678901234', 'Test Entreprise', 'TLPE-TEST-001', '1 rue Test', '75001', 'Paris', 'actif')`).run();

  ctx.db.prepare(`
    INSERT INTO notifications_email (assujetti_id, email_destinataire, objet, corps, template_code, statut, created_at)
    VALUES (1, 'test@example.com', 'Invitation à déclarer', '<p>Bonjour</p>', 'invitation_campagne', 'envoye', '2026-06-01T10:00:00')
  `).run();

  ctx.db.prepare(`
    INSERT INTO notifications_email (assujetti_id, email_destinataire, objet, corps, template_code, statut, erreur, created_at)
    VALUES (1, 'fail@example.com', 'Relance J-30', '<p>Relance</p>', 'relance_J-30', 'echec', 'SMTP connection refused', '2026-06-15T14:30:00')
  `).run();

  ctx.db.prepare(`
    INSERT INTO notifications_email (assujetti_id, email_destinataire, objet, corps, template_code, statut, created_at)
    VALUES (1, 'pending@example.com', 'Notification en attente', '<p>Pending</p>', 'titre_emis', 'pending', '2026-06-20T08:00:00')
  `).run();

  ctx.db.pragma('foreign_keys = ON');
});

afterEach(() => {
  ctx.cleanup();
});

function authHeader(user: AuthUser): Record<string, string> {
  return { Authorization: `Bearer ${ctx.signToken(user)}` };
}

test('GET /api/notifications - returns paginated list for admin', async () => {
  const res = await request(app)
    .get('/api/notifications')
    .set(authHeader(adminUser))
    .expect(200);

  assert.equal(res.body.page, 1);
  assert.equal(res.body.page_size, 25);
  assert.equal(res.body.total, 3);
  assert.ok(Array.isArray(res.body.rows));
  assert.equal(res.body.rows.length, 3);
  assert.ok(res.body.options.statuses);
  assert.ok(res.body.options.templates);
});

test('GET /api/notifications - returns paginated list for gestionnaire', async () => {
  const res = await request(app)
    .get('/api/notifications')
    .set(authHeader(gestionnaireUser))
    .expect(200);

  assert.equal(res.body.total, 3);
});

test('GET /api/notifications - rejects non-admin/non-gestionnaire', async () => {
  const contribId = Number(
    ctx.db.prepare(`INSERT INTO users (email, password_hash, nom, prenom, role, actif)
      VALUES ('user@test.fr', ?, 'User', 'Test', 'contribuable', 1)`).run(ctx.hashPassword('password123')).lastInsertRowid,
  );
  const userToken = ctx.signToken({
    id: contribId,
    email: 'user@test.fr',
    role: 'contribuable',
    nom: 'User',
    prenom: 'Test',
    assujetti_id: null,
  });

  await request(app)
    .get('/api/notifications')
    .set('Authorization', `Bearer ${userToken}`)
    .expect(403);
});

test('GET /api/notifications - rejects unauthenticated', async () => {
  await request(app)
    .get('/api/notifications')
    .expect(401);
});

test('GET /api/notifications - filters by statut', async () => {
  const res = await request(app)
    .get('/api/notifications?statut=echec')
    .set(authHeader(adminUser))
    .expect(200);

  assert.equal(res.body.total, 1);
  assert.equal(res.body.rows[0].statut, 'echec');
});

test('GET /api/notifications - filters by email_destinataire', async () => {
  const res = await request(app)
    .get('/api/notifications?email_destinataire=test@example.com')
    .set(authHeader(adminUser))
    .expect(200);

  assert.equal(res.body.total, 1);
  assert.ok(res.body.rows[0].email_destinataire.toLowerCase().includes('test@example.com'));
});

test('GET /api/notifications - filters by date range', async () => {
  const res = await request(app)
    .get('/api/notifications?date_debut=2026-06-10&date_fin=2026-06-20')
    .set(authHeader(adminUser))
    .expect(200);

  assert.equal(res.body.total, 2);
});

test('GET /api/notifications - paginates', async () => {
  const res = await request(app)
    .get('/api/notifications?page=1&page_size=2')
    .set(authHeader(adminUser))
    .expect(200);

  assert.equal(res.body.rows.length, 2);
  assert.equal(res.body.total, 3);
  assert.equal(res.body.total_pages, 2);
});

test('GET /api/notifications?format=csv - exports CSV', async () => {
  const res = await request(app)
    .get('/api/notifications?format=csv')
    .set(authHeader(adminUser))
    .expect(200)
    .expect('Content-Type', /text\/csv/);

  assert.ok(res.text.includes('Destinataire'));
  assert.ok(res.text.includes('test@example.com'));
  assert.ok(res.text.includes('Envoyé'));
  assert.ok(res.text.includes('Échec'));
});

test('POST /api/notifications/:id/resend - resends a failed notification', async () => {
  const res = await request(app)
    .post('/api/notifications/2/resend')
    .set(authHeader(adminUser))
    .expect(200);

  assert.equal(res.body.success, true);

  const notification = ctx.db.prepare('SELECT statut, tentatives, erreur FROM notifications_email WHERE id = 2').get() as {
    statut: string;
    tentatives: number;
    erreur: string | null;
  };
  assert.equal(notification.statut, 'pending');
  assert.equal(notification.tentatives, 0);
  assert.equal(notification.erreur, null);
});

test('POST /api/notifications/:id/resend - rejects resend of non-failed notification', async () => {
  await request(app)
    .post('/api/notifications/1/resend')
    .set(authHeader(adminUser))
    .expect(400);
});

test('POST /api/notifications/:id/resend - rejects resend of unknown notification', async () => {
  await request(app)
    .post('/api/notifications/999/resend')
    .set(authHeader(adminUser))
    .expect(404);
});

test('POST /api/notifications/:id/resend - rejects invalid id', async () => {
  await request(app)
    .post('/api/notifications/abc/resend')
    .set(authHeader(adminUser))
    .expect(400);
});
