import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api, clearToken, getToken, setToken } from './api';

export type Role = 'admin' | 'gestionnaire' | 'financier' | 'controleur' | 'contribuable';

export interface User {
  id: number;
  email: string;
  nom: string;
  prenom: string;
  role: Role;
  assujetti_id: number | null;
}

export type LoginUserPreview = Pick<User, 'email' | 'nom' | 'prenom' | 'role'>;

export interface TwoFactorChallenge {
  challengeToken: string;
  user: LoginUserPreview;
}

type AuthenticatedLoginResponse = {
  token: string;
  user: User;
};

type TwoFactorRequiredLoginResponse = {
  requires_two_factor: true;
  challenge_token: string;
  user: LoginUserPreview;
};

type LoginApiResponse = AuthenticatedLoginResponse | TwoFactorRequiredLoginResponse;

type VerifyTwoFactorInput = {
  code: string;
  recoveryCode: string;
};

type TwoFactorVerificationPayload =
  | { challenge_token: string; code: string }
  | { challenge_token: string; recovery_code: string };

type LoginFlowResult =
  | {
      status: 'authenticated';
      session: AuthenticatedLoginResponse;
    }
  | {
      status: 'two_factor_required';
      challenge: TwoFactorChallenge;
    };

export interface AuthCtx {
  user: User | null;
  loading: boolean;
  twoFactorChallenge: TwoFactorChallenge | null;
  login: (email: string, password: string) => Promise<LoginFlowResult['status']>;
  verifyTwoFactor: (input: VerifyTwoFactorInput) => Promise<void>;
  clearTwoFactorChallenge: () => void;
  logout: () => void;
  hasRole: (...roles: Role[]) => boolean;
  refreshUser: () => Promise<void>;
}

export const AuthContextForTests = createContext<AuthCtx | null>(null);

function isTwoFactorRequiredLoginResponse(response: LoginApiResponse): response is TwoFactorRequiredLoginResponse {
  return 'requires_two_factor' in response && response.requires_two_factor;
}

export function resolveLoginFlow(response: LoginApiResponse): LoginFlowResult {
  if (isTwoFactorRequiredLoginResponse(response)) {
    return {
      status: 'two_factor_required',
      challenge: {
        challengeToken: response.challenge_token,
        user: response.user,
      },
    };
  }

  return {
    status: 'authenticated',
    session: response,
  };
}

export function buildTwoFactorVerificationPayload(
  challengeToken: string,
  input: VerifyTwoFactorInput,
): TwoFactorVerificationPayload {
  const normalizedCode = input.code.replace(/\s+/g, '');
  const normalizedRecoveryCode = input.recoveryCode.trim().toUpperCase();

  if (!normalizedCode && !normalizedRecoveryCode) {
    throw new Error('Un code TOTP ou un code de récupération est requis');
  }

  if (normalizedCode && normalizedRecoveryCode) {
    throw new Error('Utiliser soit un code TOTP, soit un code de récupération');
  }

  if (normalizedCode) {
    return {
      challenge_token: challengeToken,
      code: normalizedCode,
    };
  }

  return {
    challenge_token: challengeToken,
    recovery_code: normalizedRecoveryCode,
  };
}

export function shouldNavigateAfterCredentialStep(challenge: TwoFactorChallenge | null): boolean {
  return challenge === null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [twoFactorChallenge, setTwoFactorChallenge] = useState<TwoFactorChallenge | null>(null);

  const refreshUser = async () => {
    const response = await api<{ user: User }>('/api/auth/me');
    setUser(response.user);
  };

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setLoading(false);
      return;
    }

    refreshUser()
      .catch(() => {
        clearToken();
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = async (email: string, password: string): Promise<LoginFlowResult['status']> => {
    const response = await api<LoginApiResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });

    const result = resolveLoginFlow(response);
    if (result.status === 'authenticated') {
      setToken(result.session.token);
      setUser(result.session.user);
      setTwoFactorChallenge(null);
      return 'authenticated';
    }

    clearToken();
    setUser(null);
    setTwoFactorChallenge(result.challenge);
    return 'two_factor_required';
  };

  const verifyTwoFactor = async (input: VerifyTwoFactorInput) => {
    if (!twoFactorChallenge) {
      throw new Error('Aucune vérification 2FA en attente');
    }

    const response = await api<AuthenticatedLoginResponse>(
      '/api/auth/login/verify-2fa',
      {
        method: 'POST',
        body: JSON.stringify(buildTwoFactorVerificationPayload(twoFactorChallenge.challengeToken, input)),
      },
      { redirectOnUnauthorized: false },
    );

    setToken(response.token);
    setUser(response.user);
    setTwoFactorChallenge(null);
  };

  const clearTwoFactorChallenge = () => {
    setTwoFactorChallenge(null);
  };

  const logout = () => {
    clearToken();
    setUser(null);
    setTwoFactorChallenge(null);
    window.location.href = '/login';
  };

  const hasRole = (...roles: Role[]) => !!user && roles.includes(user.role);

  return (
    <AuthContextForTests.Provider
      value={{
        user,
        loading,
        twoFactorChallenge,
        login,
        verifyTwoFactor,
        clearTwoFactorChallenge,
        logout,
        hasRole,
        refreshUser,
      }}
    >
      {children}
    </AuthContextForTests.Provider>
  );
}

export function useAuth(): AuthCtx {
  const ctx = useContext(AuthContextForTests);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
