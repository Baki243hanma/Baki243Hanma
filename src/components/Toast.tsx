/** Messages de confirmation / erreur après chaque action (non bloquants). */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

type ToastTone = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastContextValue {
  show: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast doit être utilisé dans ToastProvider');
  return ctx;
}

const TONE_CLASSES: Record<ToastTone, string> = {
  success: 'bg-emerald-700 text-white',
  error: 'bg-rose-700 text-white',
  info: 'bg-slate-900 text-white',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const show = useCallback((message: string, tone: ToastTone = 'info') => {
    counter.current += 1;
    const id = counter.current;
    setItems((prev) => [...prev.slice(-2), { id, tone, message }]);
    window.setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), tone === 'error' ? 6000 : 3500);
  }, []);

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6">
        {items.map((t) => (
          <div key={t.id} role="status" className={`sf-fade-in pointer-events-auto w-full max-w-md rounded-2xl px-4 py-3 text-center text-sm font-semibold shadow-lg ${TONE_CLASSES[t.tone]}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
