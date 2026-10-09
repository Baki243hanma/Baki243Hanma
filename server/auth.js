/**
 * Vérification des jetons Neon Auth (JWT signés en EdDSA) à l'aide du JWKS publié par Neon.
 *
 *  - Clés publiques : <NEON_AUTH_URL>/.well-known/jwks.json (récupérées et mises en cache par jose).
 *  - Émetteur attendu : l'origine de NEON_AUTH_URL (ex. https://ep-xxx.neonauth.region.aws.neon.tech).
 *  - Identifiant du compte : claim « sub ».
 *
 * Aucun secret n'est nécessaire pour vérifier un jeton : seules les clés publiques sont utilisées.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';

export class AuthConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

/** Renvoie l'origine (scheme + hôte + port) d'une URL http(s), ou lève AuthConfigError. */
export function authOrigin(authUrl) {
  let url;
  try {
    url = new URL(authUrl);
  } catch {
    throw new AuthConfigError('NEON_AUTH_URL n’est pas une URL valide.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AuthConfigError('NEON_AUTH_URL doit commencer par https://.');
  }
  return url.origin;
}

/** URL du JWKS : concatène le chemin de NEON_AUTH_URL (ne pas utiliser new URL(chemin, base), qui l'effacerait). */
export function jwksUrl(authUrl) {
  return `${authUrl.trim().replace(/\/+$/, '')}/.well-known/jwks.json`;
}

/**
 * Construit une fonction verifyToken(token) -> identifiant du compte (string).
 * Lève une erreur si le jeton est invalide, expiré, d'un autre émetteur, ou sans « sub ».
 *
 * @param {{ authUrl: string, keySet?: Function }} options
 *   keySet : fonction de recherche de clés (createLocalJWKSet en tests) à la place du JWKS distant.
 */
export function createTokenVerifier({ authUrl, keySet }) {
  const issuer = authOrigin(authUrl);
  const keys = keySet ?? createRemoteJWKSet(new URL(jwksUrl(authUrl)), { cooldownDuration: 30_000 });

  return async function verifyToken(token) {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      algorithms: ['EdDSA'],
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new Error('jeton sans identifiant de compte');
    }
    return payload.sub;
  };
}
