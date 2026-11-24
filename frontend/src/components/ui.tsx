import { useEffect, useId, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { initials, toneFor } from '../lib/format';

/** Sets a CSS custom property through the style prop without fighting the type checker. */
export const tone = (value: string) => ({ '--tone': value }) as CSSProperties;

/** Position in a staggered `.reveal` entrance. */
export const step = (index: number) => ({ '--i': index }) as CSSProperties;

export function Avatar({ name, size = 34 }: { name: string; size?: number }) {
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ ...tone(toneFor(name)), width: size, height: size, fontSize: Math.round(size * 0.37) }}
    >
      {initials(name)}
    </span>
  );
}

/** `plain` keeps the text in the normal ink and puts the colour in the dot only: use it when the colour is a chart colour. */
export function Badge({ color, dot, plain, children }: { color: string; dot?: boolean; plain?: boolean; children: ReactNode }) {
  return (
    <span className={plain ? 'badge plain' : 'badge'} style={tone(color)}>
      {dot && <i />}
      {children}
    </span>
  );
}

export function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M12 4.5 20.5 19.5h-17z" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

export function Field({ label, children, full }: { label: string; children: ReactNode; full?: boolean }) {
  return (
    <label className={full ? 'field full' : 'field'}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export function useClickOutside(ref: RefObject<HTMLElement | null>, onOutside: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOutside();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, onOutside, active]);
}

/** Everything inside a dialog that the keyboard can reach. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps the Tab key inside something that is open on top of the page: past its last control it wraps to the first, and back. */
export function keepFocusInside(container: HTMLElement, e: KeyboardEvent) {
  if (e.key !== 'Tab') return;
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
  if (focusable.length === 0) return;
  const firstEl = focusable[0]!;
  const lastEl = focusable[focusable.length - 1]!;
  const active = document.activeElement as HTMLElement | null;
  const inside = active !== null && container.contains(active);
  if (e.shiftKey && (!inside || active === firstEl)) {
    e.preventDefault();
    lastEl.focus();
  } else if (!e.shiftKey && (!inside || active === lastEl)) {
    e.preventDefault();
    firstEl.focus();
  }
}

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** When set, the body and footer are wrapped in a form that calls this on submit. */
  onSubmit?: () => void;
  /** Skip the browser's own field checks, for forms that show their own message under each field. */
  ownValidation?: boolean;
}

export function Modal({ title, onClose, children, footer, width = 560, onSubmit, ownValidation }: ModalProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button.btn');
    first?.focus();
    // Only the dialog on top answers the keyboard, so Escape on a confirmation closes just that.
    const onTop = () => {
      const open = document.querySelectorAll('.modal');
      return open[open.length - 1] === ref.current;
    };
    const onKey = (e: KeyboardEvent) => {
      if (!onTop()) return;
      if (e.key === 'Escape') onClose();
      if (ref.current) keepFocusInside(ref.current, e);
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previous?.focus?.();
    };
    // Focus handling should run once per open, not on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inner = (
    <>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </>
  );

  return (
    <div
      className="scrim"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ '--modal-w': `${width}px` } as CSSProperties}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {onSubmit ? (
          <form
            noValidate={ownValidation}
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            {inner}
          </form>
        ) : (
          inner
        )}
      </div>
    </div>
  );
}

interface ConfirmProps {
  title: string;
  body: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}

export function Confirm({ title, body, confirmLabel = 'Delete', onConfirm, onClose }: ConfirmProps) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={420}
      footer={
        <>
          <button type="button" className="btn ghost on-surface" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn danger"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="muted">{body}</p>
    </Modal>
  );
}

/** `heading`: this message is all the screen shows, so its title is the screen's main heading. */
export function Empty({ icon, title, body, action, heading }: { icon: ReactNode; title: string; body: string; action?: ReactNode; heading?: boolean }) {
  return (
    <div className="empty">
      {icon}
      {heading ? <h1>{title}</h1> : <b>{title}</b>}
      <span>{body}</span>
      {action}
    </div>
  );
}

export interface TabItem<T extends string> {
  id: T;
  label: string;
  /** A number shown beside the label: how many there are, or how many are waiting. */
  count?: number;
  /** What the count counts, for someone who hears the tab instead of seeing it: "waiting". */
  countOf?: string;
}

/**
 * A row of tabs. One is chosen: the Tab key lands on it and goes on to what it shows, and the
 * arrow keys, Home and End move between the tabs. What the chosen tab shows goes in a
 * `TabPanel` with the same `name`.
 */
export function Tabs<T extends string>({ name, label, tabs, value, onChange }: { name: string; label: string; tabs: readonly TabItem<T>[]; value: T; onChange: (id: T) => void }) {
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.id === value);
    const to = e.key === 'ArrowRight' ? index + 1 : e.key === 'ArrowLeft' ? index - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length]!;
    onChange(next.id);
    document.getElementById(`${name}-tab-${next.id}`)?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`${name}-tab-${tab.id}`}
          aria-controls={`${name}-panel`}
          aria-selected={tab.id === value}
          tabIndex={tab.id === value ? 0 : -1}
          aria-label={tab.count !== undefined ? `${tab.label}, ${tab.count}${tab.countOf ? ` ${tab.countOf}` : ''}` : undefined}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className="tab-count" aria-hidden="true">
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/** What the chosen tab shows. */
export function TabPanel({ name, tab, children }: { name: string; tab: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`${name}-panel`} aria-labelledby={`${name}-tab-${tab}`}>
      {children}
    </div>
  );
}

interface PagerProps {
  page: number;
  pages: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
  noun: string;
}

export function Pager({ page, pages, total, pageSize, onPage, noun }: PagerProps) {
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="pager">
      <span>
        {from}–{to} of {total} {noun}
      </span>
      <div>
        <button className="icon-btn sm" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page">
          <ChevronLeft size={16} />
        </button>
        <span>
          {page} / {pages}
        </span>
        <button className="icon-btn sm" onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="Next page">
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
