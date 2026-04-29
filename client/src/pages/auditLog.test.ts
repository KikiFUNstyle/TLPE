import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAuditLogExportFilename,
  buildAuditLogPath,
  canExportAuditLog,
  defaultAuditLogFilters,
  shouldApplyAuditLogRequestResult,
} from './auditLog';

test('defaultAuditLogFilters initialise les filtres du journal d’audit', () => {
  assert.deepEqual(defaultAuditLogFilters(), {
    user_id: '',
    action: '',
    entite: '',
    q: '',
    date_debut: '',
    date_fin: '',
    page_size: 25,
  });
});

test('canExportAuditLog exige un accès admin', () => {
  assert.equal(canExportAuditLog({ canManage: false }), false);
  assert.equal(canExportAuditLog({ canManage: true }), true);
});

test('buildAuditLogPath construit la requête API complète avec pagination, filtres et format', () => {
  assert.equal(
    buildAuditLogPath(
      {
        user_id: '3',
        action: 'export-bordereau',
        entite: 'titre',
        q: 'sha-256',
        date_debut: '2026-05-01',
        date_fin: '2026-05-31',
        page_size: 50,
      },
      { page: 2, format: 'csv' },
    ),
    '/api/audit-log?page=2&page_size=50&user_id=3&entite=titre&action=export-bordereau&q=sha-256&date_debut=2026-05-01&date_fin=2026-05-31&format=csv',
  );
});

test('buildAuditLogExportFilename conserve la plage de dates si elle est connue', () => {
  assert.equal(buildAuditLogExportFilename({ date_debut: '2026-05-01', date_fin: '2026-05-31' }), 'audit-log-2026-05-01_2026-05-31.csv');
  assert.equal(buildAuditLogExportFilename({ date_debut: '', date_fin: '' }), 'audit-log.csv');
});

test('shouldApplyAuditLogRequestResult ignore les réponses obsolètes', () => {
  assert.equal(shouldApplyAuditLogRequestResult(5, 4), false);
  assert.equal(shouldApplyAuditLogRequestResult(5, 5), true);
});
