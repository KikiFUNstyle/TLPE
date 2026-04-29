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
| Titres de recettes + PDF (ordonnancement) + bordereau récapitulatif PDF/Excel horodaté avec hash SHA-256 + rôle TLPE PDF/Excel archivé + état de recouvrement (page + PDF/Excel archivés) + comparatif pluriannuel 3 ans glissants (page + PDF/Excel archivés) + suivi des relances et mises en demeure (page + PDF/Excel archivés) + synthèse des contentieux en cours (page + PDF/Excel archivés) + mises en demeure PDF unitaire/batch archivées | §7.1 / §10.2 / US5.1 / US8.1 / US8.2 / US8.5 / US8.3 / US8.4 / US5.8 | OK + tests |
| Escalade automatique des impayés (J+10 / J+30 / J+60) + historique par titre | §7.4 / US5.7 | OK + tests |
| Mandats SEPA + export pain.008.001.02 avec validation IBAN/BIC, séquencement FRST/RCUR et validation XSD locale | §7.2 / US5.4 | OK + tests |
| Chiffrement AES-256-GCM au repos des secrets 2FA, IBAN SEPA et pièces jointes + rotation batch de clé | §12.2 / US10.2 | OK + tests |
| Import de relevés bancaires (CSV paramétrable / OFX / MT940), dédoublonnage par transaction, page Rapprochement réservée admin/financier | §7.3 / US5.5 | OK + tests |
| Paiements (5 modalités) + recouvrement | §7.2 | OK |
| Contentieux / réclamations + timeline + alertes de délais légaux + pièces jointes contentieux catégorisées avec aperçu (US6.1/US6.2/US6.3) | §8 | OK + tests |
| Tableau de bord exécutif + KPI déclaratifs temps réel (US3.7: attendus/soumises/validées/rejetées, drilldown zone/type, évolution journalière, auto-refresh 5 min) + alertes contentieux J-30/J-7/dépassement | §10.1 / §5.4 | OK |
| Authentification + RBAC (5 rôles) | §2 | OK |
| Simulateur | §6.3 | OK |
| Audit log (traçabilité) | §12.2 | OK + tests |
| Portail contribuable (accès restreint à sa fiche) | §11 | OK |
| Carte des dispositifs (Leaflet + filtres + export GeoJSON) | §4.2 / §9.2 / §10.2 | OK |
| Contrôles terrain (web responsive, géoloc navigateur, photos, rattachement/ création dispositif, file hors-ligne navigateur) | §9.1 / §9.2 / US7.1 | OK + tests |
| Rapport de contrôle automatique (PDF/Excel, delta de taxe, rectification d’office/demande contribuable, ouverture de redressement) | §9.3 / US7.3 | OK + tests |

### Hors périmètre du MVP (prévu phases ultérieures)

- Application mobile de contrôle terrain (§9.2)
- Intégrations externes complètes : FranceConnect+, PayFip, PESV2 (§13.1)
  (un export PESV2 XML local avec validation XSD est implémenté dans US5.2, sans intégration réseau DGFiP/Hélios)
  (le géocodage BAN de base pour l'autocomplete d'adresse est implémenté dans US2.4)
- Import SIG / Shapefile natif (§4.3)
- Signature électronique (§13.2)
- Conformité RGAA 4.1 complète (§11.3)
- Rapports PDF avancés autres que le titre de recettes, le bordereau récapitulatif des titres (§10.2), **à l’exception du rapport de contrôle automatique US7.3, du rôle TLPE US8.1, de l’état de recouvrement US8.2, du comparatif pluriannuel US8.5, du suivi des relances US8.3 et de la synthèse des contentieux US8.4 désormais implémentés**

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
- Smoke test US7.1 :
  - la page `Contrôles terrain` est visible uniquement pour `admin|gestionnaire|controleur`
  - `POST /api/controles` crée un constat soit rattaché à un dispositif existant, soit avec création de fiche dispositif
  - `POST /api/pieces-jointes` accepte `entite=controle` pour téléverser les photos du constat
  - le bouton GPS remplit latitude/longitude via `navigator.geolocation`
  - hors ligne, le constat est stocké dans IndexedDB puis synchronisé au retour réseau par la page web (le service worker couvre le shell PWA/offline)
