import { useId, type ReactNode } from 'react';

interface FormFieldProps {
  label: string;
  /** Marks the field as one that must be filled in (a star after the label). */
  required?: boolean;
  /** A light note after the label, e.g. "optional". */
  aside?: string;
  /** Validation message for this field. Replaces the hint while present. */
  error?: string;
  hint?: ReactNode;
  /** Span both columns of a `.form-grid`. */
  full?: boolean;
  /** Receives what to wire onto the control: its id, what describes it, and whether it is invalid. */
  children: (ids: { id: string; describedBy: string | undefined; invalid: true | undefined }) => ReactNode;
}

/** A labelled form row that shows its validation message underneath and links it for screen readers. */
export function FormField({ label, required, aside, error, hint, full, children }: FormFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className={full ? 'field full' : 'field'}>
      <label className="field-label" htmlFor={id}>
        {label}
        {required && (
          <span className="field-required" aria-hidden="true">
            {' '}*
          </span>
        )}
        {aside && <span className="field-aside"> ({aside})</span>}
      </label>
      {children({ id, describedBy: error ? errorId : undefined, invalid: error ? true : undefined })}
      {error ? (
        <span className="field-error" id={errorId} role="alert">
          {error}
        </span>
      ) : (
        hint
      )}
    </div>
  );
}
