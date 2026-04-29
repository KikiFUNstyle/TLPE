import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AuthUser } from './auth';

type AuditLogTestContext = {
  db: typeof import('./db').db;
  initSchema: typeof import('./db').initSchema;
  hashPassword: typeof import('./auth').hashPassword;
  signToken: typeof import('./auth').signToken;
  auditLogRouter: typeof import('./routes/auditLog').auditLogRouter;
  cleanup: () => void;
};

const TEST_MODULES = ['./db', './auth', './routes/auditLog'] as const;

function clearModuleCache() {
  for (const modulePath of TEST_MODULES) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // ignore
    }
  }
}

function createContext(): AuditLogTestContext {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlpe-audit-log-test-'));
  const dbPath = path.join(tempDir, 'tlpe.db');
  const previousDbPath = process.env.TLPE_DB_PATH;
  process.env.TLPE_DB_PATH = dbPath;
  clearModuleCache();

  const dbModule = require('./db') as typeof import('./db');
  const authModule = require('./auth') as typeof import('./auth');
  const auditLogModule = require('./routes/auditLog') as typeof import('./routes/auditLog');

  return {
    db: dbModule.db,
    initSchema: dbModule.initSchema,
    hashPassword: authModule.hashPassword,
    signToken: authModule.signToken,
    auditLogRouter: auditLogModule.auditLogRouter,
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

async function withContext(run: (ctx: AuditLogTestContext) => Promise<void> | void) {
  const ctx = createContext();
  try {
    await run(ctx);
  } finally {
    ctx.cleanup();
  }
}

function createApp(ctx: AuditLogTestContext) {
  const app = express();
  app.use(express.json());
  app.use('/api/audit-log', ctx.auditLogRouter);
  return app;
}

function makeAuthHeader(ctx: AuditLogTestContext, user: AuthUser): Record<string, string> {
  return { Authorization: `Bearer ${ctx.signToken(user)}` };
}

async function request(ctx: AuditLogTestContext, params: {
  path: string;
  headers?: Record<string, string>;
}) {
  const app = createApp(ctx);
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
      method: 'GET',
      headers: params.headers,
    });
    const contentType = res.headers.get('content-type') || '';
    const buffer = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      contentType,
      disposition: res.headers.get('content-disposition') || '',
      json: contentType.includes('application/json') ? JSON.parse(buffer.toString('utf8')) : null,
      buffer,
    };
  } finally {
    server.close();
  }
}

