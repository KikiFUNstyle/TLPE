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
- Les non-déclarants sont les assujettis actifs **sans déclaration soumise/validée** sur l'année de campagne.
- La déclaration d'office doit être créée/normalisée au statut `en_instruction` avec marque explicite (commentaire/flag).
- Le PDF de mise en demeure doit réutiliser l'historique N-1 (lignes de déclaration) et seulement fallback sur les dispositifs courants si l'historique est absent.
- Si email manquant, tracer un échec explicite (`notifications_email.statut='echec'`) et conserver la mise en demeure en `a_traiter`.

### 7) Tests
- Couvrir happy path + edge cases + erreurs validation.
- Ajouter des tests d'idempotence pour tout envoi batch/notification.
- Vérifier qu'un test échoue avant fix (TDD) quand c'est possible.
- Commandes minimales à exécuter:
  - `npm test`
  - `npm run build`

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
