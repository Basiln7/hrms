import { CircleAlert, Copy, Check } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import { Modal } from './ui';

/** Shown where something could not be loaded: the reason, and another try. */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="load-error" role="alert">
      <CircleAlert size={26} />
      <span>{message}</span>
      <button type="button" className="btn ghost sm" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/** Grey rows in the shape of a table, while its first page is being fetched. */
export function SkeletonRows({ rows = 6, columns }: { rows?: number; columns: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, row) => (
        <tr key={row} aria-hidden="true">
          {Array.from({ length: columns }, (_, column) => (
            <td key={column}>
              <span className="skeleton" style={{ width: `${column === 0 ? 70 : 40 + ((row * 7 + column * 13) % 40)}%` } as CSSProperties} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** A few grey lines, for a card that is waiting for its content. */
export function SkeletonLines({ lines = 4 }: { lines?: number }) {
  return (
    <div style={{ display: 'grid', gap: 12 }} role="status" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton" style={{ width: `${90 - ((i * 17) % 45)}%` }} />
      ))}
    </div>
  );
}

/**
 * A temporary password, shown this once. It is kept nowhere it can be read again, so the
 * dialog says so and makes it easy to copy and pass on.
 */
export function TemporaryPasswordDialog({ title, name, email, password, onClose }: { title: string; name: string; email: string; password: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      // No clipboard access: the password is selectable on screen instead.
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button type="button" className="btn ghost on-surface" onClick={() => void copy()}>
            {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copied' : 'Copy password'}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginBottom: 14 }}>
        Give this temporary password to {name}. They sign in with <b>{email}</b> and are asked to choose their own before anything else.
      </p>
      <code className="secret" aria-label="Temporary password">
        {password}
      </code>
      <p className="note" style={{ marginTop: 14 }}>
        It is shown only this once and cannot be looked up later. If it is lost, give them a new one with “Reset password”.
      </p>
    </Modal>
  );
}