- Smoke test US7.3 :
  - la carte/liste `Contrôles terrain` permet la sélection multiple de constats clôturés pour générer un rapport PDF ou Excel
  - `POST /api/controles/report` refuse les constats non clôturés, renvoie un fichier horodaté avec hash SHA-256 et écrit `audit_log` (`action=export-rapport-controle`)
  - `POST /api/controles/proposer-rectification` crée une déclaration d’office (`en_instruction`) ou une demande contribuable (`brouillon`) à partir des écarts contrôlés
  - `POST /api/controles/lancer-redressement` ouvre automatiquement un contentieux `type=controle` avec échéance de réponse calculée et événement timeline initial
  - les actions de rapport/rectification/redressement sont visibles uniquement pour `admin|gestionnaire` et conservent le nom de fichier backend côté téléchargement navigateur
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
- Smoke test US5.1 / US8.1 / US8.2 / US8.3 / US8.4 / US8.5:
  - la page `Titres` affiche les boutons `Bordereau PDF` / `Bordereau Excel` et `Rôle TLPE PDF` / `Rôle TLPE Excel` uniquement pour `admin|financier` quand une année est sélectionnée
  - la page `Titres` propose désormais `Générer mise en demeure` sur chaque titre impayé et un lot `mises en demeure` (max 100 titres filtrés) pour produire/archiver les PDF recommandés en `pieces_jointes`
  - la page `État de recouvrement` est visible uniquement pour `admin|financier`, permet de filtrer par année/zone/catégorie/statut de paiement et bascule la ventilation `assujetti|zone|categorie`
  - `GET /api/titres/bordereau?annee=YYYY&format=pdf|xlsx` retourne les titres filtrés de l'exercice, le total, l'horodatage et un hash SHA-256
  - un export du bordereau écrit une trace `audit_log` (`action=export-bordereau`)
  - `GET /api/rapports/role?annee=YYYY&format=pdf|xlsx` retourne la liste exhaustive des titres émis avec total, horodatage, hash SHA-256, signature ordonnateur et archivage en `rapports_exports`
  - un export du rôle écrit une trace `audit_log` (`action=export-role-tlpe`)
  - `GET /api/rapports/recouvrement?annee=YYYY&format=json|pdf|xlsx` (ajouter uniquement les filtres optionnels réellement renseignés parmi `zone`, `categorie`, `statut_paiement`, `ventilation`) retourne l'agrégation `montant_emis|montant_recouvre|reste_a_recouvrer|taux_recouvrement`, le graphique/tableau selon la ventilation et archive les exports PDF/Excel dans `rapports_exports`
  - la page `Carte des recettes` est visible uniquement pour `admin|financier`, permet de choisir l'année, l'échelle de couleur (`montant_recouvre|taux_recouvrement|reste_a_recouvrer`), de sélectionner une zone et d'exporter la carte en PNG ou PDF
  - `GET /api/rapports/recettes-geographiques?annee=YYYY&color_scale=montant_recouvre|taux_recouvrement|reste_a_recouvrer&format=json|pdf` retourne la ventilation choroplèthe par zone (géométrie, assujettis, titres, totaux), archive les exports PDF dans `rapports_exports` et trace `audit_log` (`action=export-recettes-geographiques`)
  - la page `Comparatif pluriannuel` est visible uniquement pour `admin|financier`, permet de choisir une année de référence et affiche le comparatif N/N-1/N-2 (montants émis, recouvrés, assujettis, dispositifs), les évolutions en % et les ventilations zone/catégorie
  - `GET /api/rapports/comparatif?annee=YYYY&format=json|pdf|xlsx` retourne la synthèse sur 3 ans glissants, les évolutions `vs_n1|vs_n2`, les ventilations par zone/catégorie et archive les exports PDF/Excel dans `rapports_exports`
  - la page `Exports personnalisés` est visible pour `admin|gestionnaire|financier`, permet de choisir une entité (`assujettis|dispositifs|declarations|titres|paiements|contentieux`), de sélectionner les colonnes, d’ajouter des filtres et un tri, de prévisualiser les 50 premières lignes, d’exporter en CSV/Excel et de sauvegarder des modèles personnels
  - la page `Journal d’audit` est visible uniquement pour `admin`, rappelle le caractère immuable du journal (lecture seule), expose les colonnes `timestamp|utilisateur|action|entité|détails|IP`, des filtres `utilisateur|entité|action|plage de dates`, une recherche plein texte dans `details` et un export CSV pour analyse forensic
  - `GET /api/exports-personnalises/meta` expose les entités/colonnes/opérateurs disponibles, `POST /api/exports-personnalises/preview` retourne l’aperçu filtré, `POST /api/exports-personnalises/export?format=csv|xlsx` restitue le fichier demandé et `POST|GET /api/exports-personnalises/templates` gère les modèles sauvegardés dans `exports_sauvegardes`
  - `GET /api/audit-log?page=&page_size=&user_id=&entite=&action=&q=&date_debut=&date_fin=&format=json|csv` est réservé à `admin`, restitue les entrées paginées triées par `created_at DESC`, expose les valeurs de filtre disponibles et journalise les exports CSV via `audit_log` (`action=export-audit-log`)
  - `GET /api/rapports/contentieux?date_reference=YYYY-MM-DD&format=json|pdf|xlsx` retourne la synthèse par type (`nombre_dossiers`, `montant_litige`, `montant_degreve`, `anciennete_moyenne_jours`), un graphique de répartition et les alertes délais ≤ J-30 / dépassées, puis archive les exports PDF/Excel dans `rapports_exports`
  - la page `Contentieux` affiche, pour `admin|financier`, un bloc de synthèse avec KPI, camembert par type et exports PDF/Excel horodatés en conservant le nom de fichier backend
  - en cas d'échec SQL lors de l'archivage d'un export de recouvrement ou de synthèse contentieux, le fichier binaire temporairement écrit est supprimé avant réponse 500 pour éviter les archives orphelines
  - un export de recouvrement écrit une trace `audit_log` (`action=export-etat-recouvrement`) avec `hash`, `titres_count` et `archive_path`
  - un export de comparatif écrit une trace `audit_log` (`action=export-comparatif-pluriannuel`) avec `hash`, `titres_count` et `archive_path`
  - un export de synthèse contentieux écrit une trace `audit_log` (`action=export-synthese-contentieux`) avec `hash`, `dossiers_count`, `alerts_total` et `archive_path`
