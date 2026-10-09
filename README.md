# ShopFlow RDC

Application de gestion commerciale pour petits commerçants en RDC (accessoires, cosmétiques, Kinshasa) : articles et stock, nouvelle commande, historique, tableau de bord, fonctionnement **hors ligne** et synchronisation. Installable comme application sur téléphone (PWA). Interface en français, montants en FC entiers (ex. 12 000 FC).

> La marge brute affichée **ne tient pas compte de toutes les dépenses** (loyer, transport, salaires, etc.).

## Architecture

```
Téléphone (PWA)                         Render (Node / Express : « npm start »)          Neon
┌────────────────────────────┐          ┌──────────────────────────────────┐        ┌──────────────────────┐
│ React + Vite + Tailwind    │ /api/*   │ server/  (Express)               │  pg    │ PostgreSQL           │
│ IndexedDB (Dexie)          │ ───────▶ │ - vérifie le JWT Neon Auth (JWKS)│ ─────▶ │ schéma public        │
│ file d’opérations          │ Bearer   │ - DATABASE_URL (serveur seul)    │        │ fonctions SQL        │
│ service worker (interface) │          │ - sert la PWA (dist/)            │        │ migrations           │
└─────────────┬──────────────┘          └──────────────────────────────────┘        └──────────────────────┘
              │ connexion, session, jeton (Neon Auth géré, Better Auth)
              ▼
      Neon Auth (URL publique, NEON_AUTH_URL) — comptes email + mot de passe
```

- **Le navigateur n’accède jamais à la base.** Il n’a ni `DATABASE_URL` ni clé de service. Il a seulement l’URL publique de Neon Auth (`/api/config`).
- **Les données vivent d’abord sur l’appareil** (IndexedDB). L’interface lit toujours la base locale : elle fonctionne hors ligne.
- **Le serveur** vérifie chaque jeton Neon Auth (signature EdDSA via le JWKS publié par Neon, émetteur, expiration, identifiant `sub`), puis exécute les fonctions SQL dans une transaction où l’identifiant du compte est fixé.
- Détails : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Fonctionnalités

**Terminé et testé**
- Articles : création, modification, catégorie, prix d’achat et de vente, seuil d’alerte, recherche, archivage/réactivation (jamais de suppression définitive).
- Stock : entrée de stock, correction avec motif obligatoire, mouvements tracés, alerte de stock faible.
- Nouvelle commande : panier multi-articles, brouillon conservé, mode de paiement obligatoire, récapitulatif avant validation, validation protégée contre le double envoi, stock déduit automatiquement.
- Historique : commandes groupées par jour, recherche par identifiant, annulation avec motif (la commande reste visible, le stock est restauré, l’annulation est journalisée).
- Tableau de bord : chiffre d’affaires, commandes, articles vendus, marge brute estimée, valeur du stock au coût d’achat, stock faible, dernières commandes ; périodes aujourd’hui / hier / 7 jours / ce mois / personnalisée.
- Paramètres : nom de la boutique, synchronisation manuelle, file des opérations à traiter, déconnexion, aide, récupération de données.
- Hors ligne : données dans IndexedDB ; l’interface s’ouvre sans réseau.
- Synchronisation : file d’opérations idempotente (chaque opération a un identifiant unique, rejouée sans doublon), sync à l’ouverture, au retour au premier plan, au retour de la connexion, et sur bouton manuel.
- Serveur : API Express (`/healthz`, `/api/config`, `/api/shop/ensure`, `/api/sync/apply`, `/api/sync/pull`), migrations SQL, client HTTP côté application.

**Restant (non implémenté, volontairement ou à faire)**
- Vérification de bout en bout avec un **vrai projet Neon Auth** et un **vrai service Render** : non encore réalisée (voir « Limites »).
- Test sur un **iPhone réel** (cookies de session cross-domaine, Safari) : non encore réalisé.
- Option « proxy d’authentification » sur le même domaine que l’application, pour fiabiliser les cookies sur Safari : non implémentée.
- Remises, retours, paiement en ligne, reçus imprimés, rôles multiples par boutique, export comptable, notifications, multi-devises. **Aucune de ces fonctions n’est simulée.**

## Prérequis

