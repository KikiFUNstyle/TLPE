import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { AccountSettingsTwoFactorPanel, type TwoFactorStatusResponse, type TwoFactorSetupResponse } from './AccountSettings';
import { type User } from '../auth';

const contribUser: User = {
  id: 41,
  email: 'contribuable@tlpe.local',
  nom: 'Durand',
  prenom: 'Marie',
  role: 'contribuable',
  assujetti_id: 7,
};

const disabledStatus: TwoFactorStatusResponse = {
  enabled: false,
  recovery_codes_remaining: 0,
};

const enabledStatus: TwoFactorStatusResponse = {
  enabled: true,
  recovery_codes_remaining: 6,
};

const setup: TwoFactorSetupResponse = {
  secret: 'JBSWY3DPEHPK3PXP',
  otpauth_url: 'otpauth://totp/TLPE%20Manager:contribuable%40tlpe.local?secret=JBSWY3DPEHPK3PXP&issuer=TLPE%20Manager',
  qr_code_data_url: 'data:image/png;base64,AAA',
};

test('AccountSettingsTwoFactorPanel guide le contribuable pour scanner le QR code, saisir le secret manuel et conserver les codes de récupération', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      StaticRouter,
      { location: '/compte' },
      React.createElement(AccountSettingsTwoFactorPanel, {
        user: contribUser,
        status: disabledStatus,
        statusLoading: false,
        setupLoading: false,
        actionLoading: false,
        setup,
        verificationCode: '',
        disableCode: '',
        statusMessage: 'Codes générés : 10 codes de récupération.',
        statusMessageType: 'success',
        recoveryCodes: ['ABCD-EFGH-IJKL', 'MNOP-QRST-UVWX'],
        onVerificationCodeChange: () => undefined,
        onDisableCodeChange: () => undefined,
        onStartSetup: () => undefined,
        onEnable: (event) => event.preventDefault(),
        onDisable: (event) => event.preventDefault(),
      }),
    ),
  );

  assert.match(html, /Paramètres du compte/i);
  assert.match(html, /Double authentification \(2FA\)/i);
  assert.match(html, /Scanner le QR code/i);
  assert.match(html, /JBSWY3DPEHPK3PXP/);
  assert.match(html, /Codes de récupération/i);
  assert.match(html, /ABCD-EFGH-IJKL/);
  assert.match(html, /Activer la double authentification/i);
});

test('AccountSettingsTwoFactorPanel affiche le parcours de désactivation quand la 2FA est déjà active', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      StaticRouter,
      { location: '/compte' },
      React.createElement(AccountSettingsTwoFactorPanel, {
        user: contribUser,
        status: enabledStatus,
        statusLoading: false,
        setupLoading: false,
        actionLoading: false,
        setup: null,
        verificationCode: '',
        disableCode: '',
        statusMessage: null,
        statusMessageType: 'info',
        recoveryCodes: [],
        onVerificationCodeChange: () => undefined,
        onDisableCodeChange: () => undefined,
        onStartSetup: () => undefined,
        onEnable: (event) => event.preventDefault(),
        onDisable: (event) => event.preventDefault(),
      }),
    ),
  );

  assert.match(html, /2FA active/i);
  assert.match(html, /Codes de récupération restants\s*:\s*6/i);
  assert.match(html, /Confirmez avec un code TOTP/i);
  assert.match(html, /Désactiver la double authentification/i);
});

test('AccountSettingsTwoFactorPanel expose le lien de navigation attendu depuis la page paramètres du compte', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      StaticRouter,
      { location: '/compte' },
      React.createElement('a', { href: '/compte' }, 'Paramètres du compte'),
    ),
  );

  assert.match(html, /Paramètres du compte/i);
  assert.match(html, /href="\/compte"/);
});
