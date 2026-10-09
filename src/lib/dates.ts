/**
 * Périodes de filtrage. Les bornes sont calculées dans le fuseau local de l'appareil
 * (Africa/Kinshasa, UTC+1 sans heure d'été, pour la RDC).
 * Les dates sont stockées en ISO 8601 UTC ; la comparaison de chaînes ISO est donc ordonnée.
 */

export type PeriodKind = 'today' | 'yesterday' | 'last7' | 'month' | 'custom' | 'all';

export interface Period {
  kind: PeriodKind;
  /** Début inclus (ISO UTC) ou null pour « tout ». */
  start: string | null;
  /** Fin exclusive (ISO UTC) ou null pour « tout ». */
  end: string | null;
  label: string;
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, 0, 0, 0, 0);
}

/** Date locale au format AAAA-MM-JJ (utilisé par les champs « date »). */
export function toDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Interprète AAAA-MM-JJ comme jour local. Retourne null si invalide. */
export function fromDateInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  if (date.getFullYear() !== Number(y) || date.getMonth() !== Number(m) - 1 || date.getDate() !== Number(d)) {
    return null;
  }
  return date;
}

export function formatDayLabel(d: Date): string {
  return d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short' });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/** Calcule la période pour un type donné à partir de « maintenant ». */
export function computePeriod(kind: PeriodKind, now: Date, custom?: { from: string; to: string }): Period {
  const today = startOfDay(now);
  switch (kind) {
    case 'today':
      return { kind, start: today.toISOString(), end: addDays(today, 1).toISOString(), label: "Aujourd'hui" };
    case 'yesterday':
      return {
        kind,
        start: addDays(today, -1).toISOString(),
        end: today.toISOString(),
        label: 'Hier',
      };
    case 'last7':
      return {
        kind,
        start: addDays(today, -6).toISOString(),
        end: addDays(today, 1).toISOString(),
        label: '7 derniers jours',
      };
    case 'month': {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return { kind, start: first.toISOString(), end: nextMonth.toISOString(), label: 'Ce mois' };
    }
    case 'custom': {
      const from = custom ? fromDateInput(custom.from) : null;
      const to = custom ? fromDateInput(custom.to) : null;
      if (!from || !to || to < from) {
        return { kind, start: today.toISOString(), end: addDays(today, 1).toISOString(), label: 'Période personnalisée' };
      }
      return {
        kind,
        start: from.toISOString(),
        end: addDays(to, 1).toISOString(),
        label: `Du ${formatDayLabel(from)} au ${formatDayLabel(to)}`,
      };
    }
    case 'all':
      return { kind, start: null, end: null, label: 'Tout' };
  }
}

/** Vrai si l'instant ISO appartient à la période (début inclus, fin exclusive). */
export function inPeriod(iso: string, period: Period): boolean {
  if (period.start !== null && iso < period.start) return false;
  if (period.end !== null && iso >= period.end) return false;
  return true;
}