- Node.js **20.19 ou plus** (fichier `.nvmrc` : 20.20.2).
- Un projet **Neon** (base PostgreSQL + Neon Auth) pour la synchronisation. Sans base, l’application fonctionne en **mode local** (données sur cet appareil uniquement).
- PostgreSQL local (facultatif) pour lancer les tests sur une vraie base (voir « Tests »).

## Installation et lancement en local

```bash
npm install            # installe les dépendances et compile la PWA (postinstall)
npm start              # lance le serveur sur http://localhost:3000
```

Sans variables d’environnement, `npm start` lance le **mode local** (pas de compte, pas de synchronisation).

Pour utiliser votre base Neon en local :

1. Copiez `.env.example` en `.env` et renseignez `DATABASE_URL` et `NEON_AUTH_URL` (ne committez jamais `.env`).
2. Lancez :

```bash
node --env-file=.env server/index.js
```

Les migrations sont appliquées au démarrage (`MIGRATE_ON_START=true`, valeur par défaut). Vous pouvez aussi les appliquer à la main :

```bash
DATABASE_URL="postgresql://…" npm run db:migrate
```

Développement avec rechargement automatique : lancez le serveur Express (port 3000, voir ci-dessus) puis, dans un autre terminal, `npm run dev` (Vite sur le port 5173, qui redirige `/api` vers le port 3000).

## Configuration Neon (étapes)

1. Créez un projet sur https://neon.com et une base (par défaut `neondb`).
2. **Récupérer `DATABASE_URL`** : *Connect* (ou *Connection details*) > copiez la chaîne de connexion PostgreSQL avec `sslmode=require`. Elle est **secrète** : ne la mettez ni dans le code, ni dans un fichier committé, ni dans une variable préfixée `VITE_`.
3. **Appliquer le schéma** : au premier démarrage du serveur (`MIGRATE_ON_START=true`), ou avec `npm run db:migrate`. Les fichiers sont dans `db/migrations/` (`001_init_schema.sql`, `002_rls_security.sql`, `003_sync_functions.sql`) et chacun n’est appliqué qu’une fois (table `schema_migrations`).
4. **Activer Neon Auth** pour ce projet (section *Auth* de la console Neon), puis copiez l’**URL de base de Neon Auth** : c’est la valeur de `NEON_AUTH_URL` (forme attendue : `https://…/neondb/auth`, à vérifier dans votre console). Elle est publique.
5. **Domaines de confiance** : dans les réglages de Neon Auth, ajoutez l’origine de votre service Render (ex. `https://VOTRE-SERVICE.onrender.com`) et, pour les essais locaux, `http://localhost:3000`. Le libellé exact dans la console peut varier : vérifiez dans l’interface Neon.
6. **Inscription par email** : Neon Auth gère l’inscription et la connexion par email et mot de passe ; l’application exige 8 caractères minimum. Si une confirmation par email est exigée par la configuration du projet, l’application l’indique à l’inscription.

Vérification : après migration, la table `public.schema_migrations` doit lister les trois fichiers, et `public.products` doit exister avec la RLS activée.

> Ne créez pas de rôle ni de clé « service » pour l’application : seul le serveur se connecte à la base, avec `DATABASE_URL`.

## Déploiement sur Render

Le fichier `render.yaml` décrit le service (plan gratuit, région Frankfurt, health check `/healthz`).

1. Poussez le code sur GitHub (voir « Publier sur GitHub »).
2. Render : **New > Web Service** (ou **New > Blueprint** avec `render.yaml`) et choisissez le dépôt, branche `main`.
3. Commandes : **Build** `npm install`, **Start** `npm start`.
4. Variables d’environnement (onglet *Environment*) :
   - `DATABASE_URL` : chaîne de connexion Neon (secrète).
   - `NEON_AUTH_URL` : URL de base de Neon Auth.
   - `MIGRATE_ON_START` : `true`.
   - `NODE_VERSION` : `20.20.2`.
   - `PORT` est fourni par Render automatiquement.
5. Ajoutez l’URL du service Render aux domaines de confiance de Neon Auth (étape 5 ci-dessus).
6. Vérifiez `https://VOTRE-SERVICE.onrender.com/healthz` : la réponse attendue est `{"status":"ok","built":true,"database":"configured","auth":"configured"}`. Et `https://VOTRE-SERVICE.onrender.com/api/config` ne doit contenir que `authUrl`.