- Smoke test US5.4:
  - la fiche assujetti affiche les mandats SEPA existants et un formulaire de création (RUM, IBAN, BIC, date de signature)
  - `POST /api/assujettis/:id/mandats-sepa` refuse les IBAN/BIC invalides, masque l'IBAN restitué et trace `create-mandat-sepa` dans `audit_log`
  - un assujetti ne peut avoir qu'un seul mandat actif à la fois; la révocation du mandat courant permet ensuite d'en enregistrer un nouveau
  - `POST /api/assujettis/:id/mandats-sepa/:mandatId/revoke` révoque explicitement le mandat actif et trace `revoke-mandat-sepa`
  - `POST /api/sepa/export-batch` génère un XML `pain.008.001.02` téléchargeable, avec séquencement `FRST` puis `RCUR` selon l'historique
  - les mandats révoqués sont ignorés à l'export et une erreur de validation XSD retourne un message client générique (`Erreur interne export SEPA`)
- Smoke test US5.5 / US5.6:
  - la page `Rapprochement bancaire` n'est visible et accessible que pour `admin|financier`
  - `POST /api/rapprochement/import` accepte `csv|ofx|mt940`, crée `releves_bancaires` + `lignes_releve` et trace `audit_log` (`action=import`, `entite=releve_bancaire`)
  - un second import contenant les mêmes `transaction_id` n'insère pas de doublons et les remonte dans `duplicates`
  - `POST /api/rapprochement/auto` matche un numéro de titre détecté dans la référence ou le libellé, crée un paiement `modalite=virement`, met à jour le statut du titre (`paye|paye_partiel`) et journalise le résultat (`rapproche|partiel|excedentaire|erreur_reference`)
  - les lignes excédentaires ou en erreur de référence restent en attente avec un workflow distinct et une correspondance manuelle possible via `POST /api/rapprochement/manual`
  - `GET /api/rapprochement` liste les relevés importés, les lignes non rapprochées enrichies par workflow et le journal des rapprochements (`auto|manuel`, qui/quand)
