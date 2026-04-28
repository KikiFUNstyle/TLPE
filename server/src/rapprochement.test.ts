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
  db.exec('DELETE FROM rapprochements_log');
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
  db.exec('DELETE FROM controles');
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

function createTitreFixture(
  numero: string,
  montant: number,
  annee = 2026,
) {
  const assujettiId = Number(
    db.prepare(
      `INSERT INTO assujettis (identifiant_tlpe, raison_sociale, email, portail_actif, statut)
       VALUES (?, ?, ?, 1, 'actif')`,
    ).run(`TLPE-${numero}`, `Societe ${numero}`, `${numero.toLowerCase()}@example.test`).lastInsertRowid,
  );

  const declarationId = Number(
    db.prepare(
      `INSERT INTO declarations (numero, assujetti_id, annee, statut, montant_total)
       VALUES (?, ?, ?, 'validee', ?)`,
    ).run(`DEC-${numero}`, assujettiId, annee, montant).lastInsertRowid,
  );

  return Number(
    db.prepare(
      `INSERT INTO titres (numero, declaration_id, assujetti_id, annee, montant, date_emission, date_echeance, statut, montant_paye)
       VALUES (?, ?, ?, ?, ?, '2026-04-01', '2026-08-31', 'emis', 0)`,
    ).run(numero, declarationId, assujettiId, annee, montant).lastInsertRowid,
  );
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
  assert.match(mt940.lignes[1].transaction_id, /^mt940:[0-9a-f]{40}$/);
  assert.equal(mt940.lignes[1].reference, 'NREFSANSBANK');
  assert.equal(mt940.lignes[1].libelle, 'FRAIS BANCAIRES');
});