Remarque : le plan gratuit de Render se met en veille après une période d’inactivité ; la première ouverture peut être lente. Les données restent sur l’appareil grâce au mode hors ligne.

> **Statut** : ce déploiement n’a pas encore été effectué ni vérifié sur Render. Les commandes et variables ci-dessus correspondent au code, mais restent à valider.

## Installer l’application sur téléphone

- **Android (Chrome)** : menu ⋮ > *Installer l’application*.
- **iPhone (Safari)** : bouton Partager > *Sur l’écran d’accueil*. L’application doit être ouverte depuis Safari pour cette étape.

## Tests

```bash
npm run typecheck      # vérification TypeScript
npm test               # Vitest : unitaires, intégration (PGlite), serveur HTTP, build/PWA
npm run test:e2e       # Playwright (Chromium, viewport 390 px)
npm run test:all       # typecheck + Vitest + Playwright
```

Tests sur un **vrai PostgreSQL** (pilote `pg`, rôle propriétaire non superutilisateur comme sur Neon) : définissez `TEST_DATABASE_URL` vers une base **dédiée aux tests** (son nom doit contenir « test », le schéma `public` y est recréé) :

```bash
TEST_DATABASE_URL="postgresql://…/shopflow_test_db" npx vitest run tests/integration/postgres.test.ts
```

La première exécution de `npm run test:e2e` nécessite `npx playwright install chromium` (et sous Linux, `npx playwright install-deps chromium`).

### Résultats réels (dernière exécution)

| Commande | Résultat |
|---|---|
| `npx tsc --noEmit` | OK (code 0) |
| `npx vitest run` avec `TEST_DATABASE_URL` (PostgreSQL 17 réel) | **10 fichiers, 109 tests, 109 réussis** |
| `npx vitest run` sans `TEST_DATABASE_URL` | 103 réussis, 6 ignorés (le fichier PostgreSQL réel est ignoré) |
| `npx playwright test` (deux passages successifs) | **7 tests, 7 réussis** à chaque passage (Chromium, 390 px) |
| `npx vite build` | OK ; bundle JS ≈ 813 Ko (≈ 231 Ko gzip), en hausse à cause du client Neon Auth |

Détail : `tests/unit` (money, calc, dates, remote HTTP), `tests/integration/local.test.ts` (19), `tests/integration/sync.test.ts` (16, serveur HTTP réel sur PGlite), `tests/integration/postgres.test.ts` (6, PostgreSQL réel), `tests/server` (server 7, api 23), `tests/build` (8), `tests/e2e` (7).

Ce que couvrent les tests serveur : jetons EdDSA **réellement signés** par une clé de test et vérifiés par `jose` avec un JWKS local ; refus d’un jeton absent, signé par une autre clé, expiré, d’un autre émetteur, sans `sub`, ou signé en HS256 ; isolation entre deux comptes ; rejeu idempotent ; migrations appliquées une seule fois ; migration en échec annulée entièrement.

Démarrage vérifié sur PostgreSQL 17 : `node server/index.js` avec `DATABASE_URL` → migrations appliquées, `/healthz` OK, `/api/config` ne renvoie que `authUrl`, requête sans jeton → 401.

### Cas critiques couverts

| Cas | Où |
|---|---|
| Modifier le prix n’altère pas une ancienne commande | `local.test.ts`, `sync.test.ts` (serveur HTTP) |
| Annulation restaure le stock, commande conservée | `local.test.ts`, `sync.test.ts`, e2e « annulation » |
| Hors ligne puis synchronisation, sans doublon | `sync.test.ts`, e2e « hors ligne » |
| Pas de doublon (rejeu, double validation, réponse perdue) | `sync.test.ts`, `local.test.ts`, e2e « double validation » |
| Échec réseau pendant l’envoi : opération conservée | `sync.test.ts` |
| Isolation entre deux comptes, accès sans session | `sync.test.ts`, `api.test.ts`, `postgres.test.ts` |
| RLS : lecture directe limitée à la boutique du compte | `sync.test.ts` (rôle de lecture soumis à la RLS) |
| Stock insuffisant, conflit de version, erreur serveur : rien résolu en silence | `sync.test.ts` |
| Mobile étroit (390 px et 320 px, pas de défilement horizontal) | e2e |
| États vides et recherche sans résultat | e2e, `local.test.ts` |

