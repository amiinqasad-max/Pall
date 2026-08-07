import { useUi } from '@/state/ui';

/** Transient notifications. Never blocks input; never demands a dismissal. */
export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  if (toasts.length === 0) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.tone !== 'info' ? `toast--${toast.tone}` : ''}`}>
          {toast.icon && <span aria-hidden="true">{toast.icon}</span>}
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  );
}
