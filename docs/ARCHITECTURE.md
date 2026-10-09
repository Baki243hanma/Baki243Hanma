# Architecture ShopFlow RDC

## Vue d’ensemble

```
Téléphone (PWA)                       Render : Express (server/)                    Neon
┌──────────────────────────┐  POST /api/*  ┌────────────────────────────┐   pg   ┌──────────────────────────┐
│ React + Vite + Tailwind  │  Bearer JWT   │ requireUser (JWKS, jose)   │ ─────▶ │ schéma public            │
│ IndexedDB (Dexie)        │ ────────────▶ │ withUser : transaction     │        │ current_user_id()        │
│  products, orders, stock │               │   set_config app.user_id   │        │ is_shop_member()         │
│  sync_operations (file)  │ ◀──────────── │ fonctions SQL              │        │ apply_sync_operation()   │
│ service worker (interface)│  JSON         │ sert dist/ (PWA)           │        │ schema_migrations        │
└────────────┬─────────────┘               └────────────────────────────┘        └──────────────────────────┘
             │ session, jeton (client Neon Auth)
             ▼
      Neon Auth (NEON_AUTH_URL) : comptes, cookies de session, JWKS /.well-known/jwks.json
```

- **Les données métier vivent d’abord sur l’appareil** (IndexedDB via Dexie). L’interface lit toujours la base locale : elle fonctionne hors ligne.
- **Le navigateur ne connaît que l’URL publique de Neon Auth** (`GET /api/config` renvoie `{ "authUrl": … }`, et rien d’autre).
- **Le serveur est le seul à parler à la base** (`DATABASE_URL`, jamais exposée au navigateur, jamais dans le dépôt).
- **Le service worker** ne met en cache que l’interface (HTML, JS, CSS, icônes). Il ne met jamais en cache les données, ni `/api/`, ni Neon Auth.

## Authentification

1. L’utilisateur s’inscrit ou se connecte via le client Neon Auth (`src/auth/client.ts`, paquet `@neondatabase/neon-js/auth`, adaptateur Better Auth avec `credentials: 'include'`).
2. Neon Auth pose un cookie de session. Le client demande un JWT (`authClient.token()`) à chaque appel API.
3. Le serveur vérifie le JWT (`server/auth.js`) :
   - signature **EdDSA** avec les clés publiques du JWKS (`<NEON_AUTH_URL>/.well-known/jwks.json`, mises en cache par `jose`) ;
   - émetteur = origine de `NEON_AUTH_URL` ;
   - expiration ;
   - présence du claim `sub` (identifiant du compte, utilisé comme `user_id`).
4. Sans jeton valide : `401 {"error":"unauthorized"}`. Aucune donnée n’est lue.
5. Hors ligne, l’identité déjà connue (mémorisée dans `localStorage`) permet de rester sur sa base locale. Les opérations restent en file jusqu’au retour du réseau.

## Routes de l’API

| Méthode | Route | Corps | Réponse |
|---|---|---|---|
| GET | `/healthz` | – | `{status, built, database, auth}` |
| GET | `/api/config` | – | `{authUrl}` (aucun secret) |
| POST | `/api/shop/ensure` | `{name}` (chaîne ou vide) | `{id, name, created}` ; `422` code `22023` si le nom manque à la première création |
| POST | `/api/sync/apply` | `{op_id (UUID), type, payload}` | résultat de `apply_sync_operation` (HTTP 200 pour `applied`, `already_applied`, `failed`, `conflict`) |
| POST | `/api/sync/pull` | `{shop_id}` | `{shop, products, orders, movements}` ; `403 forbidden_shop` si la boutique n’est pas au compte |

Codes d’erreur communs :

- `400 invalid_request` : corps mal formé ou champs invalides.
- `401 unauthorized` : jeton absent ou refusé.
- `403 forbidden_shop` : boutique d’un autre compte (lecture).
- `422 sql_error` + `code` (SQLSTATE) : erreur de la base, par exemple `42501` (boutique étrangère) ou `22023`.
- `503 database_not_configured` / `auth_not_configured` / `database_unavailable` : configuration absente, ou base indisponible (à réessayer).
- `500 internal_error` : erreur inattendue, sans détail interne renvoyé.