- Smoke test US5.7:
  - le scheduler quotidien exécute les relances de campagne **et** l'escalade des impayés
  - `runEscaladeImpayes()` ne traite que les titres non soldés exactement à J+10, J+30 ou J+60 après échéance
  - aucun déclenchement sur les titres avec `contentieux` ouvert ou `moratoire` accordé / en instruction
  - J+30 génère un PDF de mise en demeure dans `server/data/mises_en_demeure/impayes/` et passe le titre au statut `mise_en_demeure`
  - J+60 journalise une transmission au comptable public et l'historique est visible depuis la page `Titres`
- Smoke test US5.9:
  - la page `Titres` expose l'action `Rendre exécutoire` uniquement pour `admin|financier` sur les titres en `mise_en_demeure`
  - `POST /api/titres/:id/rendre-executoire` télécharge un XML PESV2 complément validé XSD, passe le titre à `transmis_comptable` et trace `rendre-executoire` dans `audit_log`
  - `GET /api/titres/:id/executoire/xml` restitue le flux persistant avec ACL contribuable stricte
  - `POST /api/titres/:id/admettre-non-valeur` n'est autorisé que pour les titres `transmis_comptable`, journalise le retour comptable et bascule le statut vers `admis_en_non_valeur`
  - l'historique de recouvrement affiche la transmission comptable et le commentaire d'admission en non-valeur
- Smoke test US6.2:
  - `POST /api/contentieux` calcule automatiquement `date_limite_reponse = date_ouverture + 6 mois` ; le résumé d'alerte (`days_remaining`, `niveau_alerte`, `overdue`, `extended`) est visible dans `GET /api/contentieux`
  - le scheduler quotidien exécute aussi `createContentieuxDeadlineAlerts()` avec idempotence par couple `(contentieux_id, niveau_alerte, date_echeance)`
  - `contentieux_alerts` journalise les alertes J-30 / J-7 / dépassement et `notifications_email` trace l'email gestionnaire associé (`template_code=alerte_contentieux`)
  - le dashboard affiche le volume d'alertes contentieux à <= J-30 et le nombre de dossiers en dépassement
  - la liste `Contentieux` surligne en rouge les dossiers en dépassement et affiche le badge d'échéance/prolongation
  - `POST /api/contentieux/:id/prolonger-delai` exige une date strictement postérieure et une justification, journalise l'audit et ajoute un événement timeline `relance`
- Smoke test US6.3:
  - `GET /api/contentieux/:id/pieces-jointes` restitue les métadonnées (`type_piece`, libellé, auteur, date, `download_url`) triées par date décroissante
  - `POST /api/pieces-jointes` avec `entite=contentieux` persiste `type_piece` (`courrier-admin|courrier-contribuable|decision|jugement`) et journalise l'upload
  - un `contribuable` ne peut téléverser qu'un `courrier-contribuable`, visualise les pièces du dossier en lecture seule et ne peut pas supprimer une pièce contentieux
  - la page `Contentieux` propose la liste des pièces, l'aperçu PDF/image et le téléchargement direct depuis le détail du dossier

