import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Assujettis from './pages/Assujettis';
import AssujettiDetail from './pages/AssujettiDetail';
import Dispositifs from './pages/Dispositifs';
import Declarations from './pages/Declarations';
import DeclarationDetail from './pages/DeclarationDetail';
import Simulateur from './pages/Simulateur';
import Titres from './pages/Titres';
import Referentiels from './pages/Referentiels';
import Contentieux from './pages/Contentieux';
import Carte from './pages/Carte';
import DeclarationReceiptVerify from './pages/DeclarationReceiptVerify';
import { PayfipConfirmationPage } from './pages/PayfipConfirmationPage';
import Controles from './pages/Controles';
import Rapprochement from './pages/Rapprochement';
import Recouvrement from './pages/Recouvrement';
import Relances from './pages/Relances';

export default function App() {
  const { user, loading, logout } = useAuth();

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center' }}>Chargement...</div>;
  }

  if (!user) {
    return (
      <main className="main" style={{ padding: 24 }}>
        <Routes>
          <Route path="/verification/accuse/:token" element={<DeclarationReceiptVerify />} />
          <Route path="/paiement/confirmation" element={<PayfipConfirmationPage />} />
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </main>
    );
  }

  const isContribuable = user.role === 'contribuable';
  const canAccessRapprochement = user.role === 'admin' || user.role === 'financier';
  const canAccessRecouvrement = user.role === 'admin' || user.role === 'financier';
  const canAccessRelances = user.role === 'admin' || user.role === 'gestionnaire';
  const canAccessControles = user.role === 'admin' || user.role === 'gestionnaire' || user.role === 'controleur';

  return (
    <div className="app">
      <header className="header">
        <div className="brand">TLPE Manager</div>
        <div className="brand-sub">Taxe Locale sur la Publicite Exterieure</div>
        <div className="spacer" />
        <div className="user-info">
          {user.prenom} {user.nom}
          <span className="role">{user.role}</span>
        </div>
        <button onClick={logout}>Deconnexion</button>
      </header>

      <aside className="sidebar">
        <nav>
          <NavLink to="/" end>Tableau de bord</NavLink>
          {!isContribuable && (
            <>
              <div className="section-title">Gestion</div>
              <NavLink to="/assujettis">Assujettis</NavLink>
              <NavLink to="/dispositifs">Dispositifs</NavLink>
              <NavLink to="/declarations">Declarations</NavLink>
              <NavLink to="/titres">Titres de recettes</NavLink>
              {canAccessRapprochement && <NavLink to="/rapprochement">Rapprochement bancaire</NavLink>}
              {canAccessRecouvrement && <NavLink to="/recouvrement">État de recouvrement</NavLink>}
              {canAccessRelances && <NavLink to="/relances">Suivi des relances</NavLink>}
              <NavLink to="/contentieux">Contentieux</NavLink>
              {canAccessControles && <NavLink to="/controles">Contrôles terrain</NavLink>}
              <NavLink to="/carte">Carte des dispositifs</NavLink>
            </>
          )}
          {isContribuable && (
            <>
              <div className="section-title">Espace contribuable</div>
              <NavLink to="/declarations">Mes declarations</NavLink>
              <NavLink to="/titres">Mes titres</NavLink>
              <NavLink to="/contentieux">Mes reclamations</NavLink>
              <NavLink to="/carte">Carte des dispositifs</NavLink>
            </>
          )}
          <div className="section-title">Outils</div>
          <NavLink to="/simulateur">Simulateur</NavLink>
          {(user.role === 'admin' || user.role === 'gestionnaire') && (
            <NavLink to="/referentiels">Referentiels</NavLink>
          )}
        </nav>
      </aside>

      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/assujettis" element={<Assujettis />} />
          <Route path="/assujettis/:id" element={<AssujettiDetail />} />
          <Route path="/dispositifs" element={<Dispositifs />} />
          <Route path="/declarations" element={<Declarations />} />
          <Route path="/declarations/:id" element={<DeclarationDetail />} />
          <Route path="/titres" element={<Titres />} />
          <Route path="/rapprochement" element={canAccessRapprochement ? <Rapprochement /> : <Navigate to="/" replace />} />
          <Route path="/recouvrement" element={canAccessRecouvrement ? <Recouvrement /> : <Navigate to="/" replace />} />
          <Route path="/relances" element={canAccessRelances ? <Relances /> : <Navigate to="/" replace />} />
          <Route path="/contentieux" element={<Contentieux />} />
          <Route path="/controles" element={canAccessControles ? <Controles /> : <Navigate to="/" replace />} />
          <Route path="/carte" element={<Carte />} />
          <Route path="/simulateur" element={<Simulateur />} />
          <Route path="/referentiels" element={<Referentiels />} />
          <Route path="/verification/accuse/:token" element={<DeclarationReceiptVerify />} />
          <Route path="/paiement/confirmation" element={<PayfipConfirmationPage />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<div className="empty">Page introuvable</div>} />
        </Routes>
      </main>
    </div>
  );
}
