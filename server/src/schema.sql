-- TLPE Manager - Schema SQLite
-- Reflete les entites decrites dans les sections 3 a 8 des specifications.

PRAGMA foreign_keys = ON;

-- =====================================================================
-- Utilisateurs et RBAC
-- =====================================================================
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nom           TEXT NOT NULL,
  prenom        TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','gestionnaire','financier','controleur','contribuable')),
  assujetti_id  INTEGER,
  actif         INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (assujetti_id) REFERENCES assujettis(id) ON DELETE SET NULL
);

-- =====================================================================
-- Referentiel : zones tarifaires
-- =====================================================================
CREATE TABLE IF NOT EXISTS zones (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  libelle     TEXT NOT NULL,
  coefficient REAL NOT NULL DEFAULT 1.0,
  description TEXT,
  geometry    TEXT
);
CREATE INDEX IF NOT EXISTS idx_zones_code ON zones(code);

-- =====================================================================
-- Referentiel : types de dispositifs (categories + sous-categories)
-- =====================================================================
CREATE TABLE IF NOT EXISTS types_dispositifs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  libelle    TEXT NOT NULL,
  categorie  TEXT NOT NULL CHECK (categorie IN ('publicitaire','preenseigne','enseigne'))
);

-- =====================================================================
-- Bareme tarifaire (CGCT L2333-7 a L2333-9)
-- Une ligne par annee et par tranche de type/surface.
-- =====================================================================
CREATE TABLE IF NOT EXISTS baremes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  annee           INTEGER NOT NULL,
  categorie       TEXT NOT NULL CHECK (categorie IN ('publicitaire','preenseigne','enseigne')),
  surface_min     REAL NOT NULL DEFAULT 0,
  surface_max     REAL,
  tarif_m2        REAL,
  tarif_fixe      REAL,
  exonere         INTEGER NOT NULL DEFAULT 0,
  libelle         TEXT NOT NULL,
  UNIQUE (annee, categorie, surface_min, surface_max)
);

-- Exonerations et abattements (specs §3.4)
CREATE TABLE IF NOT EXISTS exonerations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL CHECK (type IN ('droit','deliberee','eco')),
  critere     TEXT NOT NULL,
  taux        REAL NOT NULL CHECK (taux >= 0 AND taux <= 1),
  date_debut  TEXT,
  date_fin    TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_exonerations_active_dates ON exonerations(active, date_debut, date_fin);

