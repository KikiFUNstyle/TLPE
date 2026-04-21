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

interface AuthCtx {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  hasRole: (...roles: Role[]) => boolean;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setLoading(false);
      return;
    }
    api<{ user: User }>('/api/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => clearToken())
      .finally(() => setLoading(false));
  }, []);

  const login = async (email: string, password: string) => {
    const res = await api<{ token: string; user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setToken(res.token);
    setUser(res.user);
  };

  const logout = () => {
    clearToken();
    setUser(null);
    window.location.href = '/login';
  };

  const hasRole = (...roles: Role[]) => !!user && roles.includes(user.role);

  return (
    <Ctx.Provider value={{ user, loading, login, logout, hasRole }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
