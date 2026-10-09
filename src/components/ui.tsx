/** Composants d'interface réutilisables : boutons, champs, badges, états vides, fenêtres. */
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'warning';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand-700 text-white shadow-sm hover:bg-brand-800 disabled:bg-slate-300',
  secondary: 'bg-white text-brand-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-300',
  warning: 'bg-amber-500 text-white hover:bg-amber-600 disabled:bg-amber-200',
  ghost: 'bg-transparent text-brand-800 hover:bg-brand-50 disabled:text-slate-400',
};

export function Button({
  variant = 'primary',
  block = false,
  size = 'lg',
  className = '',
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; block?: boolean; size?: 'md' | 'lg' }) {
  const sizing = size === 'lg' ? 'min-h-12 px-5 py-3 text-base' : 'min-h-10 px-4 py-2 text-sm';
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed ${sizing} ${BUTTON_VARIANTS[variant]} ${block ? 'w-full' : ''} ${className}`}
      {...rest}
    />
  );
}

export function Card({ children, className = '', as: Tag = 'div' }: { children: ReactNode; className?: string; as?: 'div' | 'section' | 'article' }) {
  return <Tag className={`rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70 ${className}`}>{children}</Tag>;
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-slate-600">{subtitle}</div>}
      </div>
      {action}
    </div>
  );
}

interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
  required?: boolean;
}

export function Field({ label, error, hint, children, required }: FieldProps) {
  const id = useId();
  const hintId = hint || error ? `${id}-desc` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold text-slate-800">
        {label}
        {required && <span className="text-rose-600"> *</span>}
      </label>
      {children(id, hintId)}
      {error ? (
        <p id={hintId} className="text-sm font-medium text-rose-700" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-sm text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const INPUT_BASE =
  'w-full min-h-12 rounded-xl border bg-white px-4 py-3 text-base text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-4 focus:ring-brand-100';

export function TextInput({
  error,
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { error?: boolean }) {
  return (
    <input
      className={`${INPUT_BASE} ${error ? 'border-rose-500 bg-rose-50/40' : 'border-slate-300'} ${className}`}
      aria-invalid={error || undefined}
      {...rest}
    />
  );
}

export function SelectInput({
  error,
  className = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { error?: boolean }) {
  return (
    <select
      className={`${INPUT_BASE} appearance-none ${error ? 'border-rose-500' : 'border-slate-300'} ${className}`}
      aria-invalid={error || undefined}
      {...rest}
    >
      {children}
    </select>
  );
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand';

const TONES: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700',
  success: 'bg-emerald-100 text-emerald-800',
  warning: 'bg-amber-100 text-amber-900',
  danger: 'bg-rose-100 text-rose-800',
  info: 'bg-sky-100 text-sky-900',
  brand: 'bg-brand-100 text-brand-800',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${TONES[tone]}`}>{children}</span>;
}

export function Banner({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const styles = {
    info: 'bg-sky-50 text-sky-950 ring-sky-200',
    warning: 'bg-amber-50 text-amber-950 ring-amber-200',
    danger: 'bg-rose-50 text-rose-950 ring-rose-200',
    success: 'bg-emerald-50 text-emerald-950 ring-emerald-200',
  } as const;
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={`sf-fade-in flex flex-col gap-2 rounded-2xl p-4 ring-1 ${styles[tone]}`}>
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className="text-sm leading-relaxed">{children}</div>}
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
  icon,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 py-10 text-center">
      {icon ?? (
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-700" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </div>
      )}
      <p className="text-base font-semibold text-slate-900">{title}</p>
      {children && <div className="max-w-sm text-sm text-slate-600">{children}</div>}
      {action}
    </div>
  );
}

export function Spinner({ label = 'Chargement…' }: { label?: string }) {
  return (
    <div role="status" className="flex flex-col items-center justify-center gap-3 py-16 text-slate-600">
      <div className="h-9 w-9 animate-spin rounded-full border-4 border-brand-100 border-t-brand-700" aria-hidden="true" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

/** Fenêtre modale (feuille du bas sur mobile). Fermable par Échap et par le bouton « Fermer ». */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="sf-sheet-up flex max-h-[90dvh] w-full max-w-lg flex-col rounded-t-3xl bg-white shadow-xl outline-none sm:rounded-3xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <h2 id={titleId} className="text-lg font-bold text-slate-900">
            {title}
          </h2>
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100">
            Fermer
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="safe-bottom border-t border-slate-100 bg-white px-5 py-4">{footer}</div>}
      </div>
    </div>
  );
}

export function Stat({ label, value, hint, tone = 'default' }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'brand' | 'success' | 'warning' }) {
  const valueTone = {
    default: 'text-slate-900',
    brand: 'text-brand-800',
    success: 'text-emerald-800',
    warning: 'text-amber-800',
  }[tone];
  return (
    <Card className="flex flex-col gap-1">
      <p className="text-sm font-medium text-slate-600">{label}</p>
      <p className={`text-xl font-bold tracking-tight tabular-nums sm:text-2xl ${valueTone}`}>{value}</p>
      {hint && <p className="text-xs leading-relaxed text-slate-500">{hint}</p>}
    </Card>
  );
}

export function Spacer({ className = '' }: { className?: string }) {
  return <div className={className} aria-hidden="true" />;
}
