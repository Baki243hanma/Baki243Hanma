/** Boîte de confirmation pour les actions importantes (annulation, déconnexion, abandon). */
import { useState, type ReactNode } from 'react';
import { Button, Sheet } from './ui';

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  tone = 'primary',
  onConfirm,
  onCancel,
  busy = false,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger' | 'warning';
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <Sheet
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button variant={tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'primary'} block onClick={() => void onConfirm()} disabled={busy}>
            {busy ? 'Veuillez patienter…' : confirmLabel}
          </Button>
          <Button variant="secondary" block onClick={onCancel} disabled={busy}>
            Annuler
          </Button>
        </div>
      }
    >
      <div className="text-base leading-relaxed text-slate-700">{message}</div>
    </Sheet>
  );
}

/** Petit utilitaire : état « occupé » + gestion d'erreur pour une action asynchrone. */
export function useAsyncAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<void>, onError?: (msg: string) => void): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      const msg = (e as Error).message || 'Une erreur est survenue.';
      setError(msg);
      onError?.(msg);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}
