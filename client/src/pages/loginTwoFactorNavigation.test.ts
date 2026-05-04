import test from 'node:test';
import assert from 'node:assert/strict';
import { accountSettingsNavLabel, accountSettingsRoute } from '../accountSettingsNavigation';

test('la navigation paramètres du compte reste alignée avec la route attendue par le flux 2FA', () => {
  assert.equal(accountSettingsRoute, '/compte');
  assert.equal(accountSettingsNavLabel, 'Paramètres du compte');
});
