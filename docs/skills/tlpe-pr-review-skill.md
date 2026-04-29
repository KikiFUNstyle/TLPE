# TLPE PR Review Skill

Ce guide sert de **skill de review** pour les PR du projet TLPE.

## Objectif
Faire une review rapide mais rigoureuse, orientée risques métier (fiscalité TLPE), sécurité, et robustesse API/UI.

## Checklist TLPE

### 1) Métier TLPE
- Vérifier que les règles de calcul ne sont pas dupliquées hors `server/src/calculator.ts`.
- Vérifier l'anti-datage: sélection du barème le plus récent `<= année demandée`.
- Vérifier cohérence des tranches (`surface_min`, `surface_max`) et traitements exonération/forfait.

### 2) Sécurité & conformité
- Toutes les routes métiers sont protégées par `authMiddleware` + `requireRole(...)`.
- Pas de secrets hardcodés.
- Validation d'entrée systématique (Zod côté routes).
- Échec de validation = erreur 4xx (pas 500).
- Pour tout téléchargement de fichier, interdire les contrôles de type `startsWith(...)` seuls: vérifier l'enracinement avec `path.relative(root, absolutePath)` et rejeter si `..` ou chemin absolu.
- Pour tout stream de fichier (`createReadStream`), imposer un handler d'erreur explicite qui journalise et termine proprement la réponse.

### 3) DB & audit
- Toute mutation métier sensible appelle `logAudit()`.
- Modifs SQL compatibles avec schéma existant et idempotence (`CREATE TABLE IF NOT EXISTS`).
- Les transactions couvrent les opérations batch.

### 4) Frontend
- Les actions admin ne sont visibles qu'aux admins.
- Les erreurs API sont affichées de façon exploitable pour l'utilisateur.
- Le flux UX principal est testé manuellement (liste, import, activation, rafraîchissement).

### 5) Campagnes, jobs & notifications (appris sur US3.4/US3.5)
- Si une feature ajoute un job planifié (scheduler/cron), vérifier **idempotence** et absence de doublon d'envoi (même campagne + assujetti + niveau/template).
- Vérifier l'éligibilité métier exacte avant envoi (assujetti actif, exclusions de statuts correctes, année ciblée explicite).
- Vérifier la cohérence **schéma + migrations runtime + API** quand de nouvelles colonnes sont introduites.
- Vérifier qu'une action de clôture n'introduit pas d'effet de bord silencieux (payload de job, audit associé, date d'exécution attendue).
- Vérifier la traçabilité complète: `notifications_email`, `campagne_jobs`, `audit_log`.

### 6) Règles spécifiques mises en demeure J+1 (US3.5)
- Le déclenchement doit être basé sur `date_cloture + 1` (et non `date_limite_declaration`).
- Les non-déclarants sont les assujettis actifs **sans déclaration soumise/validée/rejetée** sur l'année de campagne (un rejet ne doit jamais être rouvert implicitement).
- La déclaration d'office doit être créée/normalisée au statut `en_instruction` avec marque explicite (commentaire/flag).
- Le PDF de mise en demeure doit réutiliser l'historique N-1 (lignes de déclaration) et seulement fallback sur les dispositifs courants si l'historique est absent.
- Si email manquant, tracer un échec explicite (`notifications_email.statut='echec'`) et conserver la mise en demeure en `a_traiter`.

