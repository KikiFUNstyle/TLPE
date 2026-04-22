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

### 5) Tests
- Couvrir happy path + edge cases + erreurs validation.
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
