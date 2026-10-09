# Architecture ShopFlow RDC

## Vue d’ensemble

```
Téléphone (PWA)                                   Render (Node/Express)            Supabase
┌──────────────────────────────┐   GET /api/config  ┌──────────────────────┐        ┌──────────────────────┐
│ React + Vite + Tailwind      │ ─────────────────▶ │ server/index.js      │        │ Auth (email/mot de   │
│ IndexedDB (Dexie)            │                    │ - sert dist/         │        │ passe)               │
│   products, orders, stock…   │                    │ - /healthz           │        │ Postgres + RLS       │
│   sync_operations (file)     │ ◀── RPC apply_sync_operation (anon key + JWT utilisateur) ──▶│ fonctions SQL       │
│ Service worker (interface)   │                    └──────────────────────┘        │ security definer     │
└──────────────────────────────┘                                                     └──────────────────────┘
```

- **Les données métier vivent d’abord sur l’appareil** (IndexedDB via Dexie). L’interface lit toujours la base locale : elle fonctionne hors ligne.
- **Le service worker** ne met en cache que l’interface (HTML, JS, CSS, icônes). Il ne met jamais en cache les données métier ni les appels `/api/`.
- **Le serveur Express** sert l’application compilée et expose la configuration publique Supabase (URL + clé anonyme). Il refuse toute clé `service_role` (JWT dont le rôle est `service_role`, ou clé `sb_secret_…`).
- **Aucune clé `service_role` n’est utilisée côté front.** La sécurité repose sur la RLS et sur les fonctions SQL `security definer` qui vérifient l’appartenance à la boutique (`is_shop_member`).

## Montants

- Tous les montants sont des **entiers en FC** (`bigint` en SQL, `number` entier en TypeScript). Aucun flottant pour l’argent.
- Les calculs (`orderTotals`, `multiplyAmount`) sont couverts par des tests unitaires.
- Le serveur **recalcule** les totaux à partir des lignes (prix unitaire, coût unitaire, quantité) ; le total envoyé par l’appareil est ignoré (testé).

## Stock et commandes

- Une vente crée une commande, ses lignes (prix et coût **copiés** au moment de la vente) et des mouvements de stock (`sale`).
- Modifier un article ne modifie jamais les lignes des commandes existantes (testé en local et côté serveur).
- Une annulation **ne supprime rien** : la commande passe au statut « Annulée », un mouvement `cancel_restock` restaure le stock, et le motif est conservé.
- Aucune suppression définitive d’un article utilisé : on archive.
- Invariant vérifié par les tests : le stock d’un article = somme de ses mouvements (`stockDrift` renvoie une liste vide).

## File d’opérations et synchronisation

Chaque écriture locale ajoute une opération (`sync_operations`) dans la même transaction que la modification locale.

| Étape | Règle |
|---|---|
| Envoi | FIFO par `seq`. Chaque opération a un `op_id` (UUID) : le serveur est **idempotent** (table `remote_operations`). |
| Confirmation | Une opération n’est marquée `done` **qu’après** la réponse explicite du serveur. |
| Hors ligne / coupure | Erreur de transport : l’opération reste `pending`, le cycle s’arrête. Rien n’est supprimé. |
| Refus métier | Stock insuffisant, article introuvable, etc. : opération `failed`, rien n’est écrit côté serveur. L’utilisateur choisit (réessayer / abandonner). |
| Conflit de version | Opération `conflict` (`base_version` ≠ version serveur). Pas de résolution silencieuse : l’utilisateur choisit « garder ma version », « prendre la version du serveur » ou réessayer. |
| Téléchargement | Ne remplace jamais une donnée ayant une opération non terminée. Ne remplace pas une donnée locale par une version plus ancienne. |
| Réponse perdue | Le serveur a appliqué l’opération mais le client ne le sait pas : au nouvel essai, le serveur répond « déjà appliquée » (`duplicate`) — aucun doublon. |
| Message de succès | « Synchronisation réussie » n’est affiché qu’après envoi confirmé **et** téléchargement terminé. |

Déclencheurs (`src/sync/manager.ts`) : démarrage, retour au premier plan (`visibilitychange`), retour de la connexion (`online`), minuterie tant que l’application est visible, bouton manuel. **Aucune synchronisation en arrière-plan n’est garantie sur iOS** (voir README, section Limites).

## Schéma SQL (dossier `supabase/migrations/`)

1. `20261009000001_init_schema.sql` — tables `shops`, `shop_members`, `products`, `orders`, `order_items`, `stock_movements`, contraintes (montants ≥ 0, quantités > 0, statuts).
2. `20261009000002_rls_security.sql` — RLS activée sur toutes les tables ; politiques par appartenance à la boutique ; révocation des droits `anon`.
3. `20261009000003_sync_functions.sql` — fonctions `ensure_shop`, `apply_sync_operation` et `op_*` (création de commande, annulation, article, mouvement de stock, nom de boutique), table `remote_operations`.

Chaque fonction `op_*` valide tout **avant** d’écrire ; `apply_sync_operation` s’exécute dans une transaction, avec un verrou par boutique (`pg_advisory_xact_lock`).

## Tests

| Niveau | Fichiers | Ce qui est réellement exécuté |
|---|---|---|
| Unitaires | `tests/unit/` | Montants FC, calculs de commande, dates de période, classification des erreurs distantes |
| Local (IndexedDB simulé) | `tests/integration/local.test.ts` | Création, commandes, stock, annulation, prix historisés, persistance après fermeture, tableau de bord |
| Sync + PostgreSQL réel | `tests/integration/sync.test.ts` | Migrations réelles dans PGlite, RLS, idempotence, réponse perdue, coupure réseau, conflits, isolation |
| Serveur | `tests/server/server.test.ts` | `/healthz`, `/api/config`, refus des clés service_role, en-têtes |
| Build / PWA | `tests/build/pwa.test.ts` | Compilation, manifeste, icônes (dimensions), balises iOS, précache du service worker |
| Navigateur | `tests/e2e/parcours.spec.ts` | Chromium, viewport 390 px et 320 px, parcours complets, double validation, hors ligne |

PGlite est une base PostgreSQL réelle (WebAssembly) : elle applique les migrations telles quelles. **Ce n’est pas un Supabase hébergé** : les comportements propres à Supabase (email de confirmation, limites de débit, PostgREST) ne sont pas testés ici.
