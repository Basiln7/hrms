import { useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff, Lock, Moon, Sun } from 'lucide-react';
import { isTimeZone, localParts, WEEKDAY_NAMES } from '@delta-hrms/shared';
import { useTheme } from '../context/ThemeContext';
import { serverNow } from '../lib/serverClock';
import { timeZoneOptions } from '../lib/timeZones';
import { FormField } from './FormField';
import { BrandMark, Empty } from './ui';

/** The product's name beside its mark, as on the sidebar and the sign-in card. */
export function Brand() {
  return (
    <div className="brand">
      <BrandMark />
      <span className="brand-name">
        Delta<small>HRMS</small>
      </span>
    </div>
  );
}

export function ThemeToggle({ className = 'icon-btn' }: { className?: string }) {
  const { resolved, toggle } = useTheme();
  return (
    <button type="button" className={className} onClick={toggle} aria-label={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} theme`}>
      {resolved === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
    </button>
  );
}

export function NoAccess({ section }: { section: string }) {
  return (
    <section className="card">
      <Empty icon={<Lock size={32} />} title={`${section} is not available for your role`} body="If you need it for your work, ask an Admin to change your role." heading />
    </section>
  );
}

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'>;

/** A password box with a button to show what was typed. */
export function PasswordInput(props: PasswordInputProps) {
  const [shown, setShown] = useState(false);
  return (
    <span className="input-icon">
      <Lock size={17} />
      <input className="input" type={shown ? 'text' : 'password'} {...props} />
      <button type="button" className="icon-btn sm" onClick={() => setShown((s) => !s)} aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown}>
        {shown ? <EyeOff size={17} /> : <Eye size={17} />}
      </button>
    </span>
  );
}

const TIME_ZONE_LIST = 'time-zone-options';

/**
 * A time zone, typed or picked from the suggestions. Underneath it says what time it is there
 * now, which is the quickest way to see that the right zone was chosen.
 */
export function TimeZoneField({ value, onChange, error, label = 'Time zone' }: { value: string; onChange: (zone: string) => void; error?: string; label?: string }) {
  const zone = value.trim();
  const valid = isTimeZone(zone);
  const there = valid ? localParts(serverNow(), zone) : null;
  return (
    <FormField
      label={label}
      required
      error={error ?? (zone && !valid ? 'That is not a time zone. Choose one from the list, for example Asia/Kolkata.' : undefined)}
      hint={there ? <span className="field-hint">It is {there.time} on {WEEKDAY_NAMES[there.weekday]} there now.</span> : <span className="field-hint">Start typing a region or city, for example Asia/Kolkata or Asia/Dubai.</span>}
    >
      {({ id, describedBy, invalid }) => (
        <>
          <input
            id={id}
            className="input"
            list={TIME_ZONE_LIST}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            autoComplete="off"
            spellCheck={false}
            placeholder="Asia/Kolkata"
            required
          />
          <datalist id={TIME_ZONE_LIST}>
            {timeZoneOptions().map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
        </>
      )}
    </FormField>
  );
}
