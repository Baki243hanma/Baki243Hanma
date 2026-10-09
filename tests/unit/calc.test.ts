import { describe, expect, it } from 'vitest';
import { isLowStock, lineTotals, marginRate, orderTotals, remainingStock, stockValue } from '../../src/lib/calc';

describe('calculs commerciaux', () => {
  it('calcule le total d’une ligne (quantité × prix) et son coût', () => {
    expect(lineTotals({ quantity: 3, unit_price: 5000, unit_cost: 2000 })).toEqual({
      line_total: 15000,
      line_cost: 6000,
      line_margin: 9000,
    });
  });

  it('refuse une quantité nulle ou négative dans le calcul', () => {
    expect(() => lineTotals({ quantity: 0, unit_price: 5000, unit_cost: 2000 })).toThrow(RangeError);
    expect(() => lineTotals({ quantity: -2, unit_price: 5000, unit_cost: 2000 })).toThrow(RangeError);
  });

  it('calcule le total d’une commande à plusieurs articles', () => {
    const totals = orderTotals([
      { quantity: 2, unit_price: 5000, unit_cost: 2500 },
      { quantity: 1, unit_price: 3000, unit_cost: 1000 },
      { quantity: 1, unit_price: 8000, unit_cost: 4000 },
    ]);
    expect(totals).toEqual({
      total_quantity: 4,
      total_amount: 21000,
      total_cost: 10000,
      gross_margin: 11000,
      line_count: 3,
    });
  });

  it('calcule le pourcentage de marge brute', () => {
    expect(marginRate(21000, 11000)).toBe(52);
    expect(marginRate(0, 0)).toBe(0);
  });

  it('valorise le stock au coût d’achat', () => {
    expect(
      stockValue([
        { quantity: 10, purchase_price: 2500, alert_threshold: 3, status: 'active' },
        { quantity: 5, purchase_price: 1000, alert_threshold: 1, status: 'active' },
      ]),
    ).toBe(30000);
  });

  it('signale un stock faible seulement pour un article actif au seuil atteint', () => {
    expect(isLowStock({ quantity: 3, alert_threshold: 3, purchase_price: 0, status: 'active' })).toBe(true);
    expect(isLowStock({ quantity: 4, alert_threshold: 3, purchase_price: 0, status: 'active' })).toBe(false);
    expect(isLowStock({ quantity: 0, alert_threshold: 3, purchase_price: 0, status: 'archived' })).toBe(false);
  });

  it('applique la formule du stock restant', () => {
    expect(remainingStock({ initial: 10, entries: 5, sales: 4, corrections: -1, cancelRestocks: 2 })).toBe(12);
  });
});