function resetFixtures(ctx: AuditLogTestContext) {
  ctx.initSchema();
  ctx.db.exec('DELETE FROM audit_log');
  ctx.db.exec('DELETE FROM users');

  const adminId = Number(
    ctx.db
      .prepare(`INSERT INTO users (email, password_hash, nom, prenom, role, actif) VALUES ('admin-audit@tlpe.local', ?, 'Admin', 'Audit', 'admin', 1)`)
      .run(ctx.hashPassword('x')).lastInsertRowid,
  );
  const financierId = Number(
    ctx.db
      .prepare(`INSERT INTO users (email, password_hash, nom, prenom, role, actif) VALUES ('financier-audit@tlpe.local', ?, 'Fin', 'Audit', 'financier', 1)`)
      .run(ctx.hashPassword('x')).lastInsertRowid,
  );
  const gestionnaireId = Number(
    ctx.db
      .prepare(`INSERT INTO users (email, password_hash, nom, prenom, role, actif) VALUES ('gestionnaire-audit@tlpe.local', ?, 'Gest', 'Audit', 'gestionnaire', 1)`)
      .run(ctx.hashPassword('x')).lastInsertRowid,
  );

  ctx.db.prepare(
    `INSERT INTO audit_log (user_id, action, entite, entite_id, details, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    adminId,
    'export-bordereau',
    'titre',
    42,
    JSON.stringify({ hash: 'sha-256:abc', filename: 'bordereau-2026.pdf' }),
    '203.0.113.10',
    '2026-05-14 10:30:00',
  );
  ctx.db.prepare(
    `INSERT INTO audit_log (user_id, action, entite, entite_id, details, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    gestionnaireId,
    'validate',
    'declaration',
    15,
    JSON.stringify({ numero: 'DEC-2026-001' }),
    '203.0.113.20',
    '2026-05-12 09:15:00',
  );
  ctx.db.prepare(
    `INSERT INTO audit_log (user_id, action, entite, entite_id, details, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    adminId,
    'login',
    'auth',
    null,
    JSON.stringify({ outcome: 'success' }),
    '198.51.100.5',
    '2026-04-01 08:00:00',
  );

  return {
    admin: { id: adminId, email: 'admin-audit@tlpe.local', role: 'admin' as const, nom: 'Admin', prenom: 'Audit', assujetti_id: null },
    financier: { id: financierId, email: 'financier-audit@tlpe.local', role: 'financier' as const, nom: 'Fin', prenom: 'Audit', assujetti_id: null },
    gestionnaire: { id: gestionnaireId, email: 'gestionnaire-audit@tlpe.local', role: 'gestionnaire' as const, nom: 'Gest', prenom: 'Audit', assujetti_id: null },
  };
}

test('initSchema crée un index de tri sur audit_log.created_at', async () => {
  await withContext(async (ctx) => {
    ctx.initSchema();
    const indexes = ctx.db.prepare("PRAGMA index_list('audit_log')").all() as Array<{ name: string }>;
    assert.ok(indexes.some((index) => index.name === 'idx_audit_created_at'));
  });
});

test('GET /api/audit-log restreint l’accès aux admins et applique filtres + pagination', async () => {
  await withContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const forbidden = await request(ctx, {
      path: '/api/audit-log',
      headers: makeAuthHeader(ctx, fx.financier),
    });
    assert.equal(forbidden.status, 403);

    const filtered = await request(ctx, {
      path: '/api/audit-log?page=1&page_size=1&entite=titre&action=export-bordereau&q=sha-256&date_debut=2026-05-01&date_fin=2026-05-31',
      headers: makeAuthHeader(ctx, fx.admin),
    });

    assert.equal(filtered.status, 200);
    assert.equal(filtered.json?.total, 1);
    assert.equal(filtered.json?.page, 1);
    assert.equal(filtered.json?.page_size, 1);
    assert.equal(filtered.json?.total_pages, 1);
    assert.equal(filtered.json?.rows.length, 1);
    assert.equal(filtered.json?.rows[0].action, 'export-bordereau');
    assert.equal(filtered.json?.rows[0].entite, 'titre');
    assert.match(String(filtered.json?.rows[0].details ?? ''), /sha-256:abc/);
    assert.equal(filtered.json?.rows[0].user_display, 'Audit Admin');
    assert.ok(Array.isArray(filtered.json?.options?.actions));
    assert.ok(filtered.json?.options?.actions.includes('export-bordereau'));

    const page2 = await request(ctx, {
      path: '/api/audit-log?page=2&page_size=1',
      headers: makeAuthHeader(ctx, fx.admin),
    });
    assert.equal(page2.status, 200);
    assert.equal(page2.json?.total, 3);
    assert.equal(page2.json?.rows.length, 1);
    assert.equal(page2.json?.rows[0].action, 'validate');
  });
});

test('GET /api/audit-log?format=csv exporte le journal filtré et trace l’export', async () => {
  await withContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const res = await request(ctx, {
      path: '/api/audit-log?format=csv&entite=titre',
      headers: makeAuthHeader(ctx, fx.admin),
    });

    assert.equal(res.status, 200);
    assert.match(res.contentType, /text\/csv/);
    assert.match(res.disposition, /audit-log-.*\.csv/);
    const csv = res.buffer.toString('utf8');
    assert.match(csv, /Horodatage;Utilisateur;Action;Entité;Détails;IP/);
    assert.match(csv, /export-bordereau/);
    assert.match(csv, /Audit Admin/);

    const audit = ctx.db.prepare(`SELECT action, entite, details FROM audit_log WHERE action = 'export-audit-log' ORDER BY id DESC LIMIT 1`).get() as
      | { action: string; entite: string; details: string }
      | undefined;
    assert.ok(audit);
    assert.equal(audit?.entite, 'audit_log');
    assert.match(audit?.details ?? '', /"format":"csv"/);
    assert.match(audit?.details ?? '', /"rows_count":1/);
  });
});

test('GET /api/audit-log rejette une plage de dates invalide', async () => {
  await withContext(async (ctx) => {
    const fx = resetFixtures(ctx);

    const res = await request(ctx, {
      path: '/api/audit-log?date_debut=2026-05-31&date_fin=2026-05-01',
      headers: makeAuthHeader(ctx, fx.admin),
    });

    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.json), /date/i);
  });
});
