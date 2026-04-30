import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AccountSettingsTwoFactorPanel, type TwoFactorSetupResponse, type TwoFactorStatusResponse } from './AccountSettings';
import type { User } from '../auth';

const user: User = {
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

function renderPanel(overrides: Partial<React.ComponentProps<typeof AccountSettingsTwoFactorPanel>> = {}) {
  return render(
    <AccountSettingsTwoFactorPanel
      user={user}
      status={disabledStatus}
      statusLoading={false}
      setupLoading={false}
      actionLoading={false}
      setup={null}
      verificationCode=""
      disableCode=""
      statusMessage={null}
      statusMessageType="info"
      recoveryCodes={[]}
      onVerificationCodeChange={vi.fn()}
      onDisableCodeChange={vi.fn()}
      onStartSetup={vi.fn()}
      onEnable={(event) => event.preventDefault()}
      onDisable={(event) => event.preventDefault()}
      {...overrides}
    />,
  );
}

describe('AccountSettingsTwoFactorPanel (RTL)', () => {
  it('affiche un état de chargement du statut 2FA', () => {
    renderPanel({ statusLoading: true });

    expect(screen.getByText('Chargement du statut 2FA...')).toBeInTheDocument();
  });

  it('guide l’utilisateur pour configurer la 2FA avec QR code, secret manuel et codes de récupération', () => {
    renderPanel({
      setup,
      statusMessage: 'Codes générés : 10 codes de récupération.',
      statusMessageType: 'success',
      recoveryCodes: ['ABCD-EFGH-IJKL', 'MNOP-QRST-UVWX'],
    });

    expect(screen.getByRole('button', { name: 'Régénérer le QR code' })).toBeInTheDocument();
    expect(screen.getByText('Étape 1 — Scanner le QR code')).toBeInTheDocument();
    expect(screen.getByAltText('QR code pour activer la double authentification TOTP')).toBeInTheDocument();
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    expect(screen.getByText('Codes de récupération')).toBeInTheDocument();
    expect(screen.getByText('ABCD-EFGH-IJKL')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activer la double authentification' })).toBeInTheDocument();
  });

  it('affiche le parcours de désactivation quand la 2FA est déjà active', () => {
    renderPanel({ status: enabledStatus });

    expect(screen.getByText('2FA active.')).toBeInTheDocument();
    expect(screen.getByText('Codes de récupération restants : 6')).toBeInTheDocument();
    expect(screen.getByText('Confirmez avec un code TOTP')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Désactiver la double authentification' })).toBeInTheDocument();
  });
});
