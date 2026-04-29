import { FormEvent } from 'react';
import { api } from '../api';
import { useAuth, type User } from '../auth';
import { useEffect, useState } from 'react';

export interface TwoFactorStatusResponse {
  enabled: boolean;
  recovery_codes_remaining: number;
}

export interface TwoFactorSetupResponse {
  secret: string;
  otpauth_url: string;
  qr_code_data_url: string;
}

export type StatusMessageType = 'success' | 'error' | 'info';

type EnableTwoFactorResponse = {
  enabled: true;
  recovery_codes: string[];
};

type DisableTwoFactorResponse = {
  enabled: false;
};

async function copyTextToClipboard(value: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function AccountSettingsTwoFactorPanel(props: {
  user: User;
  status: TwoFactorStatusResponse | null;
  statusLoading: boolean;
  setupLoading: boolean;
  actionLoading: boolean;
  setup: TwoFactorSetupResponse | null;
  verificationCode: string;
  disableCode: string;
  statusMessage: string | null;
  statusMessageType: StatusMessageType;
  recoveryCodes: string[];
  onVerificationCodeChange: (value: string) => void;
  onDisableCodeChange: (value: string) => void;
  onStartSetup: () => void;
  onEnable: (event: FormEvent<HTMLFormElement>) => void;
  onDisable: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const {
    user,
    status,
    statusLoading,
    setupLoading,
    actionLoading,
    setup,
    verificationCode,
    disableCode,
    statusMessage,
    statusMessageType,
    recoveryCodes,
    onVerificationCodeChange,
    onDisableCodeChange,
    onStartSetup,
    onEnable,
    onDisable,
  } = props;

  const enabled = status?.enabled === true;
  const recoveryCodesRemaining = status?.recovery_codes_remaining ?? 0;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Paramètres du compte</h1>
          <p>Gérez la sécurité du portail contribuable et activez la double authentification TOTP.</p>
        </div>
      </div>

      {statusMessage && <div className={`alert ${statusMessageType}`}>{statusMessage}</div>}

      <div className="grid cols-2">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Compte</h3>
          <div style={{ lineHeight: 1.8, fontSize: 14 }}>
            <div><strong>Nom :</strong> {user.prenom} {user.nom}</div>
            <div><strong>Email :</strong> {user.email}</div>
            <div><strong>Rôle :</strong> {user.role}</div>
          </div>
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Double authentification (2FA)</h3>
          {statusLoading ? (
            <div className="empty" style={{ padding: 24 }}>Chargement du statut 2FA...</div>
          ) : enabled ? (
            <>
              <div className="alert success">
                <strong>2FA active.</strong>
                <div>Codes de récupération restants : {recoveryCodesRemaining}</div>
              </div>
              <form className="form" onSubmit={onDisable}>
                <div>
                  <label>Confirmez avec un code TOTP</label>
                  <input
                    type="text"
                    value={disableCode}
                    onChange={(event) => onDisableCodeChange(event.target.value)}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123456"
                  />
                  <div className="hint">La désactivation exige une confirmation par code généré dans votre application.</div>
                </div>
                <div className="actions">
                  <button type="submit" className="btn danger" disabled={actionLoading}>
                    {actionLoading ? 'Désactivation...' : 'Désactiver la double authentification'}
                  </button>
                </div>
              </form>
            </>
          ) : (
            <>
              <div className="alert info">
                <strong>2FA inactive.</strong>
                <div>Activez-la pour sécuriser vos connexions avec Google Authenticator, 1Password ou équivalent.</div>
              </div>
              <button type="button" className="btn" onClick={onStartSetup} disabled={setupLoading || actionLoading}>
                {setupLoading ? 'Préparation...' : setup ? 'Régénérer le QR code' : 'Configurer la double authentification'}
              </button>
              {!setup && <div className="hint" style={{ marginTop: 12 }}>Un QR code et 10 codes de récupération seront générés après préparation.</div>}
            </>
          )}
        </div>
      </div>

      {!enabled && setup && (
        <div className="grid cols-2" style={{ marginTop: 24 }}>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Étape 1 — Scanner le QR code</h3>
            <p style={{ marginTop: 0 }}>
              Ouvrez votre application d’authentification et ajoutez un compte via scan QR code.
            </p>
            <div className="account-settings-qr-wrapper">
              <img
                src={setup.qr_code_data_url}
                alt="QR code pour activer la double authentification TOTP"
                className="account-settings-qr"
              />
            </div>
            <div className="hint">En cas d’impossibilité de scan, utilisez le secret manuel ci-dessous.</div>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Étape 2 — Confirmer l’activation</h3>
            <div className="account-settings-secret-block">
              <div className="account-settings-secret-label">Secret TOTP manuel</div>
              <code>{setup.secret}</code>
            </div>
            <form className="form" onSubmit={onEnable}>
              <div>
                <label>Code TOTP à 6 chiffres</label>
                <input
                  type="text"
                  value={verificationCode}
                  onChange={(event) => onVerificationCodeChange(event.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                />
                <div className="hint">Entrez le code affiché par votre application pour activer définitivement la 2FA.</div>
              </div>
              <div className="actions">
                <button type="submit" className="btn success" disabled={actionLoading}>
                  {actionLoading ? 'Activation...' : 'Activer la double authentification'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {recoveryCodes.length > 0 && (
        <div className="card" style={{ marginTop: 24 }}>
          <h3 style={{ marginTop: 0 }}>Codes de récupération</h3>
          <p style={{ marginTop: 0 }}>
            Conservez ces 10 codes hors ligne. Chaque code est à usage unique et permet de vous connecter si vous perdez votre application TOTP.
          </p>
          <div className="account-settings-recovery-grid">
            {recoveryCodes.map((code) => (
              <code key={code}>{code}</code>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export default function AccountSettings() {
  const { user, refreshUser } = useAuth();
  const [status, setStatus] = useState<TwoFactorStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [setupLoading, setSetupLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [setup, setSetup] = useState<TwoFactorSetupResponse | null>(null);
  const [verificationCode, setVerificationCode] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusMessageType, setStatusMessageType] = useState<StatusMessageType>('info');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;

    const loadStatus = async () => {
      setStatusLoading(true);
      try {
        const next = await api<TwoFactorStatusResponse>('/api/auth/2fa/status');
        if (!cancelled) {
          setStatus(next);
        }
      } catch (error) {
        if (!cancelled) {
          setStatusMessageType('error');
          setStatusMessage((error as Error).message);
        }
      } finally {
        if (!cancelled) {
          setStatusLoading(false);
        }
      }
    };

    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!user) {
    return <div className="empty">Utilisateur introuvable.</div>;
  }

  const refreshStatus = async () => {
    const next = await api<TwoFactorStatusResponse>('/api/auth/2fa/status');
    setStatus(next);
    return next;
  };

  const handleStartSetup = async () => {
    setSetupLoading(true);
    setStatusMessage(null);
    setRecoveryCodes([]);
    try {
      const next = await api<TwoFactorSetupResponse>('/api/auth/2fa/setup', { method: 'POST' });
      setSetup(next);
      setVerificationCode('');
      const copied = await copyTextToClipboard(next.secret);
      setStatusMessageType('info');
      setStatusMessage(
        copied
          ? 'Secret TOTP copié dans le presse-papiers. Scannez le QR code puis confirmez avec un code à 6 chiffres.'
          : 'Scannez le QR code puis confirmez avec un code à 6 chiffres.',
      );
    } catch (error) {
      setStatusMessageType('error');
      setStatusMessage((error as Error).message);
    } finally {
      setSetupLoading(false);
    }
  };

  const handleEnable = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setActionLoading(true);
    setStatusMessage(null);
    try {
      const response = await api<EnableTwoFactorResponse>('/api/auth/2fa/enable', {
        method: 'POST',
        body: JSON.stringify({ code: verificationCode }),
      });
      setRecoveryCodes(response.recovery_codes);
      setSetup(null);
      setVerificationCode('');
      await refreshStatus();
      await refreshUser();
      setStatusMessageType('success');
      setStatusMessage('Double authentification activée. Enregistrez vos codes de récupération.');
    } catch (error) {
      setStatusMessageType('error');
      setStatusMessage((error as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDisable = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setActionLoading(true);
    setStatusMessage(null);
    try {
      await api<DisableTwoFactorResponse>('/api/auth/2fa/disable', {
        method: 'POST',
        body: JSON.stringify({ code: disableCode }),
      });
      setDisableCode('');
      setSetup(null);
      setRecoveryCodes([]);
      await refreshStatus();
      await refreshUser();
      setStatusMessageType('success');
      setStatusMessage('Double authentification désactivée.');
    } catch (error) {
      setStatusMessageType('error');
      setStatusMessage((error as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <AccountSettingsTwoFactorPanel
      user={user}
      status={status}
      statusLoading={statusLoading}
      setupLoading={setupLoading}
      actionLoading={actionLoading}
      setup={setup}
      verificationCode={verificationCode}
      disableCode={disableCode}
      statusMessage={statusMessage}
      statusMessageType={statusMessageType}
      recoveryCodes={recoveryCodes}
      onVerificationCodeChange={setVerificationCode}
      onDisableCodeChange={setDisableCode}
      onStartSetup={handleStartSetup}
      onEnable={handleEnable}
      onDisable={handleDisable}
    />
  );
}