## Audit log (US10.1)

La user story **US10.1** livre désormais une interface d’investigation dédiée au journal d’audit :

- page `client/src/pages/AuditLog.tsx` réservée au rôle `admin`, ajoutée au menu principal,
- rappel explicite du caractère **immuable / lecture seule** du journal,
- colonnes restituées : horodatage, utilisateur, action, entité, détails, IP,
- filtres `utilisateur`, `entité`, `action`, `date_debut`, `date_fin`, `page_size`,
- recherche plein texte `q` sur `details`, `action`, `entité`, email et nom utilisateur,
- export CSV forensic avec nom de fichier cohérent et traçage `audit_log` (`action=export-audit-log`),
- backend `GET /api/audit-log` paginé, trié par `created_at DESC, id DESC`, avec index `idx_audit_created_at` pour tenir la charge de consultation.

Tests :
- `npm run test --workspace=server`
- `npm run test --workspace=client`
- `npm run build`

## Transmission comptable public / titre exécutoire (US5.9)

- bouton **Rendre exécutoire** pour les rôles `admin|financier` sur les titres au statut `mise_en_demeure`,
- génération d'un flux XML complémentaire persistant (`titres_executoires`) avec hash SHA-256, mention de visa ordonnateur et validation XSD locale via `xmllint`,
- téléchargement ultérieur via `GET /api/titres/:id/executoire/xml`,
- passage du titre au statut `transmis_comptable`, avec journalisation dans `recouvrement_actions` et `audit_log`,
- gestion du retour négatif comptable par **admission en non-valeur**, statut `admis_en_non_valeur`, commentaire métier et restitution dans l'historique du titre.


## Mandats SEPA / export pain.008 (US5.4)

La fiche **Assujetti** embarque désormais un bloc dédié aux prélèvements automatiques :

- visualisation des mandats SEPA existants (`RUM`, IBAN masqué, `BIC`, date de signature, statut),
- création d'un mandat via `POST /api/assujettis/:id/mandats-sepa`,
- révocation explicite d'un mandat actif avant remplacement (`POST /api/assujettis/:id/mandats-sepa/:mandatId/revoke`),
- contrôles `IBAN` (MOD-97 via `ibantools`) et `BIC`,
- journalisation `audit_log` (`action=create-mandat-sepa`).

Le backend expose aussi `POST /api/sepa/export-batch` pour générer un lot XML `pain.008.001.02` :

- sélection automatique des titres échus avec solde restant et mandat actif,
- calcul de la séquence `FRST` au premier prélèvement puis `RCUR` ensuite,
- validation XSD locale avant restitution,
- persistance des lots (`sepa_exports`) et ordres (`sepa_prelevements`, `sepa_export_items`),
- journalisation `audit_log` (`action=export-sepa`).

Exemple d'appel :

```bash
curl -X POST http://localhost:4000/api/sepa/export-batch \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ***' \
  -d '{"date_reference":"2026-08-31","date_prelevement":"2026-09-05"}' \
  -o pain.008-000001.xml
```

## API pièces jointes (US2.5)

Routes backend (`/api/pieces-jointes`), authentifiées:

- `POST /api/pieces-jointes` (multipart/form-data)
  - champs requis: `entite` (`dispositif|declaration|contentieux|titre|controle`), `entite_id`, `fichier`
  - MIME autorisés globaux: `image/jpeg`, `image/png`, `application/pdf`
  - exception métier: `entite=controle` est réservé aux photos terrain (`image/jpeg|image/png` uniquement, jamais PDF)
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

## Pièces jointes contentieux (US6.3)

Le détail d'un dossier contentieux permet désormais de centraliser les pièces jointes du dossier en réutilisant l'infrastructure US2.5 :