Limites des tests : les tests e2e ne couvrent que le **mode local** (pas de compte ni de synchronisation dans le navigateur). Le parcours d’inscription/connexion réel n’est **pas** testé de bout en bout contre Neon Auth. Aucun téléphone physique, aucun iOS, et aucun Render réel n’ont été testés.

## Limites connues

- **Sécurité des accès** :
  - La sécurité des données repose sur le serveur : il vérifie le jeton, puis les fonctions SQL contrôlent l’appartenance à la boutique à partir de l’identifiant vérifié.
  - Le serveur se connecte avec le rôle **propriétaire** de la base (qui contourne la RLS). La RLS protège les lectures faites avec un rôle non propriétaire, mais **l’API n’en dépend pas**. Une fuite de `DATABASE_URL` donnerait un accès complet à la base : protégez-la (Render, jamais dans le dépôt).
  - Pas de limitation de débit (rate limiting) côté API pour l’instant.
- **Neon Auth et paquet client en bêta** : `@neondatabase/neon-js` est en version `0.7.0-beta` (version figée dans `package.json`). Son comportement peut évoluer.
- **Dépendances transitives** : `@neondatabase/neon-js` tire des paquets dont `@supabase/auth-js` (présents dans `package-lock.json`). L’application ne les appelle pas ; ils n’ont aucun rapport avec la base Supabase abandonnée.
- **Synchronisation sur iPhone** : iOS ne lance pas de synchronisation fiable en arrière-plan pour une application web. La synchronisation se fait **à l’ouverture de l’application, au retour au premier plan, au retour de la connexion et sur bouton manuel**. Ne comptez pas sur une synchronisation instantanée lorsque l’application est fermée.
- **Cookies de session sur Safari** : Neon Auth est sur un domaine différent de l’application. La session repose sur des cookies cross-domaine, que Safari (ITP) peut bloquer. Si c’est le cas sur votre iPhone, la connexion ou la synchronisation ne fonctionneront pas sans une correction (proxy d’authentification sur le même domaine). **À tester sur un vrai iPhone.**
- **Hors ligne et identité** : après une première connexion, l’identité du compte est mémorisée sur l’appareil pour rester sur sa base locale sans réseau. Déconnexion = suppression de cette identité ; les données locales restent sur l’appareil.
- **Données par navigateur** : sur iPhone, les données sont stockées par Safari (ou par l’application installée) ; l’effacement des données du site les supprime localement. Les données synchronisées restent dans Neon.
- **Prix transmis par l’appareil** : le serveur enregistre le prix de vente et le coût saisis sur l’appareil au moment de la vente ; il ne vérifie pas le prix au catalogue du serveur.
- **Un compte = une boutique** : pas encore de gestion de plusieurs vendeurs avec droits distincts.
- **Marge brute** : calculée à partir des prix d’achat et de vente ; elle ne tient pas compte des autres dépenses.
- **Collecte minimale** : aucun champ client obligatoire ; aucune donnée personnelle de client n’est demandée.
- **Pas de paiement en ligne** et **pas d’API IA payante**.

## Publier sur GitHub

Le dépôt cible est https://github.com/Baki243hanma/Baki243Hanma (public, vide, branche `main`). Depuis le dossier du projet :

```bash
git init -b main
git add .
git commit -m "ShopFlow RDC : MVP initial"
git remote add origin https://github.com/Baki243hanma/Baki243Hanma.git
git push -u origin main
```

Git vous demandera vos identifiants (ou un *Personal Access Token*). Ne partagez jamais votre mot de passe ni votre token dans le code.

## Structure

```
server/          API Express : app.js (routes), db.js (pg, transactions, migrations),
                 auth.js (vérification JWT Neon via JWKS), index.js (démarrage)
db/migrations/   schéma, RLS, fonctions de synchronisation (SQL)
scripts/         migrate.mjs (migrations à la main)
src/             application React (pages, composants, base locale, synchronisation)
src/auth/        configuration runtime et client Neon Auth
src/sync/        moteur de sync, client HTTP (remote.ts)
public/          manifeste PWA, service worker, icônes
tests/           unitaires, intégration (PGlite et PostgreSQL), serveur, build, navigateur
docs/ARCHITECTURE.md   détail de la synchronisation, du schéma et de la sécurité
```
