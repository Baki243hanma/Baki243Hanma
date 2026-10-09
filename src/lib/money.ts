/**
 * Montants en franc congolais (FC).
 *
 * Règle : tous les montants sont des ENTIERS en FC. Le FC n'utilise pas de centimes
 * dans la pratique commerciale ; on évite ainsi toute erreur d'arrondi liée aux
 * nombres flottants. Toute valeur non entière ou négative est refusée.
 */

export const CURRENCY_LABEL = 'FC';

/** Plus grand montant représentable exactement en JavaScript (2^53 - 1). */
export const MAX_SAFE_AMOUNT = Number.MAX_SAFE_INTEGER;

export function isValidAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Vérifie qu'un montant est un entier sûr, positif ou nul. Lève une erreur sinon. */
export function assertAmount(value: number, label = 'Montant'): number {
  if (!isValidAmount(value)) {
    throw new RangeError(`${label} invalide : un montant doit être un nombre entier positif.`);
  }
  return value;
}

/** Multiplication exacte prix × quantité, avec contrôle de dépassement. */
export function multiplyAmount(unit: number, quantity: number): number {
  const result = unit * quantity;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError('Montant trop grand pour être calculé de façon exacte.');
  }
  return result;
}

export function addAmounts(...values: number[]): number {
  let total = 0;
  for (const v of values) {
    total += v;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError('Montant total trop grand pour être calculé de façon exacte.');
    }
  }
  return total;
}

/**
 * Formate un montant : 12000 -> "12 000 FC".
 * Le séparateur de milliers est une espace insécable (lisible, non coupée à la fin de ligne).
 */
export function formatFC(value: number): string {
  const safe = Number.isSafeInteger(value) ? value : 0;
  const negative = safe < 0;
  const digits = String(Math.abs(safe));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
  return `${negative ? '-' : ''}${grouped}\u00A0${CURRENCY_LABEL}`;
}

/** Formate un nombre entier simple (quantités) : 1200 -> "1 200". */
export function formatInt(value: number): string {
  const safe = Number.isSafeInteger(value) ? value : 0;
  const negative = safe < 0;
  const grouped = String(Math.abs(safe)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
  return `${negative ? '-' : ''}${grouped}`;
}

/**
 * Analyse une saisie utilisateur de montant.
 * Accepte "12 000", "12000", "12.000", "12,000" (séparateurs de milliers ignorés).
 * Retourne null si la saisie n'est pas un montant entier valide.
 */
export function parseAmount(input: string): number | null {
  const cleaned = input.replace(/[\s\u00A0\u202F]/g, '').replace(/[.,](?=\d{3}(\D|$))/g, '');
  if (cleaned === '') return null;
  if (!/^\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isSafeInteger(n) ? n : null;
}

/** Analyse une quantité saisie : entier strictement positif, sinon null. */
export function parseQuantity(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Pourcentage arrondi à l'entier le plus proche, calculé sans flottant (numérateur × 100 / dénominateur). */
export function percentOf(part: number, whole: number): number {
  if (whole === 0) return 0;
  const sign = part < 0 ? -1 : 1;
  const absPart = Math.abs(part);
  // arrondi "demi vers le haut" en arithmétique entière
  return sign * Math.floor((absPart * 100 * 2 + whole) / (whole * 2));
}
