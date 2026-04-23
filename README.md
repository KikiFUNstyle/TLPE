# TLPE Manager

Application web de gestion de la **Taxe Locale sur la Publicité Extérieure** (TLPE),
basée sur les articles L2333-6 à L2333-16 du CGCT.

## Stack

- **Backend** : Node.js 22, Express, TypeScript, SQLite (better-sqlite3), JWT, Zod, PDFKit
- **Frontend** : React 18, TypeScript, Vite, React Router
- **Monorepo** : npm workspaces

## Modules livrés (MVP)

| Module | Spec | Statut |
|---|---|---|
| Référentiels (barème, zones, types + import GeoJSON des zones + exonerations/abattements + campagnes déclaratives annuelles) | §3 / §5.1 | OK |
| Assujettis (CRUD, contrôle SIRET Luhn) | §4.1 | OK |
| Import en masse assujettis (CSV/XLSX + pré-contrôle + enrichissement SIRENE) | §4.3 / §13.1 | OK |
| Dispositifs (CRUD, géolocalisation) | §4.2 | OK |
| Pièces jointes (upload/download, soft delete, ACL contribuable, limites taille) | §4.2 / §5.2 / §8.2 | OK |
| Moteur de calcul TLPE (tranches, prorata, coef. zone, double face, forfait, exonération) | §6 | OK + tests |
| Déclarations (brouillon → soumission → validation → rejet) | §5 | OK |
| Contrôles automatiques avancés à la soumission (complétude, doublons adresse/type, cohérence dates, variation N/N-1 >30%) + alertes gestionnaire | §5.3 (US3.3) | OK + tests |
| Quote-part dispositifs numériques partagés (0-100%, contrôle somme ≤ 100%, impact calcul + PDF titre) | §6.2 (US4.1) | OK + tests |
| Accusé de réception PDF horodaté avec hash SHA-256 + QR de vérification + téléchargement sur détail déclaration | §5.2 / US3.6 | OK + tests |
| Hash SHA-256 de soumission (accusé) | §5.2 | OK |
| Titres de recettes + PDF (ordonnancement) + bordereau récapitulatif PDF/Excel horodaté avec hash SHA-256 | §7.1 / US5.1 | OK + tests |
| Paiements (5 modalités) + recouvrement | §7.2 | OK |
| Contentieux / réclamations | §8 | OK |
| Tableau de bord exécutif + KPI déclaratifs temps réel (US3.7: attendus/soumises/validées/rejetées, drilldown zone/type, évolution journalière, auto-refresh 5 min) | §10.1 / §5.4 | OK |
| Authentification + RBAC (5 rôles) | §2 | OK |
| Simulateur | §6.3 | OK |
| Audit log (traçabilité) | §12.2 | OK |
| Portail contribuable (accès restreint à sa fiche) | §11 | OK |
| Carte des dispositifs (Leaflet + filtres + export GeoJSON) | §4.2 / §9.2 / §10.2 | OK |

### Hors périmètre du MVP (prévu phases ultérieures)

- Application mobile de contrôle terrain (§9.2)
- Intégrations externes complètes : FranceConnect+, PayFip, PESV2 (§13.1)
  (un export PESV2 XML local avec validation XSD est implémenté dans US5.2, sans intégration réseau DGFiP/Hélios)
  (le géocodage BAN de base pour l'autocomplete d'adresse est implémenté dans US2.4)
- Import SIG / Shapefile natif (§4.3)
- Signature électronique (§13.2)
- Conformité RGAA 4.1 complète (§11.3)
- Rapports PDF avancés autres que le titre de recettes, le bordereau récapitulatif des titres (§10.2)

## Démarrage

```bash
# installation
npm run install:all

# lancement dev (API :4000, client :5173)
npm run dev

# seed explicite (si besoin de réinitialiser)
rm -f server/data/tlpe.db && npm run seed

# tests du moteur de calcul + import assujettis
npm test
```