## Contrat côté client (`src/sync/remote.ts`)

| Réponse | Classement | Effet sur la file |
|---|---|---|
| Réseau coupé, délai, jeton impossible à obtenir | `TransportError` | opération reste `pending`, le cycle s’arrête |
| `401` (session expirée), `503`, autres `5xx`, corps illisible | `TransportError` | idem |
| `400`, `403`, `422` | `ServerError(code)` | opération marquée `failed` (`server_error`), rien n’est écrit |
| `200` | résultat | traitement normal (applied, duplicate, conflict, failed métier) |

Règles de synchronisation confirmées (testées dans `tests/integration/sync.test.ts`) :

- Un échec de transport n’est jamais traité comme un échec serveur.
- Le pull n’a lieu qu’après un envoi complet, sans coupure.
- `mergeSnapshot` n’écrase pas une entité qui a encore une opération active.
- Un rejeu (même `op_id`) renvoie le résultat enregistré avec `duplicate: true` : pas de doublon.

## Base de données

### Migrations

`db/migrations/*.sql`, appliquées dans l’ordre des noms, chacune dans sa propre transaction, sous verrou consultatif (`pg_advisory_xact_lock`). La table `public.schema_migrations` enregistre les fichiers appliqués. Le démarrage du serveur les applique si `MIGRATE_ON_START=true` ; `npm run db:migrate` permet de le faire à la main.

1. `001_init_schema.sql` : tables `shops`, `shop_profiles` (lien compte → boutique, `user_id text`), `products`, `orders`, `order_items`, `stock_movements`, `remote_operations` ; fonction `current_user_id()`.
2. `002_rls_security.sql` : RLS activée sur toutes les tables ; politiques de lecture limitées à la boutique du compte (`is_shop_member`). Pas de politique d’écriture : les écritures passent par les fonctions.
3. `003_sync_functions.sql` : `ensure_shop`, `apply_sync_operation` et ses opérations (`op_create_order`, `op_cancel_order`, `op_upsert_product`, `op_stock_movement`, `op_update_shop`).

### Identité dans la base

`public.current_user_id()` renvoie `current_setting('app.user_id', true)`. Le serveur appelle `set_config('app.user_id', <sub vérifié>, true)` au début de chaque transaction (`server/db.js`, `withUser`). Le paramètre est **local à la transaction** : il ne fuit pas vers une autre requête qui partage le pool. Un test le vérifie sur PostgreSQL réel.

Les tables ne référencent pas `auth.users` : les identifiants Neon Auth sont des textes (`sub`).

### Sécurité de la base

- Le serveur se connecte avec le **rôle propriétaire** de la base. Ce rôle contourne la RLS : la protection réelle est donc dans les fonctions SQL, qui vérifient `is_shop_member(shop_id)` à partir de l’identifiant vérifié.
- La RLS reste en place pour les lectures faites par un rôle non propriétaire (vérifié dans les tests avec un rôle `app_reader`).
- Les fonctions `security definer` ne sont pas exécutables par `PUBLIC`.

## Montants et calculs

- Tous les montants sont des **entiers en FC** (`bigint` en SQL, entiers en TypeScript). Aucun flottant pour l’argent.
- Le serveur **recalcule** les totaux à partir des lignes (prix unitaire, coût unitaire, quantité). Le total envoyé par l’appareil est ignoré (testé).

## Stock et commandes

- Une vente crée une commande, ses lignes (nom, prix et coût **copiés** au moment de la vente) et des mouvements de stock (`sale`).
- Modifier un article ne modifie jamais les lignes des commandes existantes (testé en local et côté serveur).
- Une annulation conserve la commande, restaure le stock (`cancel_restock`) et exige un motif.
- Le stock ne devient jamais négatif : une vente au-delà du stock est refusée sans rien écrire.

## Limites techniques

- Le paquet client Neon (`@neondatabase/neon-js` `0.7.0-beta`) est en bêta.
- Les cookies de session sont cross-domaine : leur acceptation par Safari (iPhone) n’est pas vérifiée.
- Pas de limitation de débit côté API.
- Les tests d’intégration de bout en bout avec un **projet Neon Auth réel** et un **Render réel** ne sont pas encore faits.
