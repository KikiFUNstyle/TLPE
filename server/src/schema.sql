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
  relance_j7_courrier       INTEGER NOT NULL DEFAULT 0 CHECK (relance_j7_courrier IN (0,1)),
  created_by                INTEGER NOT NULL,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_campagnes_statut ON campagnes(statut);

-- =====================================================================
-- Invitations et notifications email de campagne (US3.2 / US11.3)
-- =====================================================================
CREATE TABLE IF NOT EXISTS invitation_magic_links (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  campagne_id      INTEGER NOT NULL,
  assujetti_id     INTEGER NOT NULL,
  token            TEXT NOT NULL UNIQUE,
  expires_at       TEXT NOT NULL,
  used_at          TEXT,
  created_by       INTEGER,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (campagne_id) REFERENCES campagnes(id) ON DELETE CASCADE,
  FOREIGN KEY (assujetti_id) REFERENCES assujettis(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_magic_links_campaign_assujetti ON invitation_magic_links(campagne_id, assujetti_id);

CREATE TABLE IF NOT EXISTS notifications_email (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  campagne_id         INTEGER,
  assujetti_id        INTEGER NOT NULL,
  email_destinataire  TEXT NOT NULL,
  objet               TEXT NOT NULL,
  corps               TEXT NOT NULL,
  template_code       TEXT NOT NULL DEFAULT 'invitation_campagne',
  relance_niveau      TEXT CHECK (relance_niveau IN ('J-30','J-15','J-7','depasse')),
  piece_jointe_path   TEXT,
  magic_link          TEXT,
  mode                TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto','manual')),
  statut              TEXT NOT NULL DEFAULT 'envoye' CHECK (statut IN ('pending','envoye','echec')),
  erreur              TEXT,
  sent_at             TEXT,
  created_by          INTEGER,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (campagne_id) REFERENCES campagnes(id) ON DELETE CASCADE,
  FOREIGN KEY (assujetti_id) REFERENCES assujettis(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_email_campagne ON notifications_email(campagne_id, assujetti_id);
CREATE INDEX IF NOT EXISTS idx_notifications_email_statut ON notifications_email(statut, sent_at);

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
  alerte_gestionnaire INTEGER NOT NULL DEFAULT 0,
  montant_total   REAL,
  commentaires    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (assujetti_id) REFERENCES assujettis(id) ON DELETE CASCADE,
  UNIQUE (assujetti_id, annee)
);

CREATE TABLE IF NOT EXISTS declaration_sequences (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  annee            INTEGER NOT NULL,
  numero_ordre     INTEGER NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (annee, numero_ordre)
);

-- Accuse de reception de soumission (US3.6)
CREATE TABLE IF NOT EXISTS declaration_receipts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  declaration_id      INTEGER NOT NULL UNIQUE,
  verification_token  TEXT NOT NULL UNIQUE,
  payload_hash        TEXT NOT NULL,
  pdf_path            TEXT NOT NULL,
  generated_by        INTEGER,
  generated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  email_status        TEXT NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending','envoye','echec')),
  email_error         TEXT,
  email_sent_at       TEXT,
  FOREIGN KEY (declaration_id) REFERENCES declarations(id) ON DELETE CASCADE,
  FOREIGN KEY (generated_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_declaration_receipts_generated_at ON declaration_receipts(generated_at);

-- Lignes de declaration : un dispositif declare pour une annee
CREATE TABLE IF NOT EXISTS lignes_declaration (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  declaration_id    INTEGER NOT NULL,
  dispositif_id     INTEGER NOT NULL,
  surface_declaree  REAL NOT NULL,
  nombre_faces      INTEGER NOT NULL DEFAULT 1,
  quote_part        REAL NOT NULL DEFAULT 1.0 CHECK (quote_part >= 0 AND quote_part <= 1),
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
  statut          TEXT NOT NULL DEFAULT 'emis' CHECK (statut IN ('emis','paye_partiel','paye','impaye','mise_en_demeure','transmis_comptable','admis_en_non_valeur')),
  montant_paye    REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (declaration_id) REFERENCES declarations(id),
  FOREIGN KEY (assujetti_id) REFERENCES assujettis(id)
);

CREATE TABLE IF NOT EXISTS titres_executoires (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  titre_id              INTEGER NOT NULL UNIQUE,
  numero_flux           INTEGER NOT NULL UNIQUE,
  xml_filename          TEXT NOT NULL,
  xml_content           TEXT NOT NULL,
  xml_hash              TEXT NOT NULL,
  mention_signature     TEXT NOT NULL,
  xsd_validation_ok     INTEGER NOT NULL DEFAULT 0 CHECK (xsd_validation_ok IN (0,1)),
  xsd_validation_report TEXT,
  transmitted_at        TEXT NOT NULL DEFAULT (datetime('now')),
  transmitted_by        INTEGER,
  FOREIGN KEY (titre_id) REFERENCES titres(id) ON DELETE CASCADE,
  FOREIGN KEY (transmitted_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_titres_executoires_transmitted_at ON titres_executoires(transmitted_at DESC);

-- Exports comptables PESV2 Hélios (US5.2)
CREATE TABLE IF NOT EXISTS pesv2_exports (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  numero_bordereau      INTEGER NOT NULL UNIQUE,
  selection_type        TEXT NOT NULL CHECK (selection_type IN ('campagne','periode')),
  campagne_id           INTEGER,
  date_debut            TEXT,
  date_fin              TEXT,
  exported_at           TEXT NOT NULL DEFAULT (datetime('now')),
  exported_by           INTEGER,
  filename              TEXT NOT NULL,
  xml_hash              TEXT NOT NULL,
  xsd_validation_ok     INTEGER NOT NULL DEFAULT 0 CHECK (xsd_validation_ok IN (0,1)),
  xsd_validation_report TEXT,
  titres_count          INTEGER NOT NULL DEFAULT 0,
  total_montant         REAL NOT NULL DEFAULT 0,
  confirmation_reexport INTEGER NOT NULL DEFAULT 0 CHECK (confirmation_reexport IN (0,1)),
  CHECK (
    (selection_type = 'campagne' AND campagne_id IS NOT NULL AND date_debut IS NULL AND date_fin IS NULL)
    OR
    (selection_type = 'periode' AND campagne_id IS NULL AND date_debut IS NOT NULL AND date_fin IS NOT NULL AND date_debut <= date_fin)
  ),
  FOREIGN KEY (campagne_id) REFERENCES campagnes(id) ON DELETE RESTRICT,
  FOREIGN KEY (exported_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_pesv2_exports_selection ON pesv2_exports(selection_type, campagne_id, date_debut, date_fin);

CREATE TABLE IF NOT EXISTS pesv2_export_titres (
  export_id    INTEGER NOT NULL,
  titre_id     INTEGER NOT NULL,
  exported_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (export_id, titre_id),
  FOREIGN KEY (export_id) REFERENCES pesv2_exports(id) ON DELETE CASCADE,
  FOREIGN KEY (titre_id) REFERENCES titres(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pesv2_export_titres_titre ON pesv2_export_titres(titre_id);

-- =====================================================================
-- Mandats SEPA et exports pain.008 (US5.4)
-- =====================================================================
CREATE TABLE IF NOT EXISTS mandats_sepa (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  assujetti_id     INTEGER NOT NULL,
  rum              TEXT NOT NULL UNIQUE,
  iban             TEXT NOT NULL,
  bic              TEXT NOT NULL,
  date_signature   TEXT NOT NULL,
  statut           TEXT NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif','revoque')),
  date_revocation  TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (assujetti_id) REFERENCES assujettis(id) ON DELETE CASCADE,
  CHECK ((statut = 'actif' AND date_revocation IS NULL) OR (statut = 'revoque' AND date_revocation IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_mandats_sepa_assujetti ON mandats_sepa(assujetti_id, statut);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mandats_sepa_one_active_per_assujetti
  ON mandats_sepa(assujetti_id)
  WHERE statut = 'actif';

CREATE TABLE IF NOT EXISTS sepa_exports (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  numero_lot            INTEGER NOT NULL UNIQUE,
  date_reference        TEXT NOT NULL,
  date_prelevement      TEXT NOT NULL,
  exported_at           TEXT NOT NULL DEFAULT (datetime('now')),
  exported_by           INTEGER,
  filename              TEXT NOT NULL,
  xml_hash              TEXT NOT NULL,
  xsd_validation_ok     INTEGER NOT NULL DEFAULT 0 CHECK (xsd_validation_ok IN (0,1)),
  xsd_validation_report TEXT,
  ordres_count          INTEGER NOT NULL DEFAULT 0,
  total_montant         REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (exported_by) REFERENCES users(id) ON DELETE SET NULL,
  CHECK (date_reference <= date_prelevement)
);
CREATE INDEX IF NOT EXISTS idx_sepa_exports_dates ON sepa_exports(date_reference, date_prelevement);

CREATE TABLE IF NOT EXISTS sepa_prelevements (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  mandat_id         INTEGER NOT NULL,
  titre_id          INTEGER NOT NULL UNIQUE,
  montant           REAL NOT NULL CHECK (montant > 0),
  sequence_type     TEXT NOT NULL CHECK (sequence_type IN ('FRST','RCUR')),
  date_prelevement  TEXT NOT NULL,
  statut            TEXT NOT NULL DEFAULT 'genere' CHECK (statut IN ('genere','exporte','annule')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (mandat_id) REFERENCES mandats_sepa(id) ON DELETE CASCADE,
  FOREIGN KEY (titre_id) REFERENCES titres(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sepa_prelevements_mandat ON sepa_prelevements(mandat_id, statut, date_prelevement);
CREATE INDEX IF NOT EXISTS idx_sepa_prelevements_date ON sepa_prelevements(date_prelevement, statut);

CREATE TABLE IF NOT EXISTS sepa_export_items (
  export_id       INTEGER NOT NULL,
  prelevement_id  INTEGER NOT NULL,
  exported_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (export_id, prelevement_id),
  FOREIGN KEY (export_id) REFERENCES sepa_exports(id) ON DELETE CASCADE,
  FOREIGN KEY (prelevement_id) REFERENCES sepa_prelevements(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sepa_export_items_prelevement ON sepa_export_items(prelevement_id);

-- =====================================================================
-- Paiements
-- =====================================================================
CREATE TABLE IF NOT EXISTS paiements (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  titre_id         INTEGER NOT NULL,
  montant          REAL NOT NULL,
  date_paiement    TEXT NOT NULL,
  modalite         TEXT NOT NULL CHECK (modalite IN ('virement','cheque','tipi','sepa','numeraire')),
  reference        TEXT,
  commentaire      TEXT,
  provider         TEXT NOT NULL DEFAULT 'manuel' CHECK (provider IN ('manuel','payfip')),
  statut           TEXT NOT NULL DEFAULT 'confirme' CHECK (statut IN ('confirme','annule','refuse','en_attente')),
  transaction_id   TEXT UNIQUE,
  callback_payload TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (titre_id) REFERENCES titres(id) ON DELETE CASCADE
);

-- =====================================================================
-- Rapprochement bancaire / relevés importés
-- =====================================================================
CREATE TABLE IF NOT EXISTS releves_bancaires (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  format           TEXT NOT NULL CHECK (format IN ('csv','ofx','mt940')),
  fichier_nom      TEXT NOT NULL,
  compte_bancaire  TEXT,
  date_debut       TEXT,
  date_fin         TEXT,
  imported_at      TEXT NOT NULL DEFAULT (datetime('now')),
  imported_by      INTEGER,
  FOREIGN KEY (imported_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_releves_bancaires_imported_at ON releves_bancaires(imported_at DESC);

CREATE TABLE IF NOT EXISTS lignes_releve (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  releve_id        INTEGER NOT NULL,
  date             TEXT NOT NULL,
  libelle          TEXT NOT NULL,
  montant          REAL NOT NULL,
  reference        TEXT,
  transaction_id   TEXT NOT NULL UNIQUE,
  rapproche        INTEGER NOT NULL DEFAULT 0 CHECK (rapproche IN (0,1)),
  paiement_id      INTEGER,
  raw_data         TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (releve_id) REFERENCES releves_bancaires(id) ON DELETE CASCADE,
  FOREIGN KEY (paiement_id) REFERENCES paiements(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_lignes_releve_releve ON lignes_releve(releve_id);
CREATE INDEX IF NOT EXISTS idx_lignes_releve_rapproche ON lignes_releve(rapproche, date DESC);
CREATE INDEX IF NOT EXISTS idx_lignes_releve_paiement ON lignes_releve(paiement_id);

CREATE TABLE IF NOT EXISTS rapprochements_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ligne_releve_id  INTEGER NOT NULL,
  titre_id         INTEGER,
  paiement_id      INTEGER,
  mode             TEXT NOT NULL CHECK (mode IN ('auto','manuel')),
  resultat         TEXT NOT NULL CHECK (resultat IN ('rapproche','partiel','excedentaire','erreur_reference','errone')),
  commentaire      TEXT,
  user_id          INTEGER,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (ligne_releve_id) REFERENCES lignes_releve(id) ON DELETE CASCADE,
  FOREIGN KEY (titre_id) REFERENCES titres(id) ON DELETE SET NULL,
  FOREIGN KEY (paiement_id) REFERENCES paiements(id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_rapprochements_log_ligne ON rapprochements_log(ligne_releve_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rapprochements_log_created_at ON rapprochements_log(created_at DESC, id DESC);

-- =====================================================================
-- Recouvrement des impayés / historique par titre
-- =====================================================================
CREATE TABLE IF NOT EXISTS recouvrement_actions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  titre_id           INTEGER NOT NULL,
  niveau             TEXT NOT NULL CHECK (niveau IN ('J+10','J+30','J+60','retour_comptable')),
  action_type        TEXT NOT NULL CHECK (action_type IN ('rappel_email','mise_en_demeure','transmission_comptable','admission_non_valeur')),
  statut             TEXT NOT NULL CHECK (statut IN ('pending','envoye','echec','transmis','classe')),
  email_destinataire TEXT,
  piece_jointe_path  TEXT,
  details            TEXT,
  created_by         INTEGER,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (titre_id) REFERENCES titres(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (titre_id, niveau, action_type)
);
CREATE INDEX IF NOT EXISTS idx_recouvrement_actions_titre ON recouvrement_actions(titre_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_recouvrement_actions_niveau ON recouvrement_actions(niveau, statut, created_at DESC);

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
  date_limite_reponse TEXT,
  date_limite_reponse_initiale TEXT,
  delai_prolonge_justification TEXT,
  delai_prolonge_par INTEGER,
  delai_prolonge_at TEXT,
  date_cloture    TEXT,
  statut          TEXT NOT NULL DEFAULT 'ouvert' CHECK (statut IN ('ouvert','instruction','clos_maintenu','degrevement_partiel','degrevement_total','non_lieu')),
  description     TEXT,
  decision        TEXT,
  FOREIGN KEY (assujetti_id) REFERENCES assujettis(id),
  FOREIGN KEY (titre_id) REFERENCES titres(id),
  FOREIGN KEY (delai_prolonge_par) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS contentieux_sequences (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  annee            INTEGER NOT NULL,
  numero_ordre     INTEGER NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (annee, numero_ordre)
);

CREATE TABLE IF NOT EXISTS contentieux_alerts (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  contentieux_id           INTEGER NOT NULL,
  assujetti_id             INTEGER NOT NULL,
  niveau_alerte            TEXT NOT NULL CHECK (niveau_alerte IN ('J-30','J-7','depasse')),
  date_reference           TEXT NOT NULL,
  date_echeance            TEXT NOT NULL,
  days_remaining           INTEGER NOT NULL,
  overdue                  INTEGER NOT NULL DEFAULT 0 CHECK (overdue IN (0,1)),
  email_status             TEXT NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending','envoye','echec')),
  email_error              TEXT,
  email_sent_at            TEXT,
  email_notification_id    INTEGER,
  created_by               INTEGER,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (contentieux_id) REFERENCES contentieux(id) ON DELETE CASCADE,
  FOREIGN KEY (assujetti_id) REFERENCES assujettis(id) ON DELETE CASCADE,
  FOREIGN KEY (email_notification_id) REFERENCES notifications_email(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (contentieux_id, niveau_alerte, date_echeance)
);
CREATE INDEX IF NOT EXISTS idx_contentieux_alerts_contentieux ON contentieux_alerts(contentieux_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contentieux_alerts_echeance ON contentieux_alerts(date_echeance, niveau_alerte);

CREATE TABLE IF NOT EXISTS evenements_contentieux (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  contentieux_id   INTEGER NOT NULL,
  type             TEXT NOT NULL CHECK (type IN ('ouverture','courrier','statut','decision','jugement','relance','commentaire')),
  date             TEXT NOT NULL,
  auteur           TEXT,
  description      TEXT NOT NULL,
  piece_jointe_id  INTEGER,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (contentieux_id) REFERENCES contentieux(id) ON DELETE CASCADE,
  FOREIGN KEY (piece_jointe_id) REFERENCES pieces_jointes(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_evenements_contentieux_contentieux ON evenements_contentieux(contentieux_id, date, created_at);

-- =====================================================================
-- Pieces jointes
-- =====================================================================
CREATE TABLE IF NOT EXISTS pieces_jointes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entite        TEXT NOT NULL CHECK (entite IN ('dispositif','declaration','contentieux','titre','controle')),
  entite_id     INTEGER NOT NULL,
  nom           TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  taille        INTEGER NOT NULL CHECK (taille > 0),
  chemin        TEXT NOT NULL,
  type_piece    TEXT CHECK (type_piece IS NULL OR (entite = 'contentieux' AND type_piece IN ('courrier-admin','courrier-contribuable','decision','jugement'))),
  uploaded_by   INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at    TEXT,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_pieces_jointes_entite ON pieces_jointes(entite, entite_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_pieces_jointes_uploaded_by ON pieces_jointes(uploaded_by);

-- =====================================================================
-- Contrôles terrain
-- =====================================================================
CREATE TABLE IF NOT EXISTS controles (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  dispositif_id          INTEGER,
  agent_id               INTEGER NOT NULL,
  date_controle          TEXT NOT NULL,
  latitude               REAL NOT NULL,
  longitude              REAL NOT NULL,
  surface_mesuree        REAL NOT NULL CHECK (surface_mesuree > 0),
  nombre_faces_mesurees  INTEGER NOT NULL CHECK (nombre_faces_mesurees >= 1 AND nombre_faces_mesurees <= 4),
  ecart_detecte          INTEGER NOT NULL DEFAULT 0 CHECK (ecart_detecte IN (0,1)),
  ecart_description      TEXT,
  statut                 TEXT NOT NULL DEFAULT 'saisi' CHECK (statut IN ('saisi','cloture')),
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (dispositif_id) REFERENCES dispositifs(id) ON DELETE SET NULL,
  FOREIGN KEY (agent_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_controles_date ON controles(date_controle DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_controles_dispositif ON controles(dispositif_id);
CREATE INDEX IF NOT EXISTS idx_controles_agent ON controles(agent_id);

CREATE TABLE IF NOT EXISTS titre_mises_en_demeure (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  numero           TEXT NOT NULL UNIQUE,
  titre_id         INTEGER NOT NULL UNIQUE,
  piece_jointe_id  INTEGER NOT NULL UNIQUE,
  annee            INTEGER NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'manuel' CHECK (mode IN ('manuel','batch')),
  generated_by     INTEGER,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (titre_id) REFERENCES titres(id) ON DELETE CASCADE,
  FOREIGN KEY (piece_jointe_id) REFERENCES pieces_jointes(id) ON DELETE CASCADE,
  FOREIGN KEY (generated_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_titre_mises_en_demeure_annee ON titre_mises_en_demeure(annee, numero);

CREATE TABLE IF NOT EXISTS titre_mises_en_demeure_sequences (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  annee            INTEGER NOT NULL,
  numero_ordre     INTEGER NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (annee, numero_ordre)
);

CREATE TABLE IF NOT EXISTS rapports_exports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type_rapport  TEXT NOT NULL CHECK (type_rapport IN ('role_tlpe')),
  annee         INTEGER NOT NULL,
  format        TEXT NOT NULL CHECK (format IN ('pdf','xlsx')),
  filename      TEXT NOT NULL,
  storage_path  TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  titres_count  INTEGER NOT NULL DEFAULT 0,
  total_montant REAL NOT NULL DEFAULT 0,
  generated_by  INTEGER,
  exported_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (generated_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_rapports_exports_type_annee ON rapports_exports(type_rapport, annee, exported_at DESC);

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
