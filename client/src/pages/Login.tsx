import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const preset = (e: string, p: string) => {
    setEmail(e);
    setPassword(p);
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>TLPE Manager</h1>
        <div className="brand-sub">Gestion de la Taxe Locale sur la Publicite Exterieure</div>
        {error && <div className="alert error">{error}</div>}
        <form onSubmit={submit} className="form">
          <div>
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="username"
            />
          </div>
          <div>
            <label>Mot de passe</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
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
      </div>
    </div>
  );
}
