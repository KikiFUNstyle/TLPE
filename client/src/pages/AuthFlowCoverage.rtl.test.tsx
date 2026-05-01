import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthContextForTests, type AuthCtx, type User } from '../auth';
import AccountSettings from './AccountSettings';
import Login from './Login';

const fetchMock = vi.fn<typeof fetch>();
const clipboardWriteText = vi.fn<() => Promise<void>>();

const contribUser: User = {
  id: 41,
  email: 'contribuable@tlpe.local',
  nom: 'Durand',
  prenom: 'Marie',
  role: 'contribuable',
  assujetti_id: 7,
};

function createAuthValue(overrides: Partial<AuthCtx> = {}): AuthCtx {
  return {
    user: contribUser,
    loading: false,
    twoFactorChallenge: null,
    login: vi.fn(async (): Promise<'authenticated' | 'two_factor_required'> => 'authenticated'),
    verifyTwoFactor: vi.fn(async () => undefined),
    clearTwoFactorChallenge: vi.fn(),
    logout: vi.fn(),
    hasRole: (...roles) => !!contribUser && roles.includes(contribUser.role),
    refreshUser: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderLogin(authValue: AuthCtx) {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <AuthContextForTests.Provider value={authValue}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<div>Accueil</div>} />
        </Routes>
      </AuthContextForTests.Provider>
    </MemoryRouter>,
  );
}

function renderAccountSettings(authValue: AuthCtx) {
  return render(
    <MemoryRouter initialEntries={['/compte']}>
      <AuthContextForTests.Provider value={authValue}>
        <AccountSettings />
      </AuthContextForTests.Provider>
    </MemoryRouter>,
  );
}

describe('critical auth flows coverage (RTL)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    clipboardWriteText.mockReset();
    clipboardWriteText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('connecte un utilisateur avec ses identifiants puis redirige vers l’accueil', async () => {
    const login = vi.fn(async () => 'authenticated' as const);
    const authValue = createAuthValue({ user: null, login, hasRole: () => false });
    const { container } = renderLogin(authValue);

    const emailInput = container.querySelector('input[type="email"]');
    const passwordInput = container.querySelector('input[type="password"]');
    expect(emailInput).not.toBeNull();
    expect(passwordInput).not.toBeNull();

    fireEvent.change(emailInput!, { target: { value: 'contribuable@tlpe.local' } });
    fireEvent.change(passwordInput!, { target: { value: 'contrib123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Se connecter' }));

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith('contribuable@tlpe.local', 'contrib123');
      expect(screen.getByText('Accueil')).toBeInTheDocument();
    });
  });

  it('affiche une erreur de connexion quand le backend rejette les identifiants', async () => {
    const login = vi.fn(async () => {
      throw new Error('Identifiants invalides');
    });
    const authValue = createAuthValue({ user: null, login, hasRole: () => false });
    const { container } = renderLogin(authValue);

    fireEvent.change(container.querySelector('input[type="email"]')!, {
      target: { value: 'contribuable@tlpe.local' },
    });
    fireEvent.change(container.querySelector('input[type="password"]')!, {
      target: { value: 'bad-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Se connecter' }));

    expect(await screen.findByText('Identifiants invalides')).toBeInTheDocument();
  });

  it('gère le challenge 2FA, permet le retour arrière et valide un code TOTP', async () => {
    const verifyTwoFactor = vi.fn(async () => undefined);
    const clearTwoFactorChallenge = vi.fn();
    const authValue = createAuthValue({
      user: null,
      hasRole: () => false,
      verifyTwoFactor,
      clearTwoFactorChallenge,
      twoFactorChallenge: {
        challengeToken: 'challenge-123',
        user: {
          email: 'contribuable@tlpe.local',
          nom: 'Durand',
          prenom: 'Marie',
          role: 'contribuable',
        },
      },
    });

    renderLogin(authValue);

    expect(screen.getByText('Double authentification requise.')).toBeInTheDocument();
    expect(screen.getByText(/Marie Durand/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retour à la connexion' }));
    expect(clearTwoFactorChallenge).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Valider la double authentification' }));

    await waitFor(() => {
      expect(verifyTwoFactor).toHaveBeenCalledWith({ code: '123456', recoveryCode: '' });
      expect(screen.getByText('Accueil')).toBeInTheDocument();
    });
  });

  it('charge le statut 2FA, prépare le setup puis active la double authentification', async () => {
    const refreshUser = vi.fn(async () => undefined);
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ enabled: false, recovery_codes_remaining: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            secret: 'JBSWY3DPEHPK3PXP',
            otpauth_url:
              'otpauth://totp/TLPE%20Manager:contribuable%40tlpe.local?secret=JBSWY3DPEHPK3PXP&issuer=TLPE%20Manager',
            qr_code_data_url: 'data:image/png;base64,AAA',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ enabled: true, recovery_codes: ['ABCD-EFGH-IJKL', 'MNOP-QRST-UVWX'] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ enabled: true, recovery_codes_remaining: 8 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    renderAccountSettings(createAuthValue({ refreshUser }));

    expect(await screen.findByText('2FA inactive.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Configurer la double authentification' }));

    expect(await screen.findByText('Étape 1 — Scanner le QR code')).toBeInTheDocument();
    expect(clipboardWriteText).toHaveBeenCalledWith('JBSWY3DPEHPK3PXP');
    fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Activer la double authentification' }));

    expect(await screen.findByText('Double authentification activée. Enregistrez vos codes de récupération.')).toBeInTheDocument();
    expect(screen.getByText('ABCD-EFGH-IJKL')).toBeInTheDocument();
    expect(refreshUser).toHaveBeenCalledTimes(1);
  });

  it('désactive la 2FA quand un code TOTP valide est fourni', async () => {
    const refreshUser = vi.fn(async () => undefined);
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ enabled: true, recovery_codes_remaining: 6 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ enabled: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ enabled: false, recovery_codes_remaining: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    renderAccountSettings(createAuthValue({ refreshUser }));

    expect(await screen.findByText('2FA active.')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '222222' } });
    fireEvent.click(screen.getByRole('button', { name: 'Désactiver la double authentification' }));

    expect(await screen.findByText('Double authentification désactivée.')).toBeInTheDocument();
    expect(screen.getByText('2FA inactive.')).toBeInTheDocument();
    expect(refreshUser).toHaveBeenCalledTimes(1);
  });

  it('affiche l’erreur retournée par le chargement du statut 2FA', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Impossible de charger le statut 2FA' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    renderAccountSettings(createAuthValue());

    expect(await screen.findByText('Impossible de charger le statut 2FA')).toBeInTheDocument();
  });
});