Ouvrir ensuite http://localhost:5173.

## Vérification de lancement appli (obligatoire TLPE loop)

- `npm run dev` : démarrage backend + frontend sans erreur fatale
- Smoke test backend : `GET /api/health` → `{"status":"ok"...}`
- Smoke test pièces jointes : login + création dispositif + upload PDF + download + soft delete + vérif 404 post-delete (script Node)
- Smoke test cartographie : accès `/carte`, tuiles OSM + points affichés, export GeoJSON téléchargeable
- Smoke test US3.3 :
  - soumission KO si doublon adresse+type, surface <= 0, type manquant, date de pose > date de dépose
  - soumission OK avec `alerte_gestionnaire=true` quand la variation de surface N vs N-1 dépasse 30 %
  - visibilité de l'alerte dans la liste des déclarations (colonne `Alertes`) et sur le détail déclaration
- Smoke test US4.1 :
  - sur une déclaration contenant plusieurs lignes d’un même dispositif, la somme des `quote_part` doit être <= 1.0 (sinon 400)
  - le calcul applique `montant_ligne = montant_calcule * quote_part`
  - le PDF titre affiche la quote-part en pourcentage (ex: `33 %`)
- Smoke test US3.6 :
  - `POST /api/declarations/:id/soumettre` renvoie `receipt` (token, hash, URL de vérification, URL de téléchargement)
  - `GET /api/declarations/receipt/verify/:token` retourne `verified=true` sans authentification
  - `GET /api/declarations/:id/receipt/pdf` télécharge l'accusé PDF avec QR code
  - `DeclarationDetail.tsx` affiche le statut email d'envoi de l'accusé + bouton de téléchargement
- Smoke test US3.7:
  - `GET /api/dashboard` expose `operationnel.declarations_soumises|validees|rejetees`, `drilldown.by_zone`, `drilldown.by_type_assujetti`, `evolution_journaliere`
  - le dashboard affiche le taux de déclaration, l'évolution vs N-1, le drilldown par zone/type et le graphe d'évolution journalière
- Smoke test US5.1:
  - la page `Titres` affiche les boutons `Bordereau PDF` / `Bordereau Excel` uniquement pour `admin|financier` quand une année est sélectionnée
  - `GET /api/titres/bordereau?annee=YYYY&format=pdf|xlsx` retourne les titres filtrés de l'exercice, le total, l'horodatage et un hash SHA-256
  - un export du bordereau écrit une trace `audit_log` (`action=export-bordereau`)

## API pièces jointes (US2.5)

Routes backend (`/api/pieces-jointes`), authentifiées:

- `POST /api/pieces-jointes` (multipart/form-data)
  - champs requis: `entite` (`dispositif|declaration|contentieux`), `entite_id`, `fichier`
  - MIME autorisés: `image/jpeg`, `image/png`, `application/pdf`
  - limites: 10 Mo par fichier, 50 Mo cumulés par entité (hors pièces soft-delete)
- `GET /api/pieces-jointes/:id`
  - télécharge le fichier (`Content-Disposition: attachment`)
  - contrôle d'accès: un `contribuable` ne peut accéder qu'à ses entités
- `DELETE /api/pieces-jointes/:id`
  - suppression logique (`deleted_at`)

Stockage:

- par défaut disque local: `server/data/uploads/`
- mode S3-compatible via `TLPE_UPLOAD_STORAGE=s3` + variables `TLPE_S3_*`

Audit:

- `logAudit()` à chaque upload / download / soft delete (entité `piece_jointe`)

## Ouverture et paramétrage d'une campagne déclarative annuelle (US3.1)

Le module Référentiels expose désormais une gestion des campagnes annuelles dans l'onglet **Campagnes**:

- création d'une campagne avec:
  - `annee`
  - `date_ouverture`
  - `date_limite_declaration`
  - `date_cloture`
  - option `relance_j7_courrier` (génération PDF courrier postal à J-7)
