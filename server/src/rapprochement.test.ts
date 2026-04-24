import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { db, initSchema } from './db';
import { hashPassword, signToken, type AuthUser } from './auth';
import { rapprochementRouter } from './routes/rapprochement';
import { importReleveBancaire } from './rapprochement';
import { parseStatementFile } from './rapprochementImport';

function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/rapprochement', rapprochementRouter);
  return app;
}

function makeAuthHeader(user: AuthUser): Record<string, string> {
  return { Authorization: `Bearer ${signToken(user)}` };
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
    const text = await res.text();
    return {
      status: res.status,
      contentType,
      json: contentType.includes('application/json') && text ? JSON.parse(text) : null,
      text,
    };
  } finally {
    server.close();
  }
}

function resetFixtures() {
  initSchema();
  db.exec('DELETE FROM lignes_releve');
  db.exec('DELETE FROM releves_bancaires');
  db.exec('DELETE FROM paiements');
  db.exec('DELETE FROM sepa_export_items');
  db.exec('DELETE FROM sepa_prelevements');
  db.exec('DELETE FROM sepa_exports');
  db.exec('DELETE FROM mandats_sepa');
  db.exec('DELETE FROM pesv2_export_titres');
  db.exec('DELETE FROM pesv2_exports');
  db.exec('DELETE FROM declaration_receipts');
  db.exec('DELETE FROM notifications_email');
  db.exec('DELETE FROM invitation_magic_links');
  db.exec('DELETE FROM campagne_jobs');
  db.exec('DELETE FROM mises_en_demeure');
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
  db.exec('DELETE FROM zones');

  const financierId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES ('financier-rappro@tlpe.local', ?, 'Fin', 'Rappro', 'financier', 1)`,
    ).run(hashPassword('x')).lastInsertRowid,
  );
  const adminId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, actif)
       VALUES ('admin-rappro@tlpe.local', ?, 'Admin', 'Rappro', 'admin', 1)`,
    ).run(hashPassword('x')).lastInsertRowid,
  );
  const contribuableId = Number(
    db.prepare(
      `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, portail_actif, statut)
       VALUES ('TLPE-RAPPRO-001', 'Alpha Publicite', 'alpha@example.test', 1, 'actif')`,
    ).run().lastInsertRowid,
  );
  const userContribuableId = Number(
    db.prepare(
      `INSERT INTO users (email, password_hash, nom, prenom, role, assujetti_id, actif)
       VALUES ('contribuable-rappro@tlpe.local', ?, 'Contrib', 'uable', 'contribuable', ?, 1)`,
    ).run(hashPassword('x'), contribuableId).lastInsertRowid,
  );

  return {
    financier: {
      id: financierId,
      email: 'financier-rappro@tlpe.local',
      role: 'financier' as const,
      nom: 'Fin',
      prenom: 'Rappro',
      assujetti_id: null,
    },
    admin: {
      id: adminId,
      email: 'admin-rappro@tlpe.local',
      role: 'admin' as const,
      nom: 'Admin',
      prenom: 'Rappro',
      assujetti_id: null,
    },
    contribuable: {
      id: userContribuableId,
      email: 'contribuable-rappro@tlpe.local',
      role: 'contribuable' as const,
      nom: 'Contrib',
      prenom: 'uable',
      assujetti_id: contribuableId,
    },
  };
}

function toBase64(value: string) {
  return Buffer.from(value, 'utf-8').toString('base64');
}

