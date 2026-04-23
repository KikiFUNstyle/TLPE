import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBordereauFilename, buildBordereauPath, canExportBordereau } from './titresBordereau';

test('canExportBordereau exige une année filtrée et un rôle financier/admin', () => {
  assert.equal(canExportBordereau({ annee: '', canManage: true }), false);
  assert.equal(canExportBordereau({ annee: '2026', canManage: false }), false);
  assert.equal(canExportBordereau({ annee: '2026', canManage: true }), true);
});

test('helpers construisent le chemin et le nom de fichier attendus', () => {
  assert.equal(buildBordereauPath('2026', 'pdf'), '/api/titres/bordereau?annee=2026&format=pdf');
  assert.equal(buildBordereauFilename('2026', 'xlsx'), 'bordereau-titres-2026.xlsx');
});
