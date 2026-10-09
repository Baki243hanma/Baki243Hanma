/**
 * Génère un UUID v4. Utilise crypto.randomUUID quand disponible (contexte sécurisé),
 * sinon getRandomValues (ex. : accès HTTP sur réseau local).
 */
export function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Référence lisible d'une commande : 8 premiers caractères de l'identifiant, en majuscules. */
export function orderRef(orderId: string): string {
  return orderId.replace(/-/g, '').slice(0, 8).toUpperCase();
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
