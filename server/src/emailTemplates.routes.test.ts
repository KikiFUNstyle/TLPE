import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';

import type { AuthUser } from './auth';

type EmailTemplatesRoutesTestContext = {
  db: typeof import('./db').db;
  initSchema: typeof import('./db').initSchema;
  hashPassword: typeof import('./auth').hashPassword;
  signToken: typeof import('./auth').signToken;
  emailTemplatesRouter: typeof import('./routes/emailTemplates').emailTemplatesRouter;
  cleanup: () => void;
};

const TEST_MODULES = ['./db', './auth', './emailTemplates', './routes/emailTemplates'] as const;

function clearModuleCache() {
  for (const modulePath of TEST_MODULES) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // ignore cache misses during cleanup
    }
  }
}

function createContext(): EmailTemplatesRoutesTestContext {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlpe-email-templates-routes-test-'));
  const dbPath = path.join(tempDir, 'tlpe.db');
  const previousDbPath = process.env.TLPE_DB_PATH;
  process.env.TLPE_DB_PATH = dbPath;
  clearModuleCache();

  const dbModule = require('./db') as typeof import('./db');
  const authModule = require('./auth') as typeof import('./auth');
  const emailTemplatesRouteModule = require('./routes/emailTemplates') as typeof import('./routes/emailTemplates');

  return {
    db: dbModule.db,
    initSchema: dbModule.initSchema,
    hashPassword: authModule.hashPassword,
    signToken: authModule.signToken,
    emailTemplatesRouter: emailTemplatesRouteModule.emailTemplatesRouter,
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
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function withContext(run: (ctx: EmailTemplatesRoutesTestContext) => Promise<void> | void) {
  const ctx = createContext();
  try {
    await run(ctx);
  } finally {
    ctx.cleanup();
  }
}

function createApp(ctx: EmailTemplatesRoutesTestContext) {
  const app = express();
  app.use(express.json());
  app.use('/api/email-templates', ctx.emailTemplatesRouter);
  return app;
}

function makeAuthHeader(ctx: EmailTemplatesRoutesTestContext, user: AuthUser): Record<string, string> {
  return { Authorization: `Bearer ${ctx.signToken(user)}` };
}

function resetFixtures(ctx: EmailTemplatesRoutesTestContext) {
  ctx.initSchema();
  ctx.db.pragma('foreign_keys = OFF');
  try {
    ctx.db.exec('DELETE FROM email_templates');
    ctx.db.exec('DELETE FROM notifications_email');
    ctx.db.exec('DELETE FROM invitation_magic_links');
    ctx.db.exec('DELETE FROM campagne_jobs');
    ctx.db.exec('DELETE FROM mises_en_demeure');
    ctx.db.exec('DELETE FROM contentieux_alerts');
    ctx.db.exec('DELETE FROM evenements_contentieux');
    ctx.db.exec('DELETE FROM contentieux');
    ctx.db.exec('DELETE FROM paiements');
    ctx.db.exec('DELETE FROM titres');
    ctx.db.exec('DELETE FROM pieces_jointes');
    ctx.db.exec('DELETE FROM lignes_declaration');
    ctx.db.exec('DELETE FROM declaration_receipts');
    ctx.db.exec('DELETE FROM declarations');
    ctx.db.exec('DELETE FROM controles');
    ctx.db.exec('DELETE FROM dispositifs');
    ctx.db.exec('DELETE FROM campagnes');
    ctx.db.exec('DELETE FROM audit_log');
    ctx.db.exec('DELETE FROM users');
    ctx.db.exec('DELETE FROM assujettis');
  } finally {
    ctx.db.pragma('foreign_keys = ON');
  }

  const adminId = Number(
    ctx.db
      .prepare(`INSERT INTO users (email, password_hash, nom, prenom, role, actif) VALUES ('admin-email-templates@tlpe.local', ?, 'Admin', 'Email', 'admin', 1)`)
      .run(ctx.hashPassword('secret')).lastInsertRowid,
  );
  const gestionnaireId = Number(
    ctx.db
      .prepare(`INSERT INTO users (email, password_hash, nom, prenom, role, actif) VALUES ('gestionnaire-email-templates@tlpe.local', ?, 'Gest', 'Email', 'gestionnaire', 1)`)
      .run(ctx.hashPassword('secret')).lastInsertRowid,
  );
  const financierId = Number(
    ctx.db
      .prepare(`INSERT INTO users (email, password_hash, nom, prenom, role, actif) VALUES ('financier-email-templates@tlpe.local', ?, 'Fin', 'Email', 'financier', 1)`)
      .run(ctx.hashPassword('secret')).lastInsertRowid,
  );

  return {
    admin: {
      id: adminId,
      email: 'admin-email-templates@tlpe.local',
      nom: 'Admin',
      prenom: 'Email',
      role: 'admin' as const,
      assujetti_id: null,
    },
    gestionnaire: {
      id: gestionnaireId,
      email: 'gestionnaire-email-templates@tlpe.local',
      nom: 'Gest',
      prenom: 'Email',
      role: 'gestionnaire' as const,
      assujetti_id: null,
    },
    financier: {
      id: financierId,
      email: 'financier-email-templates@tlpe.local',
      nom: 'Fin',
      prenom: 'Email',
      role: 'financier' as const,
      assujetti_id: null,
    },
  };
}

test('email templates routes are admin-only and support preview, override persistence and reset', async () => {
  await withContext(async (ctx) => {
    const fx = resetFixtures(ctx);
    const app = createApp(ctx);

    const forbiddenList = await request(app)
      .get('/api/email-templates')
      .set(makeAuthHeader(ctx, fx.gestionnaire));
    assert.equal(forbiddenList.status, 403);

    const forbiddenPreview = await request(app)
      .post('/api/email-templates/invitation_campagne/preview')
      .set(makeAuthHeader(ctx, fx.financier))
      .send({ context: { raison_sociale: 'Interdit SA' } });
    assert.equal(forbiddenPreview.status, 403);

    const listResponse = await request(app)
      .get('/api/email-templates')
      .set(makeAuthHeader(ctx, fx.admin));
    assert.equal(listResponse.status, 200);
    assert.equal(Array.isArray(listResponse.body.templates), true);
    assert.equal(listResponse.body.templates.length, 8);
    assert.equal(listResponse.body.templates[0].code, 'invitation_campagne');
    assert.ok(listResponse.body.templates[0].available_variables.includes('raison_sociale'));

    const previewResponse = await request(app)
      .post('/api/email-templates/invitation_campagne/preview')
      .set(makeAuthHeader(ctx, fx.admin))
      .send({
        context: {
          raison_sociale: 'Alpha <script>alert(1)</script>',
          lien: 'https://collectivite.test/invitations/123',
        },
      });
    assert.equal(previewResponse.status, 200);
    assert.equal(previewResponse.body.preview.source, 'default');
    assert.match(previewResponse.body.preview.html, /Alpha &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(previewResponse.body.preview.html, /<script>alert\(1\)<\/script>/);

    const upsertResponse = await request(app)
      .put('/api/email-templates/invitation_campagne')
      .set(makeAuthHeader(ctx, fx.admin))
      .send({
        subject_template: 'Sujet mairie {{raison_sociale}}',
        html_template: '<p>{{raison_sociale}}</p><p>{{lien}}</p>',
        text_template: 'Texte mairie {{raison_sociale}} :: {{lien}}',
        description: 'Surcharge mairie',
      });
    assert.equal(upsertResponse.status, 200);
    assert.equal(upsertResponse.body.template.source, 'override');
    assert.equal(upsertResponse.body.template.updated_by, fx.admin.id);
    assert.equal(upsertResponse.body.template.description, 'Surcharge mairie');

    const previewOverride = await request(app)
      .post('/api/email-templates/invitation_campagne/preview')
      .set(makeAuthHeader(ctx, fx.admin))
      .send({
        context: {
          raison_sociale: 'Beta & Co',
          lien: 'https://collectivite.test/invitations/456',
        },
      });
    assert.equal(previewOverride.status, 200);
    assert.equal(previewOverride.body.preview.source, 'override');
    assert.equal(previewOverride.body.preview.subject, 'Sujet mairie Beta & Co');
    assert.match(previewOverride.body.preview.html, /Beta &amp; Co/);

    const resetResponse = await request(app)
      .delete('/api/email-templates/invitation_campagne')
      .set(makeAuthHeader(ctx, fx.admin));
    assert.equal(resetResponse.status, 200);
    assert.equal(resetResponse.body.template.source, 'default');
    assert.equal(resetResponse.body.template.updated_by, null);

    const auditRows = ctx.db.prepare(
      `SELECT action, entite, entite_id, details
       FROM audit_log
       WHERE entite = 'email_template'
       ORDER BY id ASC`,
    ).all() as Array<{ action: string; entite: string; entite_id: number | null; details: string | null }>;
    assert.equal(auditRows.length, 2);
    assert.equal(auditRows[0].action, 'upsert-email-template');
    assert.match(auditRows[0].details ?? '', /Surcharge mairie/);
    assert.equal(auditRows[1].action, 'reset-email-template');
    assert.match(auditRows[1].details ?? '', /invitation_campagne/);

    const persistedOverrideCount = (ctx.db.prepare('SELECT COUNT(*) AS c FROM email_templates WHERE code = ?').get('invitation_campagne') as { c: number }).c;
    assert.equal(persistedOverrideCount, 0);

    const invalidTemplate = await request(app)
      .put('/api/email-templates/invitation_campagne')
      .set(makeAuthHeader(ctx, fx.admin))
      .send({
        subject_template: 'Sujet {{#if raison_sociale}}',
        html_template: '<p>HTML</p>',
        text_template: 'Texte',
      });
    assert.equal(invalidTemplate.status, 400);
    assert.match(invalidTemplate.body.error ?? '', /Parse error on line 1:/);

    const missingTemplate = await request(app)
      .get('/api/email-templates/template-inexistant')
      .set(makeAuthHeader(ctx, fx.admin));
    assert.equal(missingTemplate.status, 404);
  });
});