### 7) Tests
- Couvrir happy path + edge cases + erreurs validation.
- Ajouter des tests d'idempotence pour tout envoi batch/notification.
- Vérifier qu'un test échoue avant fix (TDD) quand c'est possible.
- Pour tout import volumique (relevés, CSV métier, lots), vérifier qu'aucune requête `IN (...)` n'utilise un nombre non borné de paramètres SQLite : traiter en batch ou table temporaire, avec test de non-régression au-delà de `MAX_VARIABLE_NUMBER`.
- Pour tout parseur MT940/format bancaire, vérifier que les références métier sont préservées même sans séparateur `//` et que le code type (`NTRF`, `NMSC`, etc.) n'est pas restitué comme référence client.
- Pour toute liste UI de doublons/aperçus importés, vérifier une clé React réellement unique et stable (`transaction_id` seul est insuffisant si la vue affiche plusieurs doublons du même identifiant).
- Pour toute US avec document généré (PDF, accusé, courrier), ajouter un test API qui valide la présence des métadonnées de restitution (`token/hash/download_url`) et un test service qui vérifie la persistance + réutilisation idempotente.
- Pour toute assertion de sécurité sur un PDF généré, ne jamais se contenter d'un `buffer.includes(...)` sur le binaire brut : vérifier la donnée avant rendu ou décompresser les flux PDF compressés pour éviter un faux positif.
- Pour toute US de mise en demeure sur titres, vérifier explicitement en review :
  - route manuelle sécurisée (`POST /api/titres/:id/mise-en-demeure`) + route batch sécurisée (`POST /api/titres/mises-en-demeure/batch`),
- Pour toute route batch métier qui peut ignorer des entrées invalides ou non rattachées (`redressement`, `rectification`, exports groupés, etc.), vérifier qu'un résultat vide ne renvoie jamais `201`/succès silencieux : exiger une réponse explicite de type `409/4xx` avec `created.length === 0` et un test de non-régression sans effet de bord.
  - numérotation unique et stable via table dédiée (`titre_mises_en_demeure`) avec réutilisation idempotente si un PDF existe déjà pour le titre,
  - séquence de numérotation résistante à la concurrence (pas de `COUNT(*) + 1`) et migration runtime/schéma dédiée si un compteur persistant est introduit,
  - archivage du PDF dans `pieces_jointes` avec entité `titre`, `download_url` renvoyé par l'API et traçabilité `audit_log` dédiée,
  - téléchargement réellement autorisé pour tous les rôles producteurs du document (`admin|financier`) avec test bout-en-bout du `download_url`,
  - en cas de soft delete de la pièce jointe, ne jamais renvoyer un `download_url` obsolète : régénérer ou refuser explicitement avec couverture de test,
  - batch atomique côté validation d'entrée/résolution des titres (pas de résultats partiels silencieux si un élément est introuvable),
  - blocage métier sur les titres soldés, tests couverture happy path + batch + refus 409,
  - présence d'un déclencheur UI explicite côté page Titres (unitaire + lot) réservé aux rôles `admin|financier`.
