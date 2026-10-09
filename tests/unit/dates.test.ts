import { describe, expect, it } from 'vitest';
import { computePeriod, inPeriod, toDateInput, fromDateInput } from '../../src/lib/dates';

describe('périodes de filtrage', () => {
  const now = new Date(2026, 9, 9, 15, 30); // 9 octobre 2026, 15 h 30 (heure locale)

  it('aujourd’hui commence à minuit local et finit à minuit suivant', () => {
    const p = computePeriod('today', now);
    expect(new Date(p.start!).getTime()).toBe(new Date(2026, 9, 9).getTime());
    expect(new Date(p.end!).getTime()).toBe(new Date(2026, 9, 10).getTime());
    expect(inPeriod(new Date(2026, 9, 9, 23, 59).toISOString(), p)).toBe(true);
    expect(inPeriod(new Date(2026, 9, 10, 0, 0).toISOString(), p)).toBe(false);
  });

  it('hier se termine où commence aujourd’hui', () => {
    const y = computePeriod('yesterday', now);
    const t = computePeriod('today', now);
    expect(y.end).toBe(t.start);
  });

  it('7 derniers jours inclut aujourd’hui et les six jours précédents', () => {
    const p = computePeriod('last7', now);
    expect(new Date(p.start!).getTime()).toBe(new Date(2026, 9, 3).getTime());
    expect(new Date(p.end!).getTime()).toBe(new Date(2026, 9, 10).getTime());
  });

  it('mois en cours couvre du 1er au dernier jour', () => {
    const p = computePeriod('month', now);
    expect(new Date(p.start!).getTime()).toBe(new Date(2026, 9, 1).getTime());
    expect(new Date(p.end!).getTime()).toBe(new Date(2026, 10, 1).getTime());
  });

  it('période personnalisée inclut les deux bornes (jours entiers)', () => {
    const p = computePeriod('custom', now, { from: '2026-10-01', to: '2026-10-02' });
    expect(inPeriod(new Date(2026, 9, 2, 22, 0).toISOString(), p)).toBe(true);
    expect(inPeriod(new Date(2026, 9, 3, 0, 0).toISOString(), p)).toBe(false);
  });

  it('une période personnalisée invalide revient à aujourd’hui', () => {
    const p = computePeriod('custom', now, { from: '2026-10-05', to: '2026-10-01' });
    expect(p.start).toBe(computePeriod('today', now).start);
  });

  it('convertit les dates de saisie AAAA-MM-JJ', () => {
    expect(toDateInput(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(fromDateInput('2026-02-30')).toBeNull();
    expect(fromDateInput('pas-une-date')).toBeNull();
  });
});