test('parseStatementFile supporte CSV paramétrable, OFX et MT940', () => {
  const csv = parseStatementFile({
    fileName: 'releve.csv',
    contentBase64: toBase64('date_operation;description;credit;debit;id\n2026-04-01;Virement entrant;150,45;;TX-1\n2026-04-02;Frais bancaires;;12,00;TX-2\n'),
    csvConfig: {
      delimiter: ';',
      dateColumn: 'date_operation',
      labelColumn: 'description',
      creditColumn: 'credit',
      debitColumn: 'debit',
      transactionIdColumn: 'id',
    },
  });
  assert.equal(csv.lignes.length, 2);
  assert.equal(csv.lignes[0].transaction_id, 'csv:TX-1');
  assert.equal(csv.lignes[1].montant, -12);

  const ofx = parseStatementFile({
    fileName: 'releve.ofx',
    contentBase64: toBase64(`OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><ACCTID>FR761234</ACCTID></BANKACCTFROM><BANKTRANLIST><DTSTART>20260401000000</DTSTART><DTEND>20260430235959</DTEND><STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20260401120000</DTPOSTED><TRNAMT>150.45</TRNAMT><FITID>OFX-1</FITID><NAME>VIREMENT CLIENT</NAME><MEMO>PAY-001</MEMO></STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`),
  });
  assert.equal(ofx.accountId, 'FR761234');
  assert.equal(ofx.lignes[0].transaction_id, 'ofx:OFX-1');

  const mt940 = parseStatementFile({
    fileName: 'releve.mt940',
    contentBase64: toBase64(
      ':20:START\n'
      + ':25:FR761234\n'
      + ':60F:C260401EUR0,00\n'
      + ':61:2604010401C150,45NTRFNONREF//BANKREF1\n'
      + ':86:VIREMENT CLIENT\n'
      + ':61:2604020402D12,00NMSCNREFSANSBANK\n'
      + ':86:FRAIS BANCAIRES\n'
      + ':62F:C260430EUR138,45\n',
    ),
  });
  assert.equal(mt940.accountId, 'FR761234');
  assert.equal(mt940.dateDebut, '2026-04-01');
  assert.equal(mt940.dateFin, '2026-04-30');
  assert.equal(mt940.lignes.length, 2);
  assert.equal(mt940.lignes[0].transaction_id, 'mt940:BANKREF1');
  assert.equal(mt940.lignes[0].reference, 'NONREF');
  assert.equal(mt940.lignes[0].libelle, 'VIREMENT CLIENT');
  assert.equal(mt940.lignes[1].transaction_id, 'mt940:NREFSANSBANK');
  assert.equal(mt940.lignes[1].reference, 'NREFSANSBANK');
  assert.equal(mt940.lignes[1].libelle, 'FRAIS BANCAIRES');
});

test('importReleveBancaire supporte les gros fichiers sans dépasser la limite SQLite des paramètres', () => {
  const fx = resetFixtures();
  const lineCount = 33010;
  const rows = ['date;libelle;montant;reference;transaction_id'];
  for (let i = 0; i < lineCount; i += 1) {
    rows.push(`2026-04-01;Versement ${i};1,00;REF-${i};BANK-${i}`);
  }

  const res = importReleveBancaire({
    fileName: 'releve-massif.csv',
    contentBase64: toBase64(`${rows.join('\n')}\n`),
    format: 'csv',
    userId: fx.financier.id,
    ip: '127.0.0.1',
  });

  assert.equal(res.lignesImportees, lineCount);
  assert.equal(res.lignesIgnorees, 0);
  const count = (db.prepare('SELECT COUNT(*) AS c FROM lignes_releve').get() as { c: number }).c;
  assert.equal(count, lineCount);
});

test('POST /api/rapprochement/import importe un relevé et déduplique par transaction bancaire', async () => {
  const fx = resetFixtures();
  const payload = {
    fileName: 'releve.csv',
    contentBase64: toBase64('date;libelle;montant;reference;transaction_id\n2026-04-01;Virement Alpha;150,45;PAY-001;BANK-001\n2026-04-02;Virement Beta;99,99;PAY-002;BANK-002\n'),
    format: 'csv',
  };

  const first = await request({
    method: 'POST',
    path: '/api/rapprochement/import',
    headers: makeAuthHeader(fx.financier),
    body: payload,
  });

  assert.equal(first.status, 201);
  assert.equal(first.json?.lignesImportees, 2);
  assert.equal(first.json?.lignesIgnorees, 0);
  assert.equal(first.json?.releve.lignes_non_rapprochees, 2);

  const second = await request({
    method: 'POST',
    path: '/api/rapprochement/import',
    headers: makeAuthHeader(fx.financier),
    body: payload,
  });

  assert.equal(second.status, 201);
  assert.equal(second.json?.lignesImportees, 0);
  assert.equal(second.json?.lignesIgnorees, 2);
  assert.equal(second.json?.duplicates.length, 2);

  const count = (db.prepare('SELECT COUNT(*) AS c FROM lignes_releve').get() as { c: number }).c;
  assert.equal(count, 2);

  const audit = db.prepare("SELECT action, entite, details FROM audit_log WHERE entite = 'releve_bancaire' ORDER BY id DESC LIMIT 1").get() as
    | { action: string; entite: string; details: string }
    | undefined;
  assert.ok(audit);
  assert.equal(audit?.action, 'import');
  assert.match(audit?.details ?? '', /BANK-001/);
});

