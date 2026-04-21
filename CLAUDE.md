# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commandes

```bash
npm run install:all        # install racine + workspaces server/client
npm run dev                # API :4000 + client Vite :5173 (concurrently)
npm run dev:server         # API seule (tsx watch)
npm run dev:client         # front seul
npm run build              # tsc client puis tsc server (dist/)
npm start                  # node dist/index.js (sert aussi client/dist en prod)
npm run seed               # seed explicite (auto-exécuté si users vide au boot)
npm test                   # tests moteur de calcul (node --test via tsx)
```

Reset complet de la base : `rm -f server/data/tlpe.db && npm run seed`.
Lancer un test unique du moteur : `npx tsx --test --test-name-pattern="<regex>" server/src/calculator.test.ts`.

## Architecture

Monorepo npm workspaces : `server/` (Express + better-sqlite3) et `client/` (React 18 + Vite). En production, l'API sert aussi `client/dist` sur le même port (4000) ; en dev Vite proxyfie `/api` → `:4000` (cf. `client/vite.config.ts`).

### Backend — couches

- `server/src/index.ts` : bootstrap. Appelle `initSchema()` (exécute `schema.sql` avec `CREATE TABLE IF NOT EXISTS`) puis auto-seed si la table `users` est vide.
- `server/src/db.ts` : singleton `better-sqlite3` (WAL + foreign_keys). Expose `logAudit()` — à appeler à chaque mutation métier (cf. §12.2 des specs).
- `server/src/auth.ts` : JWT 12h (`TLPE_JWT_SECRET`), bcrypt, middleware `authMiddleware` + helper `requireRole(...roles)`. Les 5 rôles sont `admin | gestionnaire | financier | controleur | contribuable`. Chaque `contribuable` est rattaché à un `assujetti_id` — filtrer systématiquement les requêtes par ce champ pour ce rôle (voir pattern dans `routes/declarations.ts`).
- `server/src/routes/*` : un routeur Express par domaine monté sous `/api/<nom>`. Validation d'entrée via `zod`.
- `server/src/calculator.ts` : **cœur métier, pur et testable**. Appelé par `simulateur` (stateless) et par `declarations.valider` (persistance dans `lignes_declaration`). Ne jamais dupliquer cette logique côté routes.
- `server/src/schema.sql` : source unique de vérité du modèle. Les contraintes `CHECK` encodent les machines à états (voir ci-dessous).

### Machines à états (à respecter pour toute mutation)

- `declarations.statut` : `brouillon → soumise → validee` (ou `rejetee` / `en_instruction`). Une déclaration `soumise` ou `validee` n'est plus modifiable (lignes figées). La soumission calcule un `hash_soumission` SHA-256 du snapshot des lignes (accusé réception, §5.2). La validation déclenche `calculerTLPE` sur chaque ligne et archive le détail dans `lignes_declaration` (bareme_id, tarif_applique, coefficient_zone, prorata, montant_ligne).
- `titres.statut` : `emis → paye_partiel → paye` ou `impaye → mise_en_demeure → admis_en_non_valeur`. Le cumul `montant_paye` est recalculé à partir de la table `paiements`.
- Un titre est émis à partir d'une déclaration `validee` (contrainte `UNIQUE (declaration_id)` dans `titres`).

### Moteur de calcul (specs §6)

Formule : `Montant = surface × nombre_faces × tarif × coefficient_zone × (jours / 365)`. Particularités :

- `findBareme(annee, categorie, surface_effective)` prend l'année barème la plus récente ≤ `annee` (permet d'antidater sans re-seeder).
- Trois formes de tarif dans `baremes` : `tarif_m2` (au m²), `tarif_fixe` (forfait, ex. enseignes 7-12 m²), ou `exonere=1` (ex. enseignes ≤ 7 m²). Le champ `exonere` du dispositif court-circuite tout.
- Arrondi : `sous_total` arrondi à 2 décimales pour le détail, `montant_arrondi = floor(sous_total)` pour le montant facturé (arrondi à l'euro inférieur).
- Prorata inclusif : `(depose - pose) / 86400000 + 1` jours, plafonné à 1.

### Frontend

- Point d'entrée `client/src/App.tsx` : layout header/sidebar/main, routage conditionné par `user.role` (le contribuable n'accède qu'à `/declarations`, `/titres`, `/contentieux`, `/simulateur`).
- `client/src/api.ts` : wrapper `fetch` minimal. Stocke le JWT dans `localStorage` et redirige sur `/login` à tout 401.
- `client/src/auth.tsx` : contexte `useAuth()` — source unique de l'utilisateur courant.
- Pas de lib UI : styles dans `client/src/styles.css`, composants en JSX direct dans `pages/`.

## Conventions

- Langue : toute la UI, les libellés métier, les commentaires et les messages d'erreur sont en **français**. Les identifiants (tables, colonnes, fonctions) mélangent français et anglais — respecter le style local du fichier édité.
- Les commits font référence aux sections des specs (§3, §6.3, etc.) — conserver cette convention quand on ajoute des règles métier.
- Avant toute évolution du moteur de calcul, mettre à jour `calculator.test.ts` et vérifier que `npm test` passe.
- Le seed est idempotent (vérifie `count > 0` avant d'insérer). Ne pas réécrire cette logique en `DELETE + INSERT`.
- Ne jamais exposer de route métier sans `authMiddleware` + `requireRole(...)` approprié, et appeler `logAudit()` pour toute mutation sensible.

## Hors périmètre MVP

Ne pas proposer (sauf demande explicite) : intégrations FranceConnect+/PayFip/BAN/PESV2, app mobile terrain, import SIG/Shapefile, signature électronique, conformité RGAA complète. Cf. README section « Hors périmètre du MVP ».
