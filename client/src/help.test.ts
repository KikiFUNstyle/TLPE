import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHelpUrl, docsBaseUrl } from './help';

test('buildHelpUrl redirige les sections principales vers la documentation contextualisée', () => {
  assert.equal(buildHelpUrl('/'), `${docsBaseUrl}agents/`);
  assert.equal(buildHelpUrl('/assujettis'), `${docsBaseUrl}agents/#gestion-des-assujettis-et-dispositifs`);
  assert.equal(buildHelpUrl('/titres'), `${docsBaseUrl}financier/#titres-recouvrement-et-export`);
  assert.equal(buildHelpUrl('/controles'), `${docsBaseUrl}controleur/#constats-terrain-et-pieces-jointes`);
  assert.equal(buildHelpUrl('/compte'), `${docsBaseUrl}contribuable/#connexion-securisee-et-double-authentification`);
  assert.equal(buildHelpUrl('/route-inconnue'), `${docsBaseUrl}`);
});