- ouverture d'une campagne (statut `brouillon` -> `ouverte`), qui prépare puis exécute le job d'invitation (`campagne_jobs`, type `invitation`)
  - envoi automatique des invitations aux assujettis `actif` avec email renseigné
  - génération d'un lien d'activation unique (magic link) pour les assujettis sans compte portail
  - traçabilité de chaque envoi dans `notifications_email`
- relances automatiques US3.4 :
  - job quotidien (scheduler) qui déclenche les relances J-30 / J-15 / J-7 selon `date_limite_declaration`
  - relance uniquement pour les assujettis sans déclaration `soumise` / `validee`
  - J-15 inclut un lien direct vers le formulaire
  - J-7 peut générer un courrier PDF (si `relance_j7_courrier = 1`) stocké et référencé dans `notifications_email.piece_jointe_path`
- clôture d'une campagne (statut `ouverte` -> `cloturee`), qui:
  - exécute la relance J-7 à la date limite (si applicable)
  - bascule les déclarations `brouillon` de l'année en `en_instruction`
  - crée les entrées de `mises_en_demeure` (préparation US3.5)
- tableau de synthèse avec:
  - état des jobs techniques
  - volume de mises en demeure préparées
  - répartition des déclarations par statut

API backend associée:

- `GET /api/campagnes`
- `GET /api/campagnes/active`
- `GET /api/campagnes/:id/summary`
- `POST /api/campagnes`
- `POST /api/campagnes/:id/open`
- `POST /api/campagnes/:id/close`
- `POST /api/campagnes/:id/envoyer-invitations` (renvoi manuel global ou ciblé via `assujetti_id`)
- `POST /api/campagnes/:id/run-relances` (exécution manuelle du job de relances, option `run_date`)

Schéma SQL ajouté:

- `campagnes`
- `campagne_jobs`
- `mises_en_demeure`
- `invitation_magic_links`
- `notifications_email` (inclut désormais `relance_niveau`, `piece_jointe_path`)

Toute action (`create`, `open`, `close`) est tracée dans `audit_log`. Les relances automatiques et manuelles sont également tracées (`send-relance`).

## Import en masse des assujettis (US2.1)

Depuis l'écran **Assujettis** (rôle admin/gestionnaire) :

1. Télécharger le **Template CSV**.
2. Préparer un fichier `.csv` ou `.xlsx` avec les colonnes :
   `identifiant_tlpe, raison_sociale, siret, forme_juridique, adresse_rue, adresse_cp, adresse_ville, adresse_pays, contact_nom, contact_prenom, contact_fonction, email, telephone, portail_actif, statut, notes`.
