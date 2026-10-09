# ShopFlow RDC

Application de gestion commerciale pour petits commerçants en RDC (accessoires, cosmétiques, Kinshasa) : articles et stock, nouvelle commande, historique, tableau de bord, fonctionnement **hors ligne** et synchronisation avec Supabase. Installable comme application sur téléphone (PWA). Interface en français, montants en FC entiers (ex. 12 000 FC).

> La marge brute affichée **ne tient pas compte de toutes les dépenses** (loyer, transport, salaires, etc.).

## Fonctionnalités

**Terminé et testé**
- Articles : création, modification, catégorie, prix d’achat et de vente, seuil d’alerte, recherche, archivage/réactivation (jamais de suppression définitive).
- Stock : entrée de stock, correction avec motif obligatoire, mouvements tracés, alerte de stock faible.
- Nouvelle commande : panier multi-articles, brouillon conservé, mode de paiement obligatoire, récapitulatif avant validation, validation protégée contre le double envoi, stock déduit automatiquement.
- Historique : commandes groupées par jour, recherche par identifiant, annulation avec motif (la commande reste visible, le stock est restauré).
- Tableau de bord : chiffre d’affaires, commandes, articles vendus, marge brute estimée, valeur du stock au coût d’achat, stock faible, dernières commandes ; périodes aujourd’hui / hier / 7 jours / ce mois / personnalisée.
- Paramètres : nom de la boutique, synchronisation manuelle, file des opérations à traiter (réessayer, garder ma version, prendre la version du serveur, abandonner), aide.
- Hors ligne : données dans IndexedDB ; l’interface s’ouvre sans réseau.
- Synchronisation : file d’opérations idempotente, sync à l’ouverture, au retour au premier plan, au retour de la connexion, périodiquement tant que l’application est visible, et sur bouton manuel.
- Authentification Supabase (email et mot de passe) et isolation des boutiques par RLS.

**Non implémenté (volontairement)** : remises, retours, paiement en ligne, reçus imprimés, rôles multiples par boutique, export comptable, notifications, multi-devises. Aucune de ces fonctions n’est simulée.

## Prérequis

- Node.js **20.19 ou plus** (fichier `.nvmrc` : 20.20.2).
- Un projet Supabase (gratuit) pour la synchronisation. Sans Supabase, l’application fonctionne en **mode local** (données sur cet appareil uniquement).

## Installation et lancement en local

```bash
npm install            # installe les dépendances et compile l’interface (postinstall)
npm start              # lance le serveur sur http://localhost:3000
```

Développement avec rechargement automatique (front sur le port 5173, proxy `/api` vers 3000) :

```bash
npm run dev            # Vite
```

Connexion à Supabase en local : copiez `.env.example` en `.env`, renseignez `SUPABASE_URL` et `SUPABASE_ANON_KEY` (clé **anonyme** uniquement), puis :

```bash
node --env-file=.env server/index.js
```

## Configuration Supabase (étapes)

1. Créez un projet sur https://supabase.com.
2. Ouvrez **SQL Editor** et exécutez, **dans l’ordre**, les trois fichiers de `supabase/migrations/` :
   - `20261009000001_init_schema.sql`
   - `20261009000002_rls_security.sql`
   - `20261009000003_sync_functions.sql`
3. **Authentication > URL Configuration** : indiquez l’URL de votre service Render comme *Site URL* (et dans *Redirect URLs*).
4. **Authentication > Providers > Email** : choisissez si la confirmation par email est exigée. Si elle l’est, l’application vous demandera de confirmer avant de vous connecter.
5. **Settings > API** : copiez l’URL du projet et la clé **anon / publishable**. **Ne copiez jamais la clé `service_role`** : le serveur la refuse et ne la transmet pas à l’interface.
6. Vérifiez la RLS : dans l’éditeur SQL, toutes les tables de `public` doivent afficher « RLS enabled ».

## Déploiement sur Render

Le fichier `render.yaml` décrit le service. Étapes :

1. Poussez le code sur GitHub (voir « Publier sur GitHub » ci-dessous).
2. Render : **New > Blueprint** (ou **New > Web Service**) et choisissez le dépôt.
3. Commandes : **Build** `npm install`, **Start** `npm start`, **Health check** `/healthz`.
4. Variables d’environnement : `SUPABASE_URL` et `SUPABASE_ANON_KEY` (clé anonyme). `NODE_VERSION` = 20.20.2.
5. Déployez, puis ouvrez l’URL Render. Vérifiez `https://VOTRE-SERVICE.onrender.com/healthz` : la réponse doit être `{"status":"ok",...}`.

