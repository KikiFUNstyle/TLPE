import { useMemo, useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { shouldNavigateAfterCredentialStep, useAuth } from '../auth';

export default function Login() {
  const { login, twoFactorChallenge, verifyTwoFactor, clearTwoFactorChallenge } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isTwoFactorStep = twoFactorChallenge !== null;
  const challengeLabel = useMemo(() => {
    if (!twoFactorChallenge) return null;
    return `${twoFactorChallenge.user.prenom} ${twoFactorChallenge.user.nom} — ${twoFactorChallenge.user.email}`;
  }, [twoFactorChallenge]);

  const submitCredentials = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const loginStatus = await login(email, password);
      if (loginStatus === 'authenticated' && shouldNavigateAfterCredentialStep(null)) {
        navigate('/', { replace: true });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const submitTwoFactor = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await verifyTwoFactor({ code: twoFactorCode, recoveryCode });
      setTwoFactorCode('');
      setRecoveryCode('');
      navigate('/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const backToCredentials = () => {
    clearTwoFactorChallenge();
    setTwoFactorCode('');
    setRecoveryCode('');
    setError(null);
  };

  const preset = (nextEmail: string, nextPassword: string) => {
    setEmail(nextEmail);
    setPassword(nextPassword);
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>TLPE Manager</h1>
        <div className="brand-sub">Gestion de la Taxe Locale sur la Publicite Exterieure</div>
        {error && <div className="alert error">{error}</div>}

        {!isTwoFactorStep ? (
          <>
            <form onSubmit={submitCredentials} className="form">
              <div>
                <label>Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoComplete="username"
                />
              </div>
              <div>
                <label>Mot de passe</label>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  autoComplete="current-password"
                />
              </div>
              <button className="btn" type="submit" disabled={loading}>
                {loading ? 'Connexion...' : 'Se connecter'}
              </button>
            </form>
            <div className="demo">
              <strong>Comptes de demonstration :</strong>
              <ul>
                <li><a onClick={() => preset('admin@tlpe.local', 'admin123')}>admin@tlpe.local</a> (administrateur)</li>
                <li><a onClick={() => preset('gestionnaire@tlpe.local', 'gestion123')}>gestionnaire@tlpe.local</a> (gestionnaire)</li>
                <li><a onClick={() => preset('financier@tlpe.local', 'finance123')}>financier@tlpe.local</a> (financier)</li>
                <li><a onClick={() => preset('controleur@tlpe.local', 'controle123')}>controleur@tlpe.local</a> (controleur)</li>
                <li><a onClick={() => preset('contribuable@tlpe.local', 'contrib123')}>contribuable@tlpe.local</a> (contribuable)</li>
              </ul>
            </div>
          </>
        ) : (
          <>
            <div className="alert info">
              <strong>Double authentification requise.</strong>
              <div className="login-two-factor-meta">Compte concerné : {challengeLabel}</div>
            </div>
            <form onSubmit={submitTwoFactor} className="form">
              <div>
                <label>Code TOTP</label>
                <input
                  type="text"
                  value={twoFactorCode}
                  onChange={(event) => setTwoFactorCode(event.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                />
                <div className="hint">Saisissez le code généré par votre application d’authentification.</div>
              </div>
              <div className="login-two-factor-divider">ou utilisez un code de récupération</div>
              <div>
                <label>Code de récupération</label>
                <input
                  type="text"
                  value={recoveryCode}
                  onChange={(event) => setRecoveryCode(event.target.value)}
                  autoComplete="off"
                  placeholder="ABCD-EFGH-IJKL"
                />
                <div className="hint">Les codes de récupération sont à usage unique.</div>
              </div>
              <div className="login-two-factor-actions">
                <button className="btn" type="submit" disabled={loading}>
                  {loading ? 'Vérification...' : 'Valider la double authentification'}
                </button>
                <button className="btn secondary" type="button" disabled={loading} onClick={backToCredentials}>
                  Retour à la connexion
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
