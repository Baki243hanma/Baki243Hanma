/**
 * Client Neon Auth côté navigateur (Managed Better Auth).
 *
 * - La session est gérée par cookie (HTTP-only) fourni par Neon Auth.
 * - authClient.token() renvoie un JWT signé ; l'API Express le vérifie avec le JWKS Neon.
 * - credentials: 'include' est nécessaire car Neon Auth est sur un autre domaine que l'application.
 *   Ce cookie tiers peut être bloqué par Safari (ITP) : voir README, section « Limites ».
 *
 * Le paquet vanilla est importé ici ; BetterAuthVanillaAdapter reçoit les options de requête
 * (credentials) car createAuthClient ne les transmet pas lui-même.
 */
import { createAuthClient } from '@neondatabase/neon-js/auth';
import { BetterAuthVanillaAdapter } from '@neondatabase/neon-js/auth/vanilla';

export type AuthClient = ReturnType<typeof createNeonAuthClient>;

export function createNeonAuthClient(authUrl: string) {
  return createAuthClient(authUrl, {
    adapter: BetterAuthVanillaAdapter({ fetchOptions: { credentials: 'include' } }),
  });
}
