/**
 * Calculs commerciaux (fonctions pures, sans effet de bord, testées).
 *
 * Définitions (voir docs/ARCHITECTURE.md, section « Calculs ») :
 *  - Chiffre d'affaires (CA) = Σ (quantité × prix de vente enregistré) des commandes CONFIRMÉES.
 *  - Coût des marchandises vendues (CMV) = Σ (quantité × coût unitaire enregistré).
 *  - Marge brute estimée = CA − CMV. Ce n'est PAS le bénéfice net.
 *  - Stock restant = stock initial + entrées − ventes ± corrections + annulations.
 *  - Valeur du stock = Σ (quantité disponible × prix d'achat unitaire de référence).
 */
import { addAmounts, assertAmount, multiplyAmount } from './money';

export interface PricedLine {
  quantity: number;
  unit_price: number;
  unit_cost: number;
}

export interface LineTotals {
  line_total: number;
  line_cost: number;
  line_margin: number;
}

export interface OrderTotals {
  total_quantity: number;
  total_amount: number;
  total_cost: number;
  gross_margin: number;
  line_count: number;
}

/** Totaux d'une ligne. Lève une erreur si une valeur est invalide. */
export function lineTotals(line: PricedLine): LineTotals {
  if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
    throw new RangeError('La quantité doit être un entier strictement positif.');
  }
  assertAmount(line.unit_price, 'Prix de vente');
  assertAmount(line.unit_cost, 'Coût unitaire');
  const line_total = multiplyAmount(line.unit_price, line.quantity);
  const line_cost = multiplyAmount(line.unit_cost, line.quantity);
  return { line_total, line_cost, line_margin: line_total - line_cost };
}

/** Totaux d'une commande à partir de ses lignes. */
export function orderTotals(lines: PricedLine[]): OrderTotals {
  const computed = lines.map(lineTotals);
  return {
    total_quantity: lines.reduce((sum, l) => sum + l.quantity, 0),
    total_amount: addAmounts(0, ...computed.map((c) => c.line_total)),
    total_cost: addAmounts(0, ...computed.map((c) => c.line_cost)),
    gross_margin: computed.reduce((sum, c) => sum + c.line_margin, 0),
    line_count: lines.length,
  };
}

/** Marge brute en pourcentage du CA (entier arrondi), 0 si pas de CA. */
export function marginRate(revenue: number, margin: number): number {
  if (revenue <= 0) return 0;
  return Math.round((margin * 100) / revenue);
}

export interface StockLike {
  quantity: number;
  purchase_price: number;
  alert_threshold: number;
  status: 'active' | 'archived';
}

/** Valeur du stock au coût d'achat : Σ quantité × prix d'achat. */
export function stockValue(products: StockLike[]): number {
  return addAmounts(0, ...products.map((p) => multiplyAmount(p.purchase_price, p.quantity)));
}

/** Un article est en stock faible si sa quantité atteint le seuil d'alerte (et qu'il est actif). */
export function isLowStock(p: StockLike): boolean {
  return p.status === 'active' && p.quantity <= p.alert_threshold;
}

/** Stock restant selon la formule documentée (utilisé pour vérifier les mouvements). */
export function remainingStock(params: {
  initial: number;
  entries: number;
  sales: number;
  corrections: number;
  cancelRestocks: number;
}): number {
  return params.initial + params.entries - params.sales + params.corrections + params.cancelRestocks;
}