-- Activation annuelle des baremes (utilisee par le job au 1er janvier)
CREATE TABLE IF NOT EXISTS bareme_activation (
  annee        INTEGER PRIMARY KEY,
  activated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =====================================================================
-- Assujettis
-- =====================================================================
CREATE TABLE IF NOT EXISTS assujettis (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  identifiant_tlpe TEXT NOT NULL UNIQUE,
  raison_sociale   TEXT NOT NULL,
  siret            TEXT UNIQUE,
  forme_juridique  TEXT,
  adresse_rue      TEXT,
  adresse_cp       TEXT,
  adresse_ville    TEXT,
  adresse_pays     TEXT DEFAULT 'France',
  contact_nom      TEXT,
  contact_prenom   TEXT,
  contact_fonction TEXT,
  email            TEXT,
  telephone        TEXT,
  portail_actif    INTEGER NOT NULL DEFAULT 0,
  statut           TEXT NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif','inactif','radie','contentieux')),
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assujettis_siret ON assujettis(siret);
CREATE INDEX IF NOT EXISTS idx_assujettis_raison ON assujettis(raison_sociale);

-- cache API Entreprise (SIRENE)
CREATE TABLE IF NOT EXISTS api_entreprise_cache (
  siret               TEXT PRIMARY KEY,
  raison_sociale      TEXT,
  forme_juridique     TEXT,
  adresse_rue         TEXT,
  adresse_cp          TEXT,
  adresse_ville       TEXT,
  adresse_pays        TEXT,
  est_radie           INTEGER NOT NULL DEFAULT 0 CHECK (est_radie IN (0,1)),
  source_statut       TEXT,
  fetched_at          TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_entreprise_cache_expires_at ON api_entreprise_cache(expires_at);

-- =====================================================================
-- Dispositifs
-- =====================================================================
CREATE TABLE IF NOT EXISTS dispositifs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  identifiant     TEXT NOT NULL UNIQUE,
  assujetti_id    INTEGER NOT NULL,
  type_id         INTEGER NOT NULL,
  zone_id         INTEGER,
  adresse_rue     TEXT,
  adresse_cp      TEXT,
  adresse_ville   TEXT,
  latitude        REAL,
  longitude       REAL,
  surface         REAL NOT NULL,
  nombre_faces    INTEGER NOT NULL DEFAULT 1,
  date_pose       TEXT,
  date_depose     TEXT,
  statut          TEXT NOT NULL DEFAULT 'declare' CHECK (statut IN ('declare','controle','litigieux','depose','exonere')),
  exonere         INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (assujetti_id) REFERENCES assujettis(id) ON DELETE CASCADE,
  FOREIGN KEY (type_id) REFERENCES types_dispositifs(id),
  FOREIGN KEY (zone_id) REFERENCES zones(id)
);
CREATE INDEX IF NOT EXISTS idx_dispositifs_assujetti ON dispositifs(assujetti_id);
CREATE INDEX IF NOT EXISTS idx_dispositifs_statut ON dispositifs(statut);

-- =====================================================================
-- Campagnes declaratives annuelles
-- =====================================================================
CREATE TABLE IF NOT EXISTS campagnes (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  annee                     INTEGER NOT NULL UNIQUE,
  date_ouverture            TEXT NOT NULL,
  date_limite_declaration   TEXT NOT NULL,
  date_cloture              TEXT NOT NULL,
  statut                    TEXT NOT NULL DEFAULT 'brouillon' CHECK (statut IN ('brouillon','ouverte','cloturee')),
  created_by                INTEGER NOT NULL,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_campagnes_statut ON campagnes(statut);

-- =====================================================================
-- Mises en demeure declenchees a la cloture de campagne (US3.5)
-- =====================================================================
CREATE TABLE IF NOT EXISTS mises_en_demeure (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  campagne_id      INTEGER NOT NULL,
  declaration_id   INTEGER NOT NULL UNIQUE,
  statut           TEXT NOT NULL DEFAULT 'a_traiter' CHECK (statut IN ('a_traiter','envoyee','annulee')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (campagne_id) REFERENCES campagnes(id) ON DELETE CASCADE,
  FOREIGN KEY (declaration_id) REFERENCES declarations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mises_en_demeure_campagne ON mises_en_demeure(campagne_id);

-- =====================================================================
-- Jobs techniques lies aux campagnes (invitations/relances)
-- =====================================================================
CREATE TABLE IF NOT EXISTS campagne_jobs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  campagne_id        INTEGER NOT NULL,
  type               TEXT NOT NULL CHECK (type IN ('invitation','relance','cloture')),
  statut             TEXT NOT NULL DEFAULT 'pending' CHECK (statut IN ('pending','done','failed')),
  payload            TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  started_at         TEXT,
  completed_at       TEXT,
  FOREIGN KEY (campagne_id) REFERENCES campagnes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_campagne_jobs_campagne ON campagne_jobs(campagne_id, type, statut);

-- =====================================================================
-- Declarations (annuelles)
-- =====================================================================
CREATE TABLE IF NOT EXISTS declarations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  numero          TEXT NOT NULL UNIQUE,
  assujetti_id    INTEGER NOT NULL,
  annee           INTEGER NOT NULL,
  statut          TEXT NOT NULL DEFAULT 'brouillon' CHECK (statut IN ('brouillon','soumise','validee','rejetee','en_instruction')),
  date_soumission TEXT,
  date_validation TEXT,
  hash_soumission TEXT,
  montant_total   REAL,
  commentaires    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (assujetti_id) REFERENCES assujettis(id) ON DELETE CASCADE,
  UNIQUE (assujetti_id, annee)
);

-- Lignes de declaration : un dispositif declare pour une annee
CREATE TABLE IF NOT EXISTS lignes_declaration (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  declaration_id    INTEGER NOT NULL,
  dispositif_id     INTEGER NOT NULL,
  surface_declaree  REAL NOT NULL,
  nombre_faces      INTEGER NOT NULL DEFAULT 1,
  date_pose         TEXT,
  date_depose       TEXT,
  -- detail de calcul archive (immuable apres emission du titre)
  bareme_id         INTEGER,
  tarif_applique    REAL,
  coefficient_zone  REAL,
  prorata           REAL,
  montant_ligne     REAL,
  FOREIGN KEY (declaration_id) REFERENCES declarations(id) ON DELETE CASCADE,
  FOREIGN KEY (dispositif_id) REFERENCES dispositifs(id),
  FOREIGN KEY (bareme_id) REFERENCES baremes(id)
);

-- =====================================================================
-- Titres de recettes
-- =====================================================================
CREATE TABLE IF NOT EXISTS titres (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  numero          TEXT NOT NULL UNIQUE,
  declaration_id  INTEGER NOT NULL UNIQUE,
  assujetti_id    INTEGER NOT NULL,
  annee           INTEGER NOT NULL,
  montant         REAL NOT NULL,
  date_emission   TEXT NOT NULL,
  date_echeance   TEXT NOT NULL,
  statut          TEXT NOT NULL DEFAULT 'emis' CHECK (statut IN ('emis','paye_partiel','paye','impaye','mise_en_demeure','admis_en_non_valeur')),
  montant_paye    REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (declaration_id) REFERENCES declarations(id),
  FOREIGN KEY (assujetti_id) REFERENCES assujettis(id)
);

-- =====================================================================
-- Paiements
-- =====================================================================
CREATE TABLE IF NOT EXISTS paiements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  titre_id    INTEGER NOT NULL,
  montant     REAL NOT NULL,
  date_paiement TEXT NOT NULL,
  modalite    TEXT NOT NULL CHECK (modalite IN ('virement','cheque','tipi','sepa','numeraire')),
  reference   TEXT,
  commentaire TEXT,
  FOREIGN KEY (titre_id) REFERENCES titres(id) ON DELETE CASCADE
);

-- =====================================================================
-- Contentieux
-- =====================================================================
CREATE TABLE IF NOT EXISTS contentieux (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  numero          TEXT NOT NULL UNIQUE,
  assujetti_id    INTEGER NOT NULL,
  titre_id        INTEGER,
  type            TEXT NOT NULL CHECK (type IN ('gracieux','contentieux','moratoire','controle')),
  montant_litige  REAL,
  date_ouverture  TEXT NOT NULL DEFAULT (date('now')),
  date_cloture    TEXT,
  statut          TEXT NOT NULL DEFAULT 'ouvert' CHECK (statut IN ('ouvert','instruction','clos_maintenu','degrevement_partiel','degrevement_total','non_lieu')),
  description     TEXT,
  decision        TEXT,
  FOREIGN KEY (assujetti_id) REFERENCES assujettis(id),
  FOREIGN KEY (titre_id) REFERENCES titres(id)
);

-- =====================================================================
-- Pieces jointes
-- =====================================================================
CREATE TABLE IF NOT EXISTS pieces_jointes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entite        TEXT NOT NULL CHECK (entite IN ('dispositif','declaration','contentieux')),
  entite_id     INTEGER NOT NULL,
  nom           TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  taille        INTEGER NOT NULL CHECK (taille > 0),
  chemin        TEXT NOT NULL,
  uploaded_by   INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at    TEXT,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_pieces_jointes_entite ON pieces_jointes(entite, entite_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_pieces_jointes_uploaded_by ON pieces_jointes(uploaded_by);

-- =====================================================================
-- Audit log (traçabilite cf. section 12.2)
-- =====================================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
  action      TEXT NOT NULL,
  entite      TEXT NOT NULL,
  entite_id   INTEGER,
  details     TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_audit_entite ON audit_log(entite, entite_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
