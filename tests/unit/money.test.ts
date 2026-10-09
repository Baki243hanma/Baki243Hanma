import { describe, expect, it } from 'vitest';
import { addAmounts, assertAmount, formatFC, formatInt, multiplyAmount, parseAmount, parseQuantity, percentOf } from '../../src/lib/money';

describe('montants en FC', () => {
  it('formate les montants avec espaces insécables et suffixe FC', () => {
    expect(formatFC(12000)).toBe('12\u00A0000\u00A0FC');
    expect(formatFC(0)).toBe('0\u00A0FC');
    expect(formatFC(999)).toBe('999\u00A0FC');
    expect(formatFC(1234567)).toBe('1\u00A0234\u00A0567\u00A0FC');
    expect(formatFC(-2500)).toBe('-2\u00A0500\u00A0FC');
  });

  it('formate les quantités simples', () => {
    expect(formatInt(1200)).toBe('1\u00A0200');
    expect(formatInt(7)).toBe('7');
  });

  it('analyse les saisies de montants', () => {
    expect(parseAmount('12000')).toBe(12000);
    expect(parseAmount('12 000')).toBe(12000);
    expect(parseAmount('12.000')).toBe(12000);
    expect(parseAmount('12,000')).toBe(12000);
    expect(parseAmount('0')).toBe(0);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('12,5')).toBeNull();
    expect(parseAmount('-5')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
  });

  it('refuse les quantités nulles, négatives ou décimales', () => {
    expect(parseQuantity('3')).toBe(3);
    expect(parseQuantity(' 10 ')).toBe(10);
    expect(parseQuantity('0')).toBeNull();
    expect(parseQuantity('-1')).toBeNull();
    expect(parseQuantity('1.5')).toBeNull();
    expect(parseQuantity('')).toBeNull();
  });

  it('calcule exactement sans flottants (0,1 + 0,2 n’existe pas en entiers)', () => {
    expect(addAmounts(100, 200)).toBe(300);
    expect(multiplyAmount(2500, 3)).toBe(7500);
    expect(() => multiplyAmount(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError);
    expect(() => assertAmount(10.5)).toThrow(RangeError);
    expect(() => assertAmount(-1)).toThrow(RangeError);
  });

  it('calcule un pourcentage arrondi sans flottant', () => {
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(2, 3)).toBe(67);
    expect(percentOf(5000, 10000)).toBe(50);
    expect(percentOf(0, 0)).toBe(0);
  });
});