test('parseStatementFile génère des transaction_id distincts en MT940 sans référence bancaire explicite', () => {
  const mt940 = parseStatementFile({
    fileName: 'releve-sans-bankref.mt940',
    contentBase64: toBase64(
      ':20:START\n'
      + ':25:FR761234\n'
      + ':60F:C260401EUR0,00\n'
      + ':61:2604010401C150,45NTRFNONREF\n'
      + ':86:VIREMENT CLIENT A\n'
      + ':61:2604020402C150,45NTRFNONREF\n'
      + ':86:VIREMENT CLIENT B\n'
      + ':62F:C260430EUR300,90\n',
    ),
  });

  assert.equal(mt940.lignes.length, 2);
  assert.notEqual(mt940.lignes[0].transaction_id, mt940.lignes[1].transaction_id);
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

test('POST /api/rapprochement/auto rapproche automatiquement les titres référencés et classe les cas partiels/excédentaires/erronés', async () => {
  const fx = resetFixtures();
  createTitreFixture('TIT-2026-000101', 100);
  createTitreFixture('TIT-2026-000102', 200);
  createTitreFixture('TIT-2026-000103', 75);

  const imported = await request({
    method: 'POST',
    path: '/api/rapprochement/import',
    headers: makeAuthHeader(fx.financier),
    body: {
      fileName: 'releve-auto.csv',
      contentBase64: toBase64(
        'date;libelle;montant;reference;transaction_id\n'
        + '2026-04-01;VIR CLIENT TIT-2026-000101;100,00;;BANK-A1\n'
        + '2026-04-02;VIR CLIENT PARTIEL;50,00;TIT-2026-000102;BANK-A2\n'
        + '2026-04-03;VIR CLIENT TROP PERCU;250,00;TIT-2026-000102;BANK-A3\n'
        + '2026-04-04;VIR CLIENT INCONNU;40,00;TIT-2026-999999;BANK-A4\n'
        + '2026-04-05;REJET DE PRLV; -15,00;TIT-2026-000103;BANK-A5\n',
      ),
      format: 'csv',
    },
  });
  assert.equal(imported.status, 201);

  const auto = await request({
    method: 'POST',
    path: '/api/rapprochement/auto',
    headers: makeAuthHeader(fx.financier),
    body: {},
  });

  assert.equal(auto.status, 200);
  assert.equal(auto.json?.matched_count, 2);
  assert.equal(auto.json?.pending_count, 3);
  assert.equal(auto.json?.payment_count, 2);

  const titre1 = db.prepare("SELECT montant_paye, statut FROM titres WHERE numero = 'TIT-2026-000101'").get() as { montant_paye: number; statut: string };
  const titre2 = db.prepare("SELECT montant_paye, statut FROM titres WHERE numero = 'TIT-2026-000102'").get() as { montant_paye: number; statut: string };
  assert.equal(titre1.montant_paye, 100);
  assert.equal(titre1.statut, 'paye');
  assert.equal(titre2.montant_paye, 50);
  assert.equal(titre2.statut, 'paye_partiel');

  const paiements = db.prepare("SELECT reference, modalite, provider, statut, transaction_id FROM paiements WHERE transaction_id LIKE 'rapprochement:%' ORDER BY transaction_id").all() as Array<{
    reference: string | null;
    modalite: string;
    provider: string;
    statut: string;
    transaction_id: string;
  }>;
  assert.equal(paiements.length, 2);
  assert.deepEqual(
    paiements.map((row) => row.transaction_id),
    ['rapprochement:csv:BANK-A1', 'rapprochement:csv:BANK-A2'],
  );
  assert.equal(paiements[0].modalite, 'virement');
  assert.equal(paiements[0].provider, 'manuel');
  assert.equal(paiements[0].statut, 'confirme');

  const lignes = await request({
    method: 'GET',
    path: '/api/rapprochement',
    headers: makeAuthHeader(fx.financier),
  });
  assert.equal(lignes.status, 200);
  assert.equal(Array.isArray(lignes.json?.lignes_non_rapprochees), true);
  assert.equal(lignes.json?.lignes_non_rapprochees.length, 3);
  assert.deepEqual(
    lignes.json?.lignes_non_rapprochees.map((row: { transaction_id: string; workflow: string }) => [row.transaction_id, row.workflow]),
    [
      ['csv:BANK-A5', 'errone'],
      ['csv:BANK-A4', 'erreur_reference'],
      ['csv:BANK-A3', 'excedentaire'],
    ],
  );

  const journal = lignes.json?.journal_rapprochements as Array<{ mode: string; resultat: string; transaction_id: string }>;
  assert.equal(journal.length, 5);
  assert.deepEqual(
    journal.map((row) => [row.transaction_id, row.mode, row.resultat]),
    [
      ['csv:BANK-A5', 'auto', 'errone'],
      ['csv:BANK-A4', 'auto', 'erreur_reference'],
      ['csv:BANK-A3', 'auto', 'excedentaire'],
      ['csv:BANK-A2', 'auto', 'partiel'],
      ['csv:BANK-A1', 'auto', 'rapproche'],
    ],
  );
});

test('POST /api/rapprochement/manual rapproche une ligne en attente et alimente le journal manuel', async () => {
  const fx = resetFixtures();
  createTitreFixture('TIT-2026-000103', 75);

  const imported = await request({
    method: 'POST',
    path: '/api/rapprochement/import',
    headers: makeAuthHeader(fx.admin),
    body: {
      fileName: 'releve-manuel.csv',
      contentBase64: toBase64(
        'date;libelle;montant;reference;transaction_id\n'
        + '2026-04-05;VIR A VENTILER;75,00;SANS-REFERENCE;BANK-M1\n',
      ),
      format: 'csv',
    },
  });
  assert.equal(imported.status, 201);

  const auto = await request({
    method: 'POST',
    path: '/api/rapprochement/auto',
    headers: makeAuthHeader(fx.admin),
    body: {},
  });
  assert.equal(auto.status, 200);
  assert.equal(auto.json?.matched_count, 0);

  const pendingLineId = Number(
    (db.prepare("SELECT id FROM lignes_releve WHERE transaction_id = 'csv:BANK-M1'").get() as { id: number }).id,
  );

  const manual = await request({
    method: 'POST',
    path: '/api/rapprochement/manual',
    headers: makeAuthHeader(fx.admin),
    body: {
      ligne_id: pendingLineId,
      numero_titre: 'TIT-2026-000103',
      commentaire: 'Vérification humaine',
    },
  });

  assert.equal(manual.status, 201);
  assert.equal(manual.json?.statut, 'paye');
  assert.equal(manual.json?.mode, 'manuel');

  const ligne = db.prepare("SELECT rapproche, paiement_id FROM lignes_releve WHERE transaction_id = 'csv:BANK-M1'").get() as {
    rapproche: number;
    paiement_id: number | null;
  };
  assert.equal(ligne.rapproche, 1);
  assert.ok(ligne.paiement_id);

  const titre = db.prepare("SELECT montant_paye, statut FROM titres WHERE numero = 'TIT-2026-000103'").get() as {
    montant_paye: number;
    statut: string;
  };
  assert.equal(titre.montant_paye, 75);
  assert.equal(titre.statut, 'paye');

  const journal = db.prepare("SELECT mode, resultat, commentaire FROM rapprochements_log WHERE ligne_releve_id = ? ORDER BY id DESC LIMIT 1").get(pendingLineId) as {
    mode: string;
    resultat: string;
    commentaire: string | null;
  };
  assert.equal(journal.mode, 'manuel');
  assert.equal(journal.resultat, 'rapproche');
  assert.match(journal.commentaire ?? '', /Vérification humaine/);
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
