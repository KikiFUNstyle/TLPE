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
| Référentiels (barème, zones, types) | §3 | OK |
| Assujettis (CRUD, contrôle SIRET Luhn) | §4.1 | OK |
| Import en masse assujettis (CSV/XLSX + pré-contrôle) | §4.3 | OK |
| Dispositifs (CRUD, géolocalisation) | §4.2 | OK |
| Moteur de calcul TLPE (tranches, prorata, coef. zone, double face, forfait, exonération) | §6 | OK + tests |
| Déclarations (brouillon → soumission → validation → rejet) | §5 | OK |
| Hash SHA-256 de soumission (accusé) | §5.2 | OK |
| Titres de recettes + PDF (ordonnancement) | §7.1 | OK |
| Paiements (5 modalités) + recouvrement | §7.2 | OK |
| Contentieux / réclamations | §8 | OK |
| Tableau de bord exécutif | §10.1 | OK |
| Authentification + RBAC (5 rôles) | §2 | OK |
| Simulateur | §6.3 | OK |
| Audit log (traçabilité) | §12.2 | OK |
| Portail contribuable (accès restreint à sa fiche) | §11 | OK |

### Hors périmètre du MVP (prévu phases ultérieures)

- Application mobile de contrôle terrain (§9.2)
- Intégrations externes réelles : FranceConnect+, PayFip, BAN, PESV2 (§13.1)
- Import SIG / Shapefile (§4.3)
- Signature électronique (§13.2)
- Conformité RGAA 4.1 complète (§11.3)
- Rapports PDF avancés autres que le titre de recettes (§10.2)

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
            ├── Declarations.tsx
            ├── DeclarationDetail.tsx
            ├── Simulateur.tsx
            ├── Titres.tsx
            ├── Referentiels.tsx
            └── Contentieux.tsx
```