Note : le plan gratuit de Render se met en veille après une période d’inactivité ; la première ouverture peut être lente. Les données restent sur l’appareil grâce au mode hors ligne.

## Installer l’application sur téléphone

- **Android (Chrome)** : menu ⋮ > *Installer l’application*.
- **iPhone (Safari)** : bouton Partager > *Sur l’écran d’accueil*. L’application doit être ouverte depuis Safari pour cette étape.

## Tests

```bash
npm run typecheck      # vérification TypeScript
npm test               # tests unitaires, intégration, serveur, build/PWA (Vitest)
npm run test:e2e       # tests navigateur (Playwright, Chromium, 390 px)
npm run test:all       # les trois ensembles
```

La première exécution de `npm run test:e2e` nécessite `npx playwright install chromium` (et sous Linux, `npx playwright install-deps chromium`).

### Résultats réels (dernière exécution)

| Commande | Résultat |
|---|---|
| `npm run typecheck` | OK (code 0) |
| `npm test` | **8 fichiers, 72 tests, 72 réussis** |
| `npm run test:e2e` | **7 tests, 7 réussis** (Chromium, viewport 390 px) |
| `npm run build` | OK ; bundle JS ≈ 712 Ko (≈ 210 Ko gzip) |

Détail par fichier : `tests/unit` (money 6, calc 7, dates 7, remote 3), `tests/integration/local.test.ts` (19), `tests/integration/sync.test.ts` (15, PostgreSQL réel via PGlite), `tests/server` (7), `tests/build` (8), `tests/e2e` (7).

### Cas critiques couverts

| Cas | Où |
|---|---|
| Modifier le prix n’altère pas une ancienne commande | `local.test.ts`, `sync.test.ts` (serveur) |
| Annulation restaure le stock, commande conservée | `local.test.ts`, `sync.test.ts`, e2e « annulation » |
| Hors ligne puis synchronisation | `sync.test.ts`, e2e « hors ligne » |
| Pas de doublon (rejeu, double validation, réponse perdue) | `sync.test.ts`, e2e « double validation » |
| Échec réseau pendant l’envoi | `sync.test.ts` |
| Isolation entre deux comptes et anonymes | `sync.test.ts` (RLS + fonctions) |
| Mobile étroit (390 px et 320 px, pas de défilement horizontal) | e2e |
| États vides et recherche sans résultat | e2e, `local.test.ts` |
| Stock insuffisant, conflit de version, erreur serveur : rien résolu en silence | `sync.test.ts` |

Limites des tests : ils ne couvrent **pas** un projet Supabase hébergé réel, ni un téléphone physique, ni iOS. Le parcours d’authentification par email n’est pas testé de bout en bout.

## Limites connues

- **Synchronisation sur iPhone** : iOS ne lance pas de synchronisation fiable en arrière-plan pour une application web. La synchronisation se fait **à l’ouverture de l’application, au retour au premier plan, au retour de la connexion et sur bouton manuel**. Ne comptez pas sur une synchronisation instantanée lorsque l’application est fermée.
- **Données par navigateur** : sur iPhone, les données sont stockées par Safari (ou par l’application installée) ; l’effacement des données du site les supprime localement. Les données synchronisées restent dans Supabase.
- **Prix transmis par l’appareil** : le serveur enregistre le prix de vente et le coût saisis sur l’appareil au moment de la vente ; il ne vérifie pas le prix au catalogue du serveur.
- **Un compte = une boutique** : pas encore de gestion de plusieurs vendeurs avec droits distincts.
- **Marge brute** : calculée à partir des prix d’achat et de vente ; elle ne tient pas compte des autres dépenses.
- **Collecte minimale** : aucun champ client obligatoire ; aucune donnée personnelle de client n’est demandée.
- **Pas de paiement en ligne** et **pas d’API IA payante**.

## Publier sur GitHub

Le dépôt cible est https://github.com/Baki243hanma/Baki243Hanma (public, vide). Depuis le dossier du projet :

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
server/          serveur Express (sert dist/, /api/config, /healthz)
src/             application React (pages, composants, base locale, synchronisation)
public/          manifeste PWA, service worker, icônes
supabase/        migrations SQL (schéma, RLS, fonctions de synchronisation)
tests/           tests unitaires, intégration, serveur, build, navigateur
docs/ARCHITECTURE.md   détail de la synchronisation et du schéma
```
