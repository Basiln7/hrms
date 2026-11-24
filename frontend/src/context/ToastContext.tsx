import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck } from 'lucide-react';

type Tone = 'ok' | 'error';

/** An optional button on a toast, e.g. Undo. */
export interface ToastAction {
  label: string;
  onAction: () => void;
}

interface Toast {
  id: number;
  text: string;
  tone: Tone;
  action?: ToastAction;
}

const Ctx = createContext<((text: string, tone?: Tone, action?: ToastAction) => void) | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const push = useCallback(
    (text: string, tone: Tone = 'ok', action?: ToastAction) => {
      const id = nextId++;
      setToasts((t) => [...t.slice(-2), { id, text, tone, action }]);
      // Toasts with an action stay longer so there is time to use it, and errors so there is time to read them.
      window.setTimeout(() => dismiss(id), action ? 8000 : tone === 'error' ? 7000 : 3200);
    },
    [dismiss],
  );

  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast" data-tone={t.tone}>
            {t.tone === 'ok' ? <CircleCheck size={17} /> : <CircleAlert size={17} />}
            {t.text}
            {t.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  t.action!.onAction();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

// Development only. This module holds live app state behind a React context. Hot-swapping it
// would leave the old provider mounted while screens pick up a new context object, which
// blanks the page. Reloading keeps the two in step; nothing is lost, the state is reloaded.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
