import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import express from 'express';
import { db, initSchema } from './db';
import { hashPassword, signToken, type AuthUser } from './auth';
import { titresRouter } from './routes/titres';
import { runEscaladeImpayes } from './impayes';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/titres', titresRouter);
  return app;
}

function makeAuthHeader(user: AuthUser): Record<string, string> {
  return { Authorization: `Bearer ${signToken(user)}` };
}

async function request(params: {
  method: 'GET';
  path: string;
  headers?: Record<string, string>;
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
      headers: params.headers,
    });
    return {
      status: res.status,
      json: await res.json(),
    };
  } finally {
    server.close();
  }
}

function deleteIfExists(table: string) {
  const exists = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
      | { name: string }
      | undefined
  )?.name === table;
  if (exists) db.exec(`DELETE FROM ${table}`);
}

function resetFixtures() {
  initSchema();
  db.pragma('foreign_keys = OFF');
  try {
    deleteIfExists('recouvrement_actions');
    db.exec('DELETE FROM paiements');
    db.exec('DELETE FROM titres');
    db.exec('DELETE FROM contentieux');
    db.exec('DELETE FROM pieces_jointes');
    db.exec('DELETE FROM lignes_declaration');
    db.exec('DELETE FROM declarations');
    db.exec('DELETE FROM notifications_email');
    db.exec('DELETE FROM invitation_magic_links');
    db.exec('DELETE FROM campagne_jobs');
    db.exec('DELETE FROM mises_en_demeure');
    db.exec('DELETE FROM campagnes');
    db.exec('DELETE FROM audit_log');
    db.exec('DELETE FROM users');
    db.exec('DELETE FROM assujettis');
  } finally {
    db.pragma('foreign_keys = ON');
  }

  fs.rmSync(path.resolve(__dirname, '..', 'data', 'recouvrement'), { recursive: true, force: true });
  fs.rmSync(path.resolve(__dirname, '..', 'data', 'mises_en_demeure', 'impayes'), { recursive: true, force: true });

  const financierId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES ('financier-impayes@tlpe.local', ?, 'Fin', 'Impayes', 'financier', 1)`,
    ).run(hashPassword('x')).lastInsertRowid,
  );

  const assujettiId = Number(
    db.prepare(
      `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, statut)
       VALUES ('TLPE-IMP-001', 'Alpha Impayes', 'alpha@example.fr', 'actif')`,
    ).run().lastInsertRowid,
  );
  const assujettiContentieuxId = Number(
    db.prepare(
      `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, statut)
       VALUES ('TLPE-IMP-002', 'Beta Contentieux', 'beta@example.fr', 'actif')`,
    ).run().lastInsertRowid,
  );
  const assujettiMoratoireId = Number(
    db.prepare(
      `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, statut)
       VALUES ('TLPE-IMP-003', 'Gamma Moratoire', 'gamma@example.fr', 'actif')`,
    ).run().lastInsertRowid,
  );

  const declarationId = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-IMP-001', ?, 2026, 'validee', 500)`,
    ).run(assujettiId).lastInsertRowid,
  );
  const declarationContentieuxId = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-IMP-002', ?, 2026, 'validee', 800)`,
    ).run(assujettiContentieuxId).lastInsertRowid,
  );
  const declarationMoratoireId = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES ('DEC-IMP-003', ?, 2026, 'validee', 650)`,
    ).run(assujettiMoratoireId).lastInsertRowid,
  );

  const titreJ10Id = Number(
    db.prepare(
      `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut, montant_paye)
       VALUES ('TIT-2026-000901', ?, ?, 2026, 500, '2026-04-15', '2026-09-01', 'emis', 0)`,
    ).run(declarationId, assujettiId).lastInsertRowid,
  );
  const titreContentieuxId = Number(
    db.prepare(
      `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut, montant_paye)
       VALUES ('TIT-2026-000902', ?, ?, 2026, 800, '2026-04-15', '2026-09-01', 'emis', 0)`,
    ).run(declarationContentieuxId, assujettiContentieuxId).lastInsertRowid,
  );
  const titreMoratoireId = Number(
    db.prepare(
      `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut, montant_paye)
       VALUES ('TIT-2026-000903', ?, ?, 2026, 650, '2026-04-15', '2026-09-01', 'emis', 0)`,
    ).run(declarationMoratoireId, assujettiMoratoireId).lastInsertRowid,
  );

  db.prepare(
    `INSERT INTO contentieux (numero, assujetti_id, titre_id, type, montant_litige, statut, description)
     VALUES ('CTX-2026-00001', ?, ?, 'contentieux', 800, 'ouvert', 'Recours contentieux')`,
  ).run(assujettiContentieuxId, titreContentieuxId);
  db.prepare(
    `INSERT INTO contentieux (numero, assujetti_id, titre_id, type, montant_litige, statut, description, decision)
     VALUES ('CTX-2026-00002', ?, ?, 'moratoire', 650, 'instruction', 'Moratoire en cours', 'Moratoire accordé sur 6 mois')`,
  ).run(assujettiMoratoireId, titreMoratoireId);

  return {
    financier: {
      id: financierId,
      email: 'financier-impayes@tlpe.local',
      role: 'financier' as const,
      nom: 'Fin',
      prenom: 'Impayes',
      assujetti_id: null,
    },
    titreJ10Id,
    titreContentieuxId,
    titreMoratoireId,
  };
}

test('runEscaladeImpayes déclenche J+10 uniquement pour les titres impayés sans contentieux ni moratoire accordé', () => {
  const fx = resetFixtures();

  const result = runEscaladeImpayes({ runDateIso: '2026-09-11', userId: fx.financier.id, ip: '127.0.0.1' });

  assert.equal(result.processed, 1);
  assert.equal(result.blocked, 2);
  assert.equal(result.sent, 1);

  const titre = db.prepare('SELECT statut FROM titres WHERE id = ?').get(fx.titreJ10Id) as { statut: string };
  assert.equal(titre.statut, 'impaye');

  const action = db
    .prepare(
      `SELECT niveau, action_type, statut, email_destinataire
       FROM recouvrement_actions
       WHERE titre_id = ?`,
    )
    .get(fx.titreJ10Id) as { niveau: string; action_type: string; statut: string; email_destinataire: string };
  assert.equal(action.niveau, 'J+10');
  assert.equal(action.action_type, 'rappel_email');
  assert.equal(action.statut, 'envoye');
  assert.equal(action.email_destinataire, 'alpha@example.fr');

  const blockedCount = (
    db.prepare('SELECT COUNT(*) AS c FROM recouvrement_actions WHERE titre_id IN (?, ?)').get(
      fx.titreContentieuxId,
      fx.titreMoratoireId,
    ) as { c: number }
  ).c;
  assert.equal(blockedCount, 0);
});

test('runEscaladeImpayes déclenche J+30 avec PDF de mise en demeure et expose l’historique via l’API titres', async () => {
  const fx = resetFixtures();
  db.prepare("UPDATE titres SET date_echeance = '2026-08-12' WHERE id = ?").run(fx.titreJ10Id);

  const result = runEscaladeImpayes({ runDateIso: '2026-09-11', userId: fx.financier.id });
  assert.equal(result.processed, 1);
  assert.equal(result.generated_pdfs, 1);

  const titre = db.prepare('SELECT statut FROM titres WHERE id = ?').get(fx.titreJ10Id) as { statut: string };
  assert.equal(titre.statut, 'mise_en_demeure');

  const action = db
    .prepare(
      `SELECT niveau, action_type, statut, piece_jointe_path
       FROM recouvrement_actions
       WHERE titre_id = ?`,
    )
    .get(fx.titreJ10Id) as { niveau: string; action_type: string; statut: string; piece_jointe_path: string | null };
  assert.equal(action.niveau, 'J+30');
  assert.equal(action.action_type, 'mise_en_demeure');
  assert.equal(action.statut, 'envoye');
  assert.ok(action.piece_jointe_path);
  assert.equal(
    fs.existsSync(path.resolve(path.join(__dirname, '..', 'data', action.piece_jointe_path!))),
    true,
  );

  const history = await request({
    method: 'GET',
    path: `/api/titres/${fx.titreJ10Id}/historique`,
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(history.status, 200);
  assert.equal(history.json.actions.length, 1);
  assert.equal(history.json.actions[0].niveau, 'J+30');
});

test('runEscaladeImpayes déclenche J+60 de façon idempotente avec transmission au comptable public', () => {
  const fx = resetFixtures();
  db.prepare("UPDATE titres SET date_echeance = '2026-07-13', statut = 'mise_en_demeure' WHERE id = ?").run(fx.titreJ10Id);

  const first = runEscaladeImpayes({ runDateIso: '2026-09-11', userId: fx.financier.id });
  const second = runEscaladeImpayes({ runDateIso: '2026-09-11', userId: fx.financier.id });

  assert.equal(first.transmitted, 1);
  assert.equal(second.transmitted, 0);

  const action = db
    .prepare(
      `SELECT niveau, action_type, statut, details
       FROM recouvrement_actions
       WHERE titre_id = ?`,
    )
    .get(fx.titreJ10Id) as { niveau: string; action_type: string; statut: string; details: string | null };
  assert.equal(action.niveau, 'J+60');
  assert.equal(action.action_type, 'transmission_comptable');
  assert.equal(action.statut, 'transmis');
  assert.match(action.details ?? '', /api\/titres\//);

  const count = (
    db.prepare('SELECT COUNT(*) AS c FROM recouvrement_actions WHERE titre_id = ?').get(fx.titreJ10Id) as { c: number }
  ).c;
  assert.equal(count, 1);
});