- `POST /api/pieces-jointes` accepte `entite=contentieux`, `entite_id`, `fichier` et un `type_piece` optionnel parmi `courrier-admin|courrier-contribuable|decision|jugement`,
- le backend persiste `pieces_jointes.type_piece` avec migration runtime idempotente pour les bases legacy,
- `GET /api/contentieux/:id/pieces-jointes` renvoie la liste enrichie (`type_piece_label`, auteur, rôle auteur, date, `download_url`) triée par plus récent,
- le contribuable ne peut téléverser que des `courrier-contribuable`, voit les pièces administration en lecture seule et ne peut pas supprimer une pièce attachée à un contentieux,
- la page `client/src/pages/Contentieux.tsx` affiche la liste des pièces, un aperçu PDF/image et un téléversement contextualisé par rôle.

Tests :

- backend `src/contentieux.piecesJointes.test.ts` (ACL, audit, listing, blocage suppression contribuable, cloisonnement inter-assujetti)
- frontend `src/pages/contentieuxAttachments.test.tsx` (options par rôle, aperçu, états de chargement)

## Alertes de délais contentieux (US6.2)

Le module **Contentieux** couvre désormais aussi les échéances légales d'instruction et leur restitution transverse :

- calcul automatique de `date_limite_reponse` à l'ouverture d'un dossier (`date_ouverture + 6 mois`, avec clamp calendrier),
- persistance des champs `date_limite_reponse`, `date_limite_reponse_initiale`, `delai_prolonge_justification`, `delai_prolonge_par`, `delai_prolonge_at`,
- endpoint `POST /api/contentieux/:id/prolonger-delai` réservé à `admin|gestionnaire|financier`, avec validation stricte de la nouvelle échéance et justification obligatoire,
- table `contentieux_alerts` + job quotidien `createContentieuxDeadlineAlerts()` pour générer les alertes J-30, J-7 et dépassement sans doublons,
- traçabilité des emails gestionnaire dans `notifications_email` (`template_code=alerte_contentieux`) et des mutations dans `audit_log`,
- restitution des alertes dans le dashboard (`contentieux_alertes_total`, `contentieux_alertes_overdue`) et dans la liste UI des contentieux (badge d'échéance + surlignage rouge en cas de dépassement).

## Timeline contentieux (US6.1)

Le module **Contentieux** embarque désormais une chronologie détaillée pour chaque dossier :

- création automatique d'un événement `ouverture` lors de `POST /api/contentieux`,
- ajout automatique d'un événement `statut` et, si une motivation est fournie, d'un événement `decision` lors de `POST /api/contentieux/:id/decider`,
- ajout manuel d'un événement métier via `POST /api/contentieux/:id/evenements`,
- consultation chronologique via `GET /api/contentieux/:id/timeline`,
- export PDF de la timeline via `GET /api/contentieux/:id/timeline/pdf`.

Schéma SQL ajouté :

- table `evenements_contentieux` (`contentieux_id`, `type`, `date`, `auteur`, `description`, `piece_jointe_id`, `created_at`),
- index `idx_evenements_contentieux_contentieux` pour le tri chronologique.

UI :

- la page `client/src/pages/Contentieux.tsx` permet d'ouvrir la timeline d'un dossier,
- consultation des événements en ordre chronologique,
- saisie d'un événement manuel (type/date/auteur/description/ID de pièce jointe optionnel),
- mise à jour du statut/décision sans prompt navigateur,
- téléchargement direct du PDF de timeline.

Audit :

- `logAudit()` sur création de dossier, ajout manuel d'événement, décision et export PDF de timeline.

## Chiffrement AES-256-GCM au repos (US10.2)

Le backend chiffre désormais au repos les données sensibles gérées applicativement via `server/src/services/crypto.ts` :

- secrets TOTP (`users.two_factor_secret_encrypted`, `users.two_factor_pending_secret_encrypted`),
- IBAN des mandats SEPA (`mandats_sepa.iban`),
- pièces jointes et archives stockées via `saveFile()` (`pieces_jointes`, mises en demeure, exports de rapports),
- avec compatibilité legacy en lecture (`decrypt*OrLegacy`) et rotation de version (`rotateEncryptedText`, `rotateEncryptedBuffer`).

Configuration des clés :

```bash
# clé active unique (32 octets base64)
export TLPE_DATA_KEY="<base64-32-bytes>"
export TLPE_DATA_KEY_VERSION="2026-q2"

# ou trousseau multi-versions pour rotation progressive
export TLPE_DATA_KEYS="2026-q1:<base64-32-bytes>,2026-q2:<base64-32-bytes>"
export TLPE_DATA_KEY_VERSION="2026-q2"
```

Notes d'exploitation :

- en production, `TLPE_DATA_KEY` ou `TLPE_DATA_KEYS` est obligatoire ; le fallback de développement n'est accepté qu'hors production,
- la clé doit être fournie par l'environnement d'exécution et idéalement externalisée vers un gestionnaire dédié (Vault/KMS) en production,
- rotation batch disponible via `npm run crypto:rotate --workspace=server [-- --dry-run]`,
- inventaire courant des champs sensibles : secrets TOTP, IBAN SEPA et fichiers binaires stockés ; aucun champ NIR dédié n'est présent dans le schéma applicatif actuel.

## Sauvegardes quotidiennes chiffrées + test de restauration mensuel (US10.3)

Le backend embarque désormais un pipeline de sauvegarde chiffrée piloté par `server/src/services/backup.ts` :

- snapshot SQLite cohérent via l'API `better-sqlite3.backup()` (`db/tlpe.db`),
- archivage des répertoires runtime sensibles `uploads/`, `receipts/` et `mises_en_demeure/`,
- manifest JSON embarqué (`manifest.json`) avec hash SHA-256 de chaque fichier restaurable,
- chiffrement hybride : archive `tar.gz` chiffrée en AES-256-GCM avec clé de session aléatoire, elle-même chiffrée par clé publique RSA-OAEP SHA-256,
- stockage local ou S3-compatible selon `TLPE_BACKUP_STORAGE_MODE=local|s3`,
- rotation de rétention 12 mois avec conservation quotidienne / hebdomadaire / mensuelle,
- exercice mensuel de restauration via `restoreLatestBackup()` avec contrôle `PRAGMA integrity_check`,
- webhook d'alerte optionnel en cas d'échec backup/restauration (`TLPE_BACKUP_ALERT_WEBHOOK_URL`).

Scripts disponibles :

```bash
npm run backup:run --workspace=server
npm run backup:restore-test --workspace=server
./scripts/backup.sh
./scripts/restore-test.sh
```

Variables d'environnement minimales :

```bash
export TLPE_BACKUP_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----..."
export TLPE_BACKUP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----..." # requis pour restore-test
export TLPE_BACKUP_STORAGE_MODE=local
export TLPE_BACKUP_LOCAL_DIR=/var/backups/tlpe
export TLPE_BACKUP_STORAGE_PREFIX=backups
export TLPE_BACKUP_RETENTION_DAILY_DAYS=35
export TLPE_BACKUP_RETENTION_WEEKLY_WEEKS=26
export TLPE_BACKUP_RETENTION_MONTHLY_MONTHS=12
export TLPE_BACKUP_ALERT_WEBHOOK_URL=https://hooks.example/tlpe-backup
```

Mode S3-compatible :

```bash
export TLPE_BACKUP_STORAGE_MODE=s3
export TLPE_BACKUP_S3_BUCKET=tlpe-backups
export TLPE_BACKUP_S3_REGION=eu-west-3
export TLPE_BACKUP_S3_ENDPOINT=https://s3.example
export TLPE_BACKUP_S3_FORCE_PATH_STYLE=true
export TLPE_BACKUP_S3_ACCESS_KEY_ID=***
export TLPE_BACKUP_S3_SECRET_ACCESS_KEY=***
```

Automatisation GitHub Actions :

- `.github/workflows/backup-maintenance.yml`
  - backup quotidien à `01:17 UTC`,
  - drill de restauration mensuel le 1er du mois à `02:33 UTC`,
  - mode manuel `workflow_dispatch` (`backup` ou `restore-test`).

Procédure manuelle de restauration :

1. Exporter `TLPE_BACKUP_PRIVATE_KEY` et la même configuration de stockage que la production.
2. Lancer `npm run backup:restore-test --workspace=server` pour extraire la dernière archive dans un répertoire temporaire.
3. Vérifier `integrity.ok=true` et inspecter `payload/db/tlpe.db`, `payload/uploads/`, `payload/receipts/`, `payload/mises_en_demeure/`.
4. Stopper l'application cible, remplacer la base et les répertoires restaurés, puis redémarrer.
5. Contrôler `GET /api/health` et les écrans métier clés.

Tests couverts :

- roundtrip texte + binaire AES-256-GCM,
- rejet d'un payload corrompu (IV/tag),
- rotation vers une nouvelle version de clé,
- vérification que les pièces jointes et les IBAN persistés ne restent pas en clair.

## Double authentification TOTP du portail contribuable (US9.1)

Le portail contribuable propose désormais un écran **Paramètres du compte** accessible depuis le menu latéral pour gérer la double authentification :

- préparation d'un secret TOTP côté backend via `POST /api/auth/2fa/setup`,
- génération et affichage d'un QR code pour Google Authenticator / 1Password / Authy,
- confirmation d'activation par code à 6 chiffres via `POST /api/auth/2fa/enable`,
- génération de 10 codes de récupération à usage unique,
- affichage du nombre de codes restants et désactivation confirmée par code via `POST /api/auth/2fa/disable`,
- challenge intermédiaire à la connexion quand la 2FA est active (`POST /api/auth/login` puis `POST /api/auth/login/verify-2fa`).

Points de vérification manuelle :

- se connecter avec un compte contribuable,
- ouvrir **Paramètres du compte**,
- lancer la configuration 2FA et scanner le QR code,
- confirmer l'activation avec un code TOTP valide,
- vérifier qu'une reconnexion demande bien le code TOTP ou un code de récupération,
- désactiver la 2FA avec un code valide.

## Paiement en ligne PayFip / Tipi (US5.3)

Le portail contribuable prend en charge un flux PayFip/Tipi simulé depuis l'écran **Titres** :

- bouton **Payer en ligne** sur chaque titre non soldé du contribuable,
- préparation d'une redirection PayFip avec `collectivite`, `numero_titre`, `montant`, `reference`, `return_url`, `callback_url`,
- retour frontend sur `/paiement/confirmation` avec page dédiée de confirmation/annulation/refus (et bannière récapitulative si retour historisé sur `/titres`),
- callback backend `POST /api/paiements/callback/payfip` avec validation MAC HMAC-SHA256,
- création automatique d'un paiement `modalite=tipi`, `provider=payfip`, traçabilité complète (`transaction_id`, `callback_payload`, `statut`),
- rapprochement automatique du titre en cas de callback confirmé.

Configuration minimale :

```bash
export TLPE_PAYFIP_SECRET=<cle-hmac>
export TLPE_PAYFIP_BASE_URL=https://payfip.example/payer
export TLPE_PAYFIP_COLLECTIVITE=33063
export TLPE_PAYFIP_RETURN_URL=http://localhost:5173/paiement/confirmation
export TLPE_PAYFIP_CALLBACK_URL=http://localhost:4000/api/paiements/callback/payfip
```

Convention de signature callback :

```text
HMAC_SHA256(secret, "<numero_titre>|<reference>|<montant_2_decimales>|<statut>|<transaction_id>")
```

Mapping des statuts PayFip :

- `success` → paiement `confirme`, rapprochement du titre,
- `cancel` → paiement `annule`, sans mise à jour du solde,
- `failed` → paiement `refuse`, sans mise à jour du solde.

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
