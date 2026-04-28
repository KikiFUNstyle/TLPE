# Backlog User Stories — TLPE Manager

Ce document consolide l'ensemble des User Stories couvrant le périmètre complet des spécifications fonctionnelles et techniques (`specs/fonctionnelle/TLPE Manager Specifications.docx`, version 1.0 Draft — Avril 2026).

Chaque US fait l'objet d'une issue GitHub détaillée (contexte spec, critères d'acceptation, notes techniques, définition de terminé). Le tableau ci-dessous sert d'index de navigation.

## Légende

- **Phase** : découpage des specs §15.1 (P1 référentiels/assujettis → P7 recette/déploiement)
- **Priorité** : P0 critique MVP · P1 important · P2 nice-to-have
- **MVP** : ✅ inclus dans le MVP · 🚫 explicitement hors-MVP (cf. CLAUDE.md)

## Synthèse par épopée

| Épopée | Nb US | Issues |
|---|---|---|
| EPIC 1 — Référentiels | 3 | #1, #2, #3 |
| EPIC 2 — Assujettis & Dispositifs | 6 | #4 → #9 |
| EPIC 3 — Déclarations | 7 | #10 → #16 |
| EPIC 4 — Moteur de calcul | 1 | #17 |
| EPIC 5 — Titres & Paiements | 9 | #18 → #26 |
| EPIC 6 — Contentieux | 3 | #27, #28, #29 |
| EPIC 7 — Contrôle terrain | 3 | #30, #31, #32 |
| EPIC 8 — Reporting | 8 | #33 → #40 |
| EPIC 9 — Portail contribuable | 3 | #41, #42, #43 |
| EPIC 10 — Sécurité, qualité, exploitation | 6 | #44 → #49 |
| EPIC 11 — Notifications transverses | 3 | #50, #51, #52 |
| **Total** | **52** | |

## EPIC 1 — Référentiels (§3)

| # | Titre | Spec | Phase | Prio | MVP |
|---|---|---|---|---|---|
| [#1](https://github.com/KikiFUNstyle/TLPE/issues/1) | US1.1 Mise à jour annuelle automatique des barèmes TLPE | §3.1 | P1 | P1 | ✅ |
| [#2](https://github.com/KikiFUNstyle/TLPE/issues/2) | US1.2 Gérer les zones tarifaires via import SIG | §3.3 | P1 | P2 | 🚫 |
| [#3](https://github.com/KikiFUNstyle/TLPE/issues/3) | US1.3 Gérer les exonérations et abattements délibérés | §3.4 | P1 | P1 | ✅ |

## EPIC 2 — Assujettis & Dispositifs (§4)

| # | Titre | Spec | Phase | Prio | MVP |
|---|---|---|---|---|---|
| [#4](https://github.com/KikiFUNstyle/TLPE/issues/4) | US2.1 Import en masse des assujettis (CSV/Excel) | §4.3 | P1 | P0 | ✅ |
| [#5](https://github.com/KikiFUNstyle/TLPE/issues/5) | US2.2 Import en masse des dispositifs (CSV/Excel) | §4.3 | P1 | P0 | ✅ |
| [#6](https://github.com/KikiFUNstyle/TLPE/issues/6) | US2.3 Vérification SIRET via API Entreprise (SIRENE) | §13.1 | P6 | P2 | 🚫 |
| [#7](https://github.com/KikiFUNstyle/TLPE/issues/7) | US2.4 Géocodage automatique des adresses via BAN | §13.1, §4.2 | P6 | P2 | 🚫 |
| [#8](https://github.com/KikiFUNstyle/TLPE/issues/8) | US2.5 Gestion des pièces jointes (photos, plans) | §4.2, §5.2, §8.2 | P1 | P1 | ✅ |
| [#9](https://github.com/KikiFUNstyle/TLPE/issues/9) | US2.6 Visualisation cartographique des dispositifs | §4.2, §10.2 | P6 | P1 | ✅ |

## EPIC 3 — Déclarations (§5)

| # | Titre | Spec | Phase | Prio | MVP |
|---|---|---|---|---|---|
| [#10](https://github.com/KikiFUNstyle/TLPE/issues/10) | US3.1 Ouverture/paramétrage campagne déclarative | §5.1 | P2 | P0 | ✅ |
| [#11](https://github.com/KikiFUNstyle/TLPE/issues/11) | US3.2 Invitations à déclarer par email | §5.1 | P2 | P0 | ✅ |
| [#12](https://github.com/KikiFUNstyle/TLPE/issues/12) | US3.3 Contrôles automatiques avancés | §5.3 | P2 | P1 | ✅ |
| [#13](https://github.com/KikiFUNstyle/TLPE/issues/13) | US3.4 Relances automatiques J-30 / J-15 / J-7 | §5.4 | P3 | P0 | ✅ |
| [#14](https://github.com/KikiFUNstyle/TLPE/issues/14) | US3.5 Mise en demeure automatique J+1 | §5.4 | P3 | P1 | ✅ |
| [#15](https://github.com/KikiFUNstyle/TLPE/issues/15) | US3.6 Accusé de réception PDF horodaté | §5.2 | P2 | P1 | ✅ |
| [#16](https://github.com/KikiFUNstyle/TLPE/issues/16) | US3.7 Tableau de bord taux de déclaration temps réel | §5.4 | P2 | P1 | ✅ |

## EPIC 4 — Moteur de calcul (§6)

| # | Titre | Spec | Phase | Prio | MVP |
|---|---|---|---|---|---|
| [#17](https://github.com/KikiFUNstyle/TLPE/issues/17) | US4.1 Quote-part dispositifs numériques partagés | §6.2 | P2 | P2 | ✅ |

## EPIC 5 — Titres & Paiements (§7)

| # | Titre | Spec | Phase | Prio | MVP |
|---|---|---|---|---|---|
| [#18](https://github.com/KikiFUNstyle/TLPE/issues/18) | US5.1 Bordereau récapitulatif titres (PDF + Excel) | §7.1 | P2 | P1 | ✅ |
| [#19](https://github.com/KikiFUNstyle/TLPE/issues/19) | US5.2 Export PESV2 Hélios (XML) | §7.1, §13.1 | P6 | P1 | 🚫 |
| [#20](https://github.com/KikiFUNstyle/TLPE/issues/20) | US5.3 Paiement en ligne via PayFip/Tipi | §7.2, §13.1 | P6 | P1 | 🚫 |
| [#21](https://github.com/KikiFUNstyle/TLPE/issues/21) | US5.4 Mandats SEPA + génération pain.008 XML | §7.2 | P3 | P1 | ✅ |
| [#22](https://github.com/KikiFUNstyle/TLPE/issues/22) | US5.5 Import de relevés bancaires (OFX/CSV/MT940) | §7.3 | P3 | P1 | ✅ |
| [#23](https://github.com/KikiFUNstyle/TLPE/issues/23) | US5.6 Rapprochement bancaire automatique | §7.3 | P3 | P1 | ✅ |
| [#24](https://github.com/KikiFUNstyle/TLPE/issues/24) | US5.7 Escalade automatique impayés (J+10/J+30/J+60) | §7.4 | P3 | P0 | ✅ |
| [#25](https://github.com/KikiFUNstyle/TLPE/issues/25) | US5.8 Génération PDF des mises en demeure | §5.4, §7.4 | P3 | P1 | ✅ |
| [#26](https://github.com/KikiFUNstyle/TLPE/issues/26) | US5.9 Titre exécutoire — transmission comptable public | §7.4 | P3 | P1 | ✅ |

## EPIC 6 — Contentieux (§8)

| # | Titre | Spec | Phase | Prio | MVP |
|---|---|---|---|---|---|
| [#27](https://github.com/KikiFUNstyle/TLPE/issues/27) | US6.1 Timeline chronologique automatique | §8.2 | P5 | P1 | ✅ |
| [#28](https://github.com/KikiFUNstyle/TLPE/issues/28) | US6.2 Alertes sur délais légaux | §8.3 | P5 | P1 | ✅ |
| [#29](https://github.com/KikiFUNstyle/TLPE/issues/29) | US6.3 Pièces jointes contentieux | §8.2 | P5 | P1 | ✅ |

## EPIC 7 — Contrôle terrain (§9)

| # | Titre | Spec | Phase | Prio | MVP |
|---|---|---|---|---|---|
| [#30](https://github.com/KikiFUNstyle/TLPE/issues/30) | US7.1 Saisie constat terrain (web + géoloc + photos) | §9.1, §9.2 | P5 | P1 | 🚫 |
| [#31](https://github.com/KikiFUNstyle/TLPE/issues/31) | US7.2 Application mobile iOS/Android | §9.2 | P5 | P2 | 🚫 |
| [#32](https://github.com/KikiFUNstyle/TLPE/issues/32) | US7.3 Rapport de contrôle automatique | §9.3 | P5 | P1 | ✅ |

## EPIC 8 — Reporting (§10)

| # | Titre | Spec | Phase | Prio | MVP |
|---|---|---|---|---|---|
| [#33](https://github.com/KikiFUNstyle/TLPE/issues/33) | US8.1 Rapport « Rôle de la TLPE » | §10.2 | P6 | P1 | ✅ |
| [#34](https://github.com/KikiFUNstyle/TLPE/issues/34) | US8.2 État de recouvrement (assujetti/zone/type) | §10.2 | P6 | P1 | ✅ |
| [#35](https://github.com/KikiFUNstyle/TLPE/issues/35) | US8.3 Suivi des relances et mises en demeure | §10.2 | P6 | P1 | ✅ |
| [#36](https://github.com/KikiFUNstyle/TLPE/issues/36) | US8.4 Synthèse des contentieux en cours | §10.2 | P6 | P1 | ✅ |
| [#37](https://github.com/KikiFUNstyle/TLPE/issues/37) | US8.5 Comparatif pluriannuel (3 ans glissants) | §10.2 | P6 | P2 | ✅ |
| [#38](https://github.com/KikiFUNstyle/TLPE/issues/38) | US8.6 Carte choroplèthe des recettes | §10.2 | P6 | P2 | ✅ |
| [#39](https://github.com/KikiFUNstyle/TLPE/issues/39) | US8.7 Export DGFiP déclaration recettes fiscales | §10.3 | P6 | P2 | 🚫 |
| [#40](https://github.com/KikiFUNstyle/TLPE/issues/40) | US8.8 Export CSV/Excel personnalisable | §10.3 | P6 | P2 | ✅ |

## EPIC 9 — Portail contribuable (§11)

| # | Titre | Spec | Phase | Prio | MVP |
|---|---|---|---|---|---|
| [#41](https://github.com/KikiFUNstyle/TLPE/issues/41) | US9.1 Double authentification TOTP | §11.1 | P4 | P1 | ✅ |
| [#42](https://github.com/KikiFUNstyle/TLPE/issues/42) | US9.2 Connexion FranceConnect+ | §11.1, §13.1 | P6 | P2 | 🚫 |
| [#43](https://github.com/KikiFUNstyle/TLPE/issues/43) | US9.3 Conformité RGAA 4.1 + DSFR | §11.3, §12.1 | P7 | P2 | 🚫 |

## EPIC 10 — Sécurité, qualité, exploitation (§12, §14)

| # | Titre | Spec | Phase | Prio | MVP |
|---|---|---|---|---|---|
| [#44](https://github.com/KikiFUNstyle/TLPE/issues/44) | US10.1 Interface visualisation audit log | §12.2, §14.1 | P6 | P1 | ✅ |
| [#45](https://github.com/KikiFUNstyle/TLPE/issues/45) | US10.2 Chiffrement AES-256 au repos | §12.2 | P7 | P1 | ✅ |
| [#46](https://github.com/KikiFUNstyle/TLPE/issues/46) | US10.3 Sauvegardes quotidiennes + test restauration | §12.2 | P7 | P1 | ✅ |
| [#47](https://github.com/KikiFUNstyle/TLPE/issues/47) | US10.4 Scan OWASP ZAP en CI/CD | §12.2 | P7 | P1 | ✅ |
| [#48](https://github.com/KikiFUNstyle/TLPE/issues/48) | US10.5 Couverture tests ≥ 80 % | §14.2 | P7 | P1 | ✅ |
| [#49](https://github.com/KikiFUNstyle/TLPE/issues/49) | US10.6 Documentation utilisateur en ligne + PDF | §14.3 | P7 | P1 | ✅ |

## EPIC 11 — Notifications transverses

| # | Titre | Spec | Phase | Prio | MVP |
|---|---|---|---|---|---|
| [#50](https://github.com/KikiFUNstyle/TLPE/issues/50) | US11.1 Service SMTP d'envoi d'emails transactionnels | transverse | P2 | P0 | ✅ |
| [#51](https://github.com/KikiFUNstyle/TLPE/issues/51) | US11.2 Templates d'emails paramétrables | transverse | P2 | P0 | ✅ |
| [#52](https://github.com/KikiFUNstyle/TLPE/issues/52) | US11.3 Historique / journal des notifications | §12.2 | P2 | P1 | ✅ |

## Cartographie spec → US

| § Spec | Chapitre | US couvrantes |
|---|---|---|
| §3 | Référentiels | #1, #2, #3 |
| §4 | Assujettis & Dispositifs | #4, #5, #6, #7, #8, #9 |
| §5 | Déclarations | #10, #11, #12, #13, #14, #15, #16 |
| §6 | Moteur de calcul | #17 (compléments — le reste est déjà implémenté) |
| §7 | Titres & Paiements | #18 à #26 |
| §8 | Contentieux | #27, #28, #29 |
| §9 | Contrôle terrain | #30, #31, #32 |
| §10 | Reporting | #33 à #40 |
| §11 | Portail contribuable | #41, #42, #43 |
| §12 | Architecture technique | #44, #45, #46, #47 (complète les fondations déjà en place) |
| §13 | Intégrations | #6, #7, #19, #20, #42 |
| §14 | Qualité / exploitation | #46, #47, #48, #49 |
| §15 | Phases & planning | traduit via labels `phase:P1` à `phase:P7` |

## État de l'implémentation actuelle

Pour référence, le code déjà livré (cf. `server/src/`, `client/src/`) couvre :
- Les 5 rôles RBAC (admin, gestionnaire, financier, controleur, contribuable) avec JWT 12 h
- CRUD complet : assujettis, dispositifs, déclarations, titres, paiements, contentieux, référentiels
- Flux déclaratif brouillon → soumise → validée (avec hash SHA-256) → rejetée
- Moteur de calcul (barèmes m²/fixe/exonéré, prorata, coefficient zone, arrondi euro, double face)
- Génération PDF basique des titres via PDFKit
- Dashboard KPI (montants N/N-1, recouvrement, contentieux, distribution catégories)
- Simulateur public stateless
- Audit log (API) — visualisation UI à livrer via #44
- Tests unitaires moteur de calcul (10 cas — `calculator.test.ts`)

Ce socle fonctionnel constitue l'amorce de la Phase P1-P2 des specs ; les 52 US listées ci-dessus déclinent le reste du périmètre jusqu'à la mise en production (Phase P7).
