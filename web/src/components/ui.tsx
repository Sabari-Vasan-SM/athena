import { useEffect, useRef, type ReactNode } from 'react';
import type { SyncState } from '../lib/types';

export function Badge({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'green' | 'yellow' | 'red' | 'blue' | 'accent'; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge--${tone}`} title={title}>
      {children}
    </span>
  );
}

export const SYNC_LABEL: Record<SyncState, { label: string; tone: 'green' | 'yellow' | 'red' | 'blue' }> = {
  synchronized: { label: 'Synchronized', tone: 'green' },
  'may-be-outdated': { label: 'May be outdated', tone: 'yellow' },
  missing: { label: 'Missing', tone: 'red' },
  'developer-owned': { label: 'Developer-owned', tone: 'blue' },
};

export function SyncDot({ state }: { state: SyncState }) {
  return <span className={`dot dot--${SYNC_LABEL[state].tone}`} title={SYNC_LABEL[state].label} aria-label={SYNC_LABEL[state].label} />;
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card__header">
          {title && <h2 className="card__title">{title}</h2>}
          {actions && <div className="card__actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__title">{title}</div>
      {children && <div className="empty__body">{children}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function ErrorNote({ error }: { error: Error & { hint?: string } }) {
  return (
    <div className="note note--error" role="alert">
      <strong>{error.message}</strong>
      {error.hint && <div className="note__hint">{error.hint}</div>}
    </div>
  );
}

export function ConfirmDialog({ open, title, body, confirmLabel, danger, onConfirm, onCancel }: { open: boolean; title: string; body: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" onCancel={(e) => (e.preventDefault(), onCancel())} onClose={() => open && onCancel()}>
      <h3 className="dialog__title">{title}</h3>
      <div className="dialog__body">{body}</div>
      <div className="dialog__actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`} onClick={onConfirm} autoFocus>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