test('POST /api/rapprochement/import ignore aussi les doublons présents dans un même fichier', async () => {
  const fx = resetFixtures();

  const res = await request({
    method: 'POST',
    path: '/api/rapprochement/import',
    headers: makeAuthHeader(fx.financier),
    body: {
      fileName: 'releve-duplique.csv',
      contentBase64: toBase64(
        'date;libelle;montant;reference;transaction_id\n'
        + '2026-04-01;Virement Alpha;150,45;PAY-001;BANK-001\n'
        + '2026-04-01;Virement Alpha bis;150,45;PAY-001;BANK-001\n'
        + '2026-04-02;Virement Beta;99,99;PAY-002;BANK-002\n',
      ),
      format: 'csv',
    },
  });

  assert.equal(res.status, 201);
  assert.equal(res.json?.lignesImportees, 2);
  assert.equal(res.json?.lignesIgnorees, 1);
  assert.equal(res.json?.duplicates.length, 1);
  assert.equal(res.json?.duplicates[0].transaction_id, 'csv:BANK-001');

  const count = (db.prepare('SELECT COUNT(*) AS c FROM lignes_releve').get() as { c: number }).c;
  assert.equal(count, 2);
});

test('GET /api/rapprochement expose les lignes non rapprochées et protège la route', async () => {
  const fx = resetFixtures();

  const unauthorized = await request({
    method: 'GET',
    path: '/api/rapprochement',
    headers: makeAuthHeader(fx.contribuable),
  });
  assert.equal(unauthorized.status, 403);

  await request({
    method: 'POST',
    path: '/api/rapprochement/import',
    headers: makeAuthHeader(fx.admin),
    body: {
      fileName: 'releve.ofx',
      contentBase64: toBase64(`OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><ACCTID>FR761234</ACCTID></BANKACCTFROM><BANKTRANLIST><DTSTART>20260401000000</DTSTART><DTEND>20260430235959</DTEND><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260402120000</DTPOSTED><TRNAMT>-32.10</TRNAMT><FITID>OFX-200</FITID><NAME>FRAIS</NAME><MEMO>CB</MEMO></STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`),
      format: 'ofx',
    },
  });

  const res = await request({
    method: 'GET',
    path: '/api/rapprochement',
    headers: makeAuthHeader(fx.admin),
  });

  assert.equal(res.status, 200);
  assert.equal(Array.isArray(res.json?.releves), true);
  assert.equal(Array.isArray(res.json?.lignes_non_rapprochees), true);
  assert.equal(res.json?.lignes_non_rapprochees[0].transaction_id, 'ofx:OFX-200');
});

test('POST /api/rapprochement/import retourne 400 sur erreur de validation et 500 sur erreur interne', async () => {
  const fx = resetFixtures();

  const validationError = await request({
    method: 'POST',
    path: '/api/rapprochement/import',
    headers: makeAuthHeader(fx.financier),
    body: {
      fileName: 'releve.csv',
      contentBase64: toBase64('date;libelle\n2026-04-01;Paiement incomplet\n'),
      format: 'csv',
    },
  });

  assert.equal(validationError.status, 400);
  assert.match(validationError.text, /Configurer une colonne montant|colonne/i);

  const previousPrepare = db.prepare.bind(db);
  let forcedOnce = false;
  // @ts-ignore test monkey patch for fault injection
  db.prepare = ((sql: string) => {
    if (!forcedOnce && sql.includes('INSERT INTO releves_bancaires')) {
      forcedOnce = true;
      throw new Error('disk I/O error');
    }
    return previousPrepare(sql);
  }) as typeof db.prepare;

  try {
    const internalError = await request({
      method: 'POST',
      path: '/api/rapprochement/import',
      headers: makeAuthHeader(fx.financier),
      body: {
        fileName: 'releve.csv',
        contentBase64: toBase64('date;libelle;montant\n2026-04-01;Paiement;10,00\n'),
        format: 'csv',
      },
    });

    assert.equal(internalError.status, 500);
    assert.match(internalError.text, /Erreur interne import rapprochement/);
    assert.doesNotMatch(internalError.text, /disk I\/O error/);
  } finally {
    // @ts-ignore restore monkey patch after fault injection
    db.prepare = previousPrepare;
  }
});