- Pour tout export binaire métier (PDF/XLSX bordereau, titre, rapport), vérifier en review:
  - contrôle d'accès explicite par rôle,
  - filtrage métier exact des données exportées,
  - présence d'un horodatage + hash du contenu restitué,
  - écriture d'une trace `audit_log` dédiée à l'export,
  - si l'US exige un archivage d'export (`rapports_exports`, pièce jointe, stockage disque/S3), vérifier aussi la persistance métier associée (`filename`, `storage_path`, `content_hash`, compte/totaux`) avec test dédié,
  - en cas d'échec de persistance SQL après écriture du binaire archivé, vérifier le nettoyage immédiat du fichier temporaire/stocké pour éviter les archives orphelines,
  - si l'US mentionne un déclencheur utilisateur (bouton, sélecteur année, action toolbar), vérifier que le wiring UI existe réellement dans la page cible et pas seulement des helpers/tests isolés,
  - pour tout rendu tabulaire PDF multi-colonnes, calcul de hauteur de ligne basé sur la cellule la plus haute (pas seulement la dernière colonne dessinée) afin d'éviter les chevauchements de lignes,
  - pour toute pagination de tableau PDF, décider le saut de page à partir de la hauteur de la prochaine ligne + espace de séparation/footer (pas uniquement sur le `doc.y` courant), avec test de non-régression sur une ligne haute proche du bas de page.

- Pour tout export XML métier (PESV2, pain.008, flux DGFiP), vérifier en review:
  - sélection métier exclusive et explicite (campagne **ou** période, jamais les deux),
  - validation XSD automatisée dans les tests et au runtime avant restitution,
  - cohérence namespace XML/XSD: `targetNamespace` défini dans le schéma et document exporté namespacé avec l'URI ISO attendue,
  - réponse client sûre: détails techniques complets en logs serveur seulement, message générique côté API si l'échec est interne,
  - entêtes de téléchargement cohérents (`Content-Type`, `Content-Disposition`) et nommage déterministe du fichier.
- Pour toute US de prélèvement/mandat SEPA, vérifier explicitement:
  - présence d'une table métier dédiée (`mandats_sepa`, `sepa_exports`, `sepa_prelevements`, table de liaison si lot),
  - contrôle IBAN/BIC avant persistance, avec restitution masquée de l'IBAN côté UI/API,
  - validation des coordonnées créancier configurées (`TLPE_SEPA_CREDITOR_IBAN`, `TLPE_SEPA_CREDITOR_BIC`) avant génération du XML, avec échec interne générique si la configuration runtime est invalide,
  - impossibilité d'avoir plusieurs mandats `actif` pour un même assujetti sans révocation explicite du précédent, idéalement protégée aussi par une contrainte DB / index unique partiel et pas uniquement par l'API,
  - séquencement `FRST` / `RCUR` basé sur l'historique réel des prélèvements déjà exportés,
  - exclusion des mandats révoqués ou sans solde exigible,
  - traçabilité `audit_log` pour création de mandat et export du lot,
  - classification d'erreur explicite: erreurs de saisie / sélection métier en 4xx, erreurs internes runtime/XSD/xmllint/configuration bancaire en 5xx générique sans fuite de détails serveur au client.
- Pour tout téléchargement binaire déclenché par un POST JSON, vérifier en review:
  - `Content-Type: application/json` bien envoyé côté client,
  - conservation du nom de fichier renvoyé par le backend (`Content-Disposition`) quand il porte un identifiant métier incrémental.
- Pour toute route d'import/parsing de fichier métier (CSV/XLSX/OFX/MT940/XML), vérifier en review:
  - distinction explicite entre erreurs de validation utilisateur/parsing attendu (4xx avec message exploitable) et erreurs inattendues de persistance/runtime (5xx générique sans fuite de détails internes),
  - présence d'un test de non-régression couvrant au moins un cas 4xx métier et un cas 5xx interne masqué,
  - journalisation serveur des erreurs inattendues avant réponse 5xx.
- Pour toute nouvelle table métier SQLite, vérifier en review:
  - migration runtime idempotente pour les bases legacy,
  - éviter `ALTER TABLE ... ADD COLUMN ... DEFAULT (datetime('now'))` ou toute autre expression non constante: reconstruire la table si une valeur dérivée/fonctionnelle est nécessaire,
  - ajout/reconstruction des `CHECK`/`UNIQUE` au runtime pour les bases legacy (pas seulement dans `schema.sql`),
  - ne pas ajouter d'index explicite qui duplique un index implicite déjà créé par une contrainte `UNIQUE` ou `PRIMARY KEY` identique,
  - nettoyage explicite des nouvelles tables dans les fixtures de tests qui purgent `campagnes`/tables parentes,
  - ordre de purge compatible FK dans les fixtures (supprimer d'abord les tables enfants, ex. `evenements_contentieux` puis `contentieux`, puis `titres`),
  - non-régression sur une base locale préexistante (pas seulement sur une base de test vierge).
- Pour toute US de timeline / chronologie métier (contentieux, workflow, notifications), vérifier explicitement:
  - alimentation automatique des événements système (création, changement de statut, décision),
  - les événements système utilisent leur **date métier réelle** (ex. décision/statut = date du jour ou date explicitement fournie), sans se décaler artificiellement sur la date d'un événement futur déjà saisi dans la timeline,
  - ordre chronologique stable quand des événements manuels antérieurs ou futurs sont saisis après coup (tri par date métier, pas seulement par date de création),
  - export documentaire (PDF) cohérent avec la timeline affichée et journalisé dans `audit_log`,
  - UI sans prompt navigateur bloquant si une saisie métier structurée est attendue,
  - pour tout chargement asynchrone UI par ligne/dossier, vérifier qu'un retour tardif d'une requête précédente ne réinitialise pas l'état de chargement du dossier actuellement ouvert (loading state clé par id, ou nettoyage conditionnel),
  - champs `input[type=date]` préremplis avec une date locale (pas `toISOString().slice(0, 10)` brut, sensible à l'UTC),
  - validation calendrier stricte côté API pour toute date métier saisie manuellement (`YYYY-MM-DD` réel, pas seulement regex permissive type `2026-02-30`),
  - si un événement référence une `piece_jointe_id`, vérifier que la pièce jointe appartient bien à la même entité métier (ici le même `contentieux`) avant persistance,
  - ne jamais exposer dans l'API/PDF des métadonnées de pièce jointe (`piece_jointe_id`, nom, entité liée, `entite_id`) à un rôle qui ne pourrait pas télécharger effectivement cette pièce via `piecesJointesRouter`.
- Commandes minimales à exécuter:
- `npm test`
- `npm run test:all`
- `npm run build`
- `npm run dev` puis smoke test backend (`/api/health`) et frontend (URL locale réelle, y compris port alternatif si 4000/5173 occupés)

### 8) Hygiène dépôt & artefacts runtime (appris sur US3.6)
- Vérifier que les artefacts générés en test/dev (`server/data/receipts/*`, `server/data/mises_en_demeure/*`) ne polluent pas le diff Git.
- Maintenir `.gitignore` aligné avec les nouveaux répertoires de sorties runtime avant push.
- En review, confirmer qu'aucun fichier binaire/généré n'est commité par inadvertance.

### 9) KPI Dashboard déclaratif (appris sur US3.7)
- Vérifier que `declarations_recues` ne compte que `soumise|validee|rejetee` (jamais `brouillon`).
- Vérifier que la décomposition (`soumises`, `validées`, `rejetées`) est cohérente avec le total et le taux.
- Vérifier que le drilldown est testé (au moins un cas par zone + un cas par type d'assujetti).
- Vérifier que l'évolution journalière est bornée par la campagne active (`date_ouverture` → `date_limite_declaration`) et non une fenêtre implicite.
- Vérifier un test backend dédié pour les KPI dashboard (pas seulement un test UI).

### 10) Démarrage prod & assets runtime (appris sur US4.1)
- Vérifier le démarrage **après build** avec `npm start`, pas seulement en mode dev/test.
- Si le backend charge des assets runtime (ex: `schema.sql`, templates PDF, fichiers statiques), vérifier qu'ils sont disponibles depuis `dist/` ou qu'un fallback explicite vers `src/` existe.
- Ajouter un test de non-régression quand un chemin runtime dépend de `__dirname` pour éviter les démarrages cassés en production.

### 11) Quote-part dispositifs numériques partagés (appris sur US4.1)
- Vérifier la présence d'un `CHECK (quote_part >= 0 AND quote_part <= 1)` au schéma + migration runtime idempotente (`ALTER TABLE` si colonne absente).
- Vérifier que la validation API bloque les payloads hors plage `[0,1]` et rejette toute somme de quote-parts `> 1.0` pour un même dispositif dans une même déclaration.
- Vérifier que le moteur de calcul applique la quote-part **après** barème/prorata/coefficient/exonération, puis arrondi métier inchangé (euro inférieur).
- Vérifier au moins 2 tests unitaires dédiés: cas multi-annonceurs (2/3 quote-parts) et cas d'entrée invalide (`quote_part > 1`).
- Vérifier la restitution UI/PDF: saisie avec défaut `1.0` et affichage explicite du pourcentage (ex. `33 %`) sur le titre de recettes.

### 12) Paiement en ligne & callbacks signés (appris sur US5.3)
- Vérifier que l'initiation de paiement est réservée au contribuable propriétaire du titre et bloque tout accès inter-assujetti.
- Vérifier que la redirection signée persiste les paramètres métier minimaux (`numero_titre`, `montant`, `reference`, URLs de retour/callback) et qu'ils sont couverts par une MAC/HMAC testée.
- Vérifier l'idempotence des callbacks via un identifiant de transaction unique (`transaction_id`) pour éviter les doubles rapprochements.
- Vérifier le mapping métier des statuts externes (`success/cancel/failed` → statut paiement + impact ou non sur le solde du titre).
- Vérifier la traçabilité complète du paiement externe: `provider`, `statut`, `transaction_id`, payload callback brut et `audit_log` dédié.
- Vérifier la cohérence documentation/configuration/UI: route frontend de confirmation réellement exposée, variable `TLPE_PAYFIP_RETURN_URL` alignée avec cette route, tests UI couvrant succès + annulation/refus.

### 13) Rapprochement bancaire automatique / manuel (appris sur US5.6)
- Vérifier que le rapprochement automatique ne crée un `paiement` que pour une écriture bancaire strictement positive et un titre réellement détecté dans le libellé ou la référence.
- Vérifier que les cas métier d'exception restent en attente avec workflow explicite et testé (`partiel`, `excedentaire`, `erreur_reference`, `errone`) sans solder abusivement le titre.
- Vérifier que le journal des rapprochements expose bien `mode` (`auto|manuel`), `resultat`, `numero_titre`, `user_display` et `created_at`, avec au moins un test backend couvrant auto + manuel.
- Vérifier qu'un rapprochement manuel crée un paiement `modalite=virement`, met à jour `montant_paye/statut` du titre, trace `audit_log`, et rejette proprement les lignes déjà rapprochées ou non encaissables.

### 14) Recouvrement des impayés & escalade post-échéance (appris sur US5.7)
- Vérifier que l'escalade post-échéance déclenche **exactement** à J+10 / J+30 / J+60 sur `date_echeance`, sans relance répétée hors jalon.
- Vérifier une idempotence technique et métier (contrainte DB ou garde explicite) empêchant les doublons pour un même `titre` + `niveau`.
- Vérifier les exclusions métier bloquantes : aucun déclenchement sur les titres soldés, en `contentieux`, ou sous `moratoire` accordé / en instruction.
- Vérifier qu'une action J+30 génère une mise en demeure traçable (PDF ou pièce jointe persistée), met à jour le statut du titre de façon cohérente et journalise l'action dans `audit_log`.
- Vérifier qu'une action J+60 expose une preuve exploitable de transmission / préparation comptable (`download_url`, canal, horodatage) et qu'elle reste consultable dans l'historique du titre.
- Vérifier qu'un endpoint/API d'historique de recouvrement respecte les droits d'accès du contribuable (pas d'accès inter-assujetti) et qu'un test couvre cette restitution.
- Vérifier que le scheduler quotidien exécute aussi ce workflow et qu'un smoke test de démarrage confirme que l'application démarre toujours après intégration du job.

### 15) Titre exécutoire & transmission comptable public (appris sur US5.9)
- Vérifier la cohérence **machine à états backend + UI** quand un nouveau statut titre est introduit (`transmis_comptable`, `admis_en_non_valeur`) : schéma SQL, migration runtime, filtres de liste, badges/libellés et actions visibles.
- Vérifier que `POST /api/titres/:id/rendre-executoire` est réservé à `admin|financier`, refuse tout statut hors `mise_en_demeure`, persiste un export immuable dédié (`titres_executoires`) avec hash, mention de visa/signature, auteur et horodatage.
- Vérifier qu'un téléchargement binaire métier déclenché par POST conserve le `Content-Disposition` backend côté UI et qu'un test couvre explicitement cette restitution.
- Vérifier que le flux XML complémentaire est validé XSD au runtime **et** que le schéma reste accessible après build (`dist/` ou fallback `src/`), avec réponse client générique sur erreur interne et logs serveur détaillés.
- Vérifier qu'une admission en non-valeur ne soit possible qu'après `transmis_comptable`, qu'elle crée un événement distinct de retour comptable dans l'historique, et qu'un commentaire métier soit restitué côté UI.
- Vérifier que le bouton/accès `Historique` reste visible pour les statuts terminaux de recouvrement (`transmis_comptable`, `admis_en_non_valeur`) afin d'éviter de masquer la traçabilité après action utilisateur.
- Vérifier l'idempotence métier/technique de la transmission comptable et du retour négatif (contrainte DB ou garde explicite) pour éviter les doublons de flux ou d'actions de recouvrement.

### 16) Délais légaux contentieux & alertes (appris sur US6.2)
- Vérifier que `POST /api/contentieux` calcule automatiquement `date_limite_reponse` depuis `date_ouverture` (+6 mois, clamp calendrier) et expose le résumé d'échéance (`days_remaining`, `niveau_alerte`, `overdue`, `extended`) dans `GET /api/contentieux`.
- Vérifier la cohérence schéma SQL + migration runtime + types UI pour les nouveaux champs `date_limite_reponse`, `date_limite_reponse_initiale`, `delai_prolonge_*` ainsi que pour la table `contentieux_alerts`.
- Vérifier qu'une migration runtime backfill aussi les dossiers legacy déjà ouverts quand un nouveau champ d'échéance est introduit (pas seulement les nouvelles créations), avec test dédié sur base préexistante.
- Vérifier que `POST /api/contentieux/:id/prolonger-delai` est protégé, refuse toute date <= échéance courante, exige une justification métier, écrit un `audit_log` et ajoute un événement timeline explicite.
- Vérifier l'idempotence du job quotidien d'alertes contentieux (unicité par `contentieux_id + niveau_alerte + date_echeance`) et la traçabilité complète dans `contentieux_alerts`, `notifications_email` et `audit_log`.
- Vérifier que les emails d'alerte contentieux ciblent bien un gestionnaire si disponible, sinon un fallback explicite, avec statuts `pending|envoye|echec` sans doublons silencieux.
- Vérifier que les helpers de dates métier partagés rejettent les dates calendrier impossibles (`2026-02-30`, mois 13, etc.), pas seulement les routes HTTP.
- Vérifier que les fixtures de tests purgent explicitement toute nouvelle table enfant (`contentieux_alerts`, etc.) même quand les FK sont temporairement désactivées.
- Vérifier la restitution UX: badge d'échéance lisible, surlignage rouge des dossiers en dépassement, KPI dashboard distincts pour `<= J-30` et `dépassement`, couverture de tests front + back.

### 17) Pièces jointes contentieux catégorisées (appris sur US6.3)
- Vérifier la cohérence schéma SQL + migration runtime + API quand `pieces_jointes` reçoit un nouveau champ métier (`type_piece`) : présence de la colonne, de la contrainte `CHECK`, et reprise idempotente des bases legacy.
- Vérifier que les catégories métier contentieux sont **bornées à l’entité `contentieux` elle-même** dans la contrainte SQL/runtime (`type_piece IS NULL OR (entite='contentieux' AND ...)`) pour éviter d’autoriser `courrier-admin|decision|jugement` sur d’autres entités.
- Vérifier que toute nouvelle suite de tests backend ajoutée pour la feature est bien branchée dans le script `npm test` du workspace concerné (pas seulement présente sur disque).
- Vérifier que `GET /api/contentieux/:id/pieces-jointes` restitue bien les métadonnées utiles (`type_piece`, libellé, auteur, date, `download_url`) sans exposer plus que les droits du rôle courant.
- Vérifier que le contribuable est restreint à `courrier-contribuable` à l’upload, reste en lecture seule sur les pièces administration, et qu’une suppression `DELETE /api/pieces-jointes/:id` sur entité `contentieux` est explicitement refusée pour ce rôle.
- Vérifier la couverture UI minimale : liste des pièces, aperçu PDF/image, téléchargement, et états de chargement stables quand on change de dossier rapidement.
- Vérifier qu'un changement de pièce sélectionnée invalide immédiatement l’aperçu courant (reset de l’URL/blob et de l’état d’erreur) pour éviter d’afficher le document précédemment prévisualisé.
- Vérifier que la documentation fonctionnelle/README mentionne l’US livrée, ses smoke tests et les nouvelles catégories métier de pièces jointes.
- Pour toute US de contrôle terrain / formulaire mobile navigateur, vérifier explicitement :
  - route métier dédiée protégée par `authMiddleware` + `requireRole('admin','gestionnaire','controleur')` et audit `logAudit()` sur la création du constat,
  - possibilité de rattacher le constat à un dispositif existant **ou** de créer une fiche dispositif depuis le constat, avec test backend pour les deux chemins,
  - support des photos via `pieces_jointes.entite='controle'`, y compris migration runtime idempotente pour les bases legacy,
  - restitution utilisateur exploitable des erreurs Zod côté API/UI (premier message clair, pas seulement un objet sérialisé `[object Object]`),
  - date par défaut des formulaires `input[type=date]` calculée en local browser (pas `toISOString().slice(0,10)` brut, sensible à l’UTC),
  - si un mode hors-ligne navigateur est annoncé, vérifier IndexedDB + synchronisation au retour réseau + présence d’un smoke test de démarrage/service worker, sans confondre cela avec une application mobile native hors périmètre MVP,
  - le service worker ne doit mettre en cache que des réponses GET same-origin réussies et pertinentes pour le shell statique (pas les documents HTML de navigation ni des réponses en erreur/transitoires),
  - le service worker ne doit renvoyer `index.html` qu’aux requêtes de navigation ; un asset statique manquant/offline ne doit pas recevoir du HTML en fallback,
  - l’état `en ligne / hors ligne` affiché dans l’UI doit être réactif (`useState` + listeners `online`/`offline`), pas une simple lecture ponctuelle de `navigator.onLine` dans le rendu,
  - la synchronisation des brouillons hors-ligne doit être protégée contre les doubles déclenchements concurrents (verrou/ref explicite côté UI ou idempotence équivalente) pour éviter les doublons de constats au retour réseau,
  - après création serveur réussie d’un constat hors-ligne, le brouillon IndexedDB doit être retiré avant l’upload des photos ; un échec d’upload ne doit jamais re-poster le même constat au prochain retry,
  - le sélecteur de fichiers UI pour `entite='controle'` doit rester aligné avec la validation backend (photos `jpeg/png` uniquement, jamais `application/pdf`),
  - les uploads de pièces jointes `entite='controle'` doivent être limités aux photos terrain (`image/jpeg|image/png`), même si d’autres entités métier autorisent aussi les PDF,
  - la création d’un dispositif depuis un constat terrain doit convertir tout échec FK SQLite (`assujetti/type/zone` introuvable) en réponse 4xx métier exploitable, jamais en 500 brut,
  - la création du dispositif, l’insertion du contrôle, la mise à jour de statut et les audits associés doivent être enveloppés dans une transaction SQLite unique pour éviter tout write partiel si une étape aval échoue,
  - pour toute US de rapport de contrôle / rectification / redressement, refuser explicitement les constats non `cloture` avant export PDF/XLSX, génération de déclaration d’office/demande contribuable ou ouverture de contentieux, avec test 409 de non-régression.
  - toute numérotation métier créée en lot depuis ces actions (`DEC-*`, `CTX-*`) doit être réservée via une table de séquence/persistance dédiée plutôt qu’un `COUNT(*) + 1`, avec backfill legacy et couverture de test.

## Format de sortie review

1. **Résumé**
2. **Points bloquants (must fix)**
3. **Suggestions (nice to have)**
4. **Verdict**: Approve / Comment / Request changes

## Template commentaire PR

```md
## Review TLPE

### ✅ Points positifs
- ...

### 🔴 Points bloquants
- ...

### 💡 Suggestions
- ...

### Verdict
Request changes
```
