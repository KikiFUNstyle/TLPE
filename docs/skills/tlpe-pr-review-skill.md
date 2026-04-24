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
- Pour toute US de mise en demeure sur titres, vérifier explicitement en review :
  - route manuelle sécurisée (`POST /api/titres/:id/mise-en-demeure`) + route batch sécurisée (`POST /api/titres/mises-en-demeure/batch`),
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
  - écriture d'une trace `audit_log` dédiée à l'export.
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
  - nettoyage explicite des nouvelles tables dans les fixtures de tests qui purgent `campagnes`/tables parentes,
  - ordre de purge compatible FK dans les fixtures (supprimer d'abord les tables enfants, ex. `contentieux` avant `titres`),
  - non-régression sur une base locale préexistante (pas seulement sur une base de test vierge).
- Commandes minimales à exécuter:
  - `npm test`
  - `npm run build`

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
