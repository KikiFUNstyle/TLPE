import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoleTlpeFilename, buildRoleTlpePath, canExportRoleTlpe } from './roleTlpeReport';

test('canExportRoleTlpe exige une année filtrée et un rôle autorisé', () => {
  assert.equal(canExportRoleTlpe({ annee: '', canManage: true }), false);
  assert.equal(canExportRoleTlpe({ annee: '2026', canManage: false }), false);
  assert.equal(canExportRoleTlpe({ annee: '2026', canManage: true }), true);
});

test('helpers construisent le chemin et le nom de fichier attendus', () => {
  assert.equal(buildRoleTlpePath('2026', 'pdf'), '/api/rapports/role?annee=2026&format=pdf');
  assert.equal(buildRoleTlpeFilename('2026', 'xlsx'), 'role-tlpe-2026.xlsx');
});