3. Utiliser **Pré-contrôle** pour obtenir un rapport d'anomalies ligne par ligne.
4. Importer en choisissant :
   - **Tout annuler si anomalies** (transaction annulée en cas d'erreur),
   - **Ignorer les lignes en erreur** (seules les lignes valides sont importées).

Contrôles appliqués : SIRET (Luhn), email, champs obligatoires, doublons, cohérence identifiant/SIRET.

### Vérification SIRET via API Entreprise (SIRENE)

Les créations/modifications d'assujettis et l'import en masse déclenchent une vérification SIRET via
`https://entreprise.api.gouv.fr/v3/insee/sirene/etablissements/:siret` quand `API_ENTREPRISE_TOKEN` est défini.

- auto-remplissage de `raison_sociale`, `forme_juridique`, `adresse siège` depuis SIRENE,
- blocage si statut radié,
- cache local 30 jours (`api_entreprise_cache`) pour limiter les appels,
- mode dégradé si réseau/API indisponible ou token absent (la saisie reste possible avec alerte).

Configuration :

```bash
export API_ENTREPRISE_TOKEN=<token_api_entreprise>
```

## Import en masse des dispositifs (US2.2)

Depuis l'écran **Dispositifs** (rôles admin/gestionnaire/controleur) :

1. Télécharger le **Template CSV**.
2. Préparer un fichier `.csv` ou `.xlsx` avec les colonnes :
   `identifiant_assujetti, type_code, adresse, lat, lon, surface, faces, date_pose, zone_code, statut`.
3. Lancer **Pré-contrôle** pour obtenir le rapport d'anomalies avant commit.
4. Importer en choisissant :
   - **Tout annuler si anomalies** (transaction annulée en cas d'erreur),
   - **Ignorer les lignes en erreur** (seules les lignes valides sont importées).
5. Optionnel : cocher **Geocoder via BAN** pour compléter `lat/lon` quand absents.

Pré-contrôles appliqués : assujetti existant, type référentiel, zone connue (ou calculée par coordonnées), surface > 0, nombre de faces entre 1 et 4, statut valide, format de date `YYYY-MM-DD`.

## Géocodage automatique via BAN (US2.4)

Le formulaire **Nouveau dispositif** et le formulaire **Nouvel assujetti** utilisent désormais un composant d'autocomplete d'adresse (debounce 300 ms) basé sur la BAN :

- suggestion d'adresses en AJAX,
- sélection d'une suggestion qui renseigne automatiquement l'adresse normalisée,
- auto-remplissage des coordonnées `lat/lon` (dispositif) et de la ville/code postal,
- fallback en saisie manuelle avec message explicite si BAN indisponible.

Une API backend dédiée est exposée :

- `GET /api/geocoding/search?q=<adresse>&limit=5`

Le flux d'import en masse de dispositifs enrichit aussi les données :

- si `geocodeWithBan=true` et que `lat/lon` sont absents, la BAN est sollicitée,
- les champs adresse/CP/ville et coordonnées sont normalisés avant insertion.

## Visualisation cartographique des dispositifs (US2.6)

Nouvelle page **Carte des dispositifs** (`/carte`) accessible aux rôles métiers et contribuable :

- rendu Leaflet + tuiles OpenStreetMap,
- marqueurs colorés selon le statut (`déclaré`, `contrôlé`, `litigieux`, `déposé`, `exonéré`),
- filtres dynamiques par zone tarifaire, type de dispositif et année de déclaration,
- popup détaillée avec lien vers la fiche dispositif,
- export GeoJSON de la sélection courante.

API associée :

- `GET /api/dispositifs?zone_id=<id>&type_id=<id>&annee=<YYYY>`
- `GET /api/dispositifs/annees`

### Comptes de démonstration

| Rôle | Email | Mot de passe |
|---|---|---|
| Administrateur | admin@tlpe.local | admin123 |
| Gestionnaire | gestionnaire@tlpe.local | gestion123 |
| Financier | financier@tlpe.local | finance123 |
| Contrôleur | controleur@tlpe.local | controle123 |
| Contribuable | contribuable@tlpe.local | contrib123 |

## Parcours de démonstration

1. Connexion **admin** → Tableau de bord.
2. **Assujettis** → ouvrir "Boulangerie du Centre SARL" → bouton **Ouvrir déclaration 2026**.
3. Page **Déclaration** : vérifier/modifier les lignes pré-remplies → **Soumettre**.
4. Reconnexion **gestionnaire** → ouvrir la déclaration soumise → **Valider & calculer** (le moteur applique barème + coefficient de zone + prorata).
5. Reconnexion **financier** → **Émettre titre** → télécharger le PDF.
6. Sur la page Titres → **Enregistrer un paiement** → le statut passe à payé.
7. Reconnexion **contribuable** → il ne voit que ses propres déclarations et titres.
8. **Simulateur** : tester des cas (enseigne ≤ 7m² exonérée, enseigne 7-12m² forfait 75€, double face, prorata).

## Mise à jour annuelle des barèmes (US1.1)

Le module Référentiels supporte maintenant :

- import unitaire via formulaire (`/referentiels`, onglet Barème)
- import batch CSV via `POST /api/referentiels/baremes/import`
- historique des millésimes via `GET /api/referentiels/baremes/history`
- année active calculée via `GET /api/referentiels/baremes/active-year`
- activation d'un millésime via `POST /api/referentiels/baremes/activate-year/:annee`

Format CSV attendu (`,` ou `;`) :

```csv
annee,categorie,surface_min,surface_max,tarif_m2,tarif_fixe,exonere,libelle
2026,publicitaire,0,8,15.50,,0,Publicitaire <= 8 m2
2026,enseigne,7,12,,75,0,Enseigne 7-12 m2 (forfait)
```

Job d'activation (à planifier au 1er janvier):

```bash
npm run job:activate-baremes --workspace=server
# optionnel: TLPE_BAREME_YEAR=2027 npm run job:activate-baremes --workspace=server
```

Chaque création/modification/activation est journalisée dans `audit_log` via `logAudit()`.

## Exonerations et abattements délibérés (US1.3)

Le module Référentiels expose une gestion CRUD des exonerations dans un onglet dédié (`/referentiels` → `Exonerations`) avec backend associé :

- `GET /api/referentiels/exonerations`
- `POST /api/referentiels/exonerations`
- `DELETE /api/referentiels/exonerations/:id`

Structure persistée (`exonerations`) :

- `type` : `droit | deliberee | eco`
- `critere` : JSON (exemples : `{"categorie":"enseigne","surface_max":7}` ou `{"assujetti_id":12,"annee_min":2026}`)
- `taux` : `0.0` à `1.0` (1.0 = exonération totale)
- `date_debut` / `date_fin`
- `active`

Le moteur `calculerTLPE` applique désormais automatiquement l'abattement/exonération correspondant (hors override manuel `dispositifs.exonere` qui reste prioritaire).

## Barème intégré

Barèmes 2024 et 2025 (revalorisation indicative +2%) pré-chargés pour les 3 catégories :

| Catégorie | Tranche | Tarif 2024 |
|---|---|---|
| Publicitaire | ≤ 8 m² | 15,50 €/m² |
| Publicitaire | 8-50 m² | 31 €/m² |
| Publicitaire | > 50 m² | 62 €/m² |
| Préenseigne | ≤ 1,5 m² | 6,20 €/m² |
| Préenseigne | > 1,5 m² | 15,50 €/m² |
| Enseigne | ≤ 7 m² | Exonérée |
| Enseigne | 7-12 m² | 75 € forfait |
| Enseigne | > 12 m² | 15,50 €/m² |

## Arborescence

```
TLPE/
├── package.json           # workspaces
├── server/                # API Express + SQLite
│   ├── src/
│   │   ├── index.ts
│   │   ├── schema.sql
│   │   ├── db.ts
│   │   ├── auth.ts
│   │   ├── calculator.ts          # moteur de calcul
│   │   ├── calculator.test.ts     # tests unitaires
│   │   ├── seed.ts
│   │   └── routes/
│   │       ├── auth.ts
│   │       ├── assujettis.ts
│   │       ├── dispositifs.ts
│   │       ├── geocoding.ts
│   │       ├── piecesJointes.ts
│   │       ├── referentiels.ts
│   │       ├── declarations.ts
│   │       ├── titres.ts           # émission + PDF + paiements
│   │       ├── dashboard.ts
│   │       ├── simulateur.ts
│   │       └── contentieux.ts
│   └── data/tlpe.db               # généré au démarrage
└── client/                # React + Vite
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── auth.tsx
        ├── api.ts
        ├── format.ts
        ├── styles.css
        └── pages/
            ├── Login.tsx
            ├── Dashboard.tsx
            ├── Assujettis.tsx
            ├── AssujettiDetail.tsx
            ├── Dispositifs.tsx
            ├── Carte.tsx
            ├── Declarations.tsx
            ├── DeclarationDetail.tsx
            ├── Simulateur.tsx
            ├── Titres.tsx
            ├── Referentiels.tsx
            └── Contentieux.tsx
```
