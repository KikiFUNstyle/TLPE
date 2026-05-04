import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTwoFactorVerificationPayload,
  resolveLoginFlow,
  shouldNavigateAfterCredentialStep,
  type User,
} from './auth';

const previewUser = {
  email: 'contribuable@tlpe.local',
  nom: 'Durand',
  prenom: 'Marie',
  role: 'contribuable',
} satisfies Pick<User, 'email' | 'nom' | 'prenom' | 'role'>;

test('resolveLoginFlow retourne une session partielle quand le backend exige une double authentification', () => {
  const result = resolveLoginFlow({
    requires_two_factor: true,
    challenge_token: 'challenge-123',
    user: previewUser,
  });

  assert.deepEqual(result, {
    status: 'two_factor_required',
    challenge: {
      challengeToken: 'challenge-123',
      user: previewUser,
    },
  });
});

test('resolveLoginFlow retourne une session authentifiée quand le backend renvoie un JWT', () => {
  const user: User = {
    id: 7,
    email: 'admin@tlpe.local',
    nom: 'Admin',
    prenom: 'Systeme',
    role: 'admin',
    assujetti_id: null,
  };

  const result = resolveLoginFlow({ token: 'jwt-123', user });

  assert.deepEqual(result, {
    status: 'authenticated',
    session: {
      token: 'jwt-123',
      user,
    },
  });
});

test('buildTwoFactorVerificationPayload nettoie un code TOTP saisi', () => {
  assert.deepEqual(
    buildTwoFactorVerificationPayload('challenge-123', { code: ' 123 456 ', recoveryCode: '' }),
    {
      challenge_token: 'challenge-123',
      code: '123456',
    },
  );
});

test('buildTwoFactorVerificationPayload accepte un code de récupération quand aucun code TOTP n’est fourni', () => {
  assert.deepEqual(
    buildTwoFactorVerificationPayload('challenge-123', { code: '   ', recoveryCode: ' abcd-efgh-ijkl ' }),
    {
      challenge_token: 'challenge-123',
      recovery_code: 'ABCD-EFGH-IJKL',
    },
  );
});

test('buildTwoFactorVerificationPayload rejette un formulaire vide', () => {
  assert.throws(
    () => buildTwoFactorVerificationPayload('challenge-123', { code: ' ', recoveryCode: ' ' }),
    /code TOTP ou un code de récupération est requis/i,
  );
});

test('buildTwoFactorVerificationPayload rejette une saisie simultanée TOTP + récupération', () => {
  assert.throws(
    () => buildTwoFactorVerificationPayload('challenge-123', { code: '123456', recoveryCode: 'ABCD-EFGH-IJKL' }),
    /Utiliser soit un code TOTP, soit un code de récupération/i,
  );
});

test('shouldNavigateAfterCredentialStep évite la redirection immédiate quand un challenge 2FA est présent', () => {
  assert.equal(shouldNavigateAfterCredentialStep(null), true);
  assert.equal(
    shouldNavigateAfterCredentialStep({
      challengeToken: 'challenge-123',
      user: previewUser,
    }),
    false,
  );
});
