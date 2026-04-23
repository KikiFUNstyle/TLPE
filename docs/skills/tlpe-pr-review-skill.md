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
- Pour toute US avec document généré (PDF, accusé, courrier), ajouter un test API qui valide la présence des métadonnées de restitution (`token/hash/download_url`) et un test service qui vérifie la persistance + réutilisation idempotente.
- Pour tout export binaire métier (PDF/XLSX bordereau, titre, rapport), vérifier en review:
  - contrôle d'accès explicite par rôle,
  - filtrage métier exact des données exportées,
  - présence d'un horodatage + hash du contenu restitué,
  - écriture d'une trace `audit_log` dédiée à l'export.
- Pour tout export XML métier (PESV2, pain.008, flux DGFiP), vérifier en review:
  - sélection métier exclusive et explicite (campagne **ou** période, jamais les deux),
  - validation XSD automatisée dans les tests et au runtime avant restitution,
  - anti-réexport par défaut avec confirmation explicite et journal des titres déjà transmis,
  - incrément strict du numéro de bordereau / lot d'envoi,
  - persistance du hash XML + statut de validation dans la base,
  - classification d'erreur explicite: erreurs de saisie / sélection métier en 4xx, erreurs internes runtime/XSD/xmllint en 5xx générique sans fuite de détails serveur au client.
- Pour tout téléchargement binaire déclenché par un POST JSON, vérifier en review:
  - `Content-Type: application/json` bien envoyé côté client,
  - conservation du nom de fichier renvoyé par le backend (`Content-Disposition`) quand il porte un identifiant métier incrémental.
- Pour toute nouvelle table métier SQLite, vérifier en review:
  - migration runtime idempotente pour les bases legacy,
  - nettoyage explicite des nouvelles tables dans les fixtures de tests qui purgent `campagnes`/tables parentes,
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
