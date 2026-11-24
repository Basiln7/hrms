import { useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { CalendarOff, CircleCheck, CircleSlash, Clock, ClockAlert, Coffee, LogIn, LogOut, Pause, Play, Timer, TreePalm, TriangleAlert, type LucideIcon } from 'lucide-react';
import {
  checkOutInWords,
  dayInWords,
  describeToday,
  flagWords,
  formatMinutes,
  liveDay,
  liveWords,
  localParts,
  WEEKDAY_NAMES,
  weekdayOf,
  type TodayPayload,
  type TodayState,
} from '@delta-hrms/shared';
import { FlagBadges, TONE_COLOR } from '../../components/attendance';
import { Modal, tone } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { api, messageOf } from '../../lib/api';
import { stopwatch } from '../../lib/format';
import { syncServerClock, useServerNow } from '../../lib/serverClock';

type Action = 'check-in' | 'check-out' | 'break/start' | 'break/end';

const STATE_ICON: Record<TodayState, LucideIcon> = {
  no_schedule: CalendarOff,
  not_counted: CircleSlash,
  day_off: CalendarOff,
  on_leave: TreePalm,
  not_due: Clock,
  not_in: ClockAlert,
  working: Timer,
  on_break: Coffee,
  checked_out: CircleCheck,
  missing_check_out: TriangleAlert,
};

const SENDING: Record<Action, string> = { 'check-in': 'Checking in…', 'check-out': 'Checking out…', 'break/start': 'Starting break…', 'break/end': 'Ending break…' };

/** What a punch did, for the toast, which is also what a screen reader hears. */
function doneInWords(action: Action, after: TodayPayload): string {
  const { day } = after;
  const time = (moment: string | null) => (moment ? localParts(moment, after.dayRules?.timeZone ?? after.timeZone).time : '');
  if (action === 'check-in') {
    const late = flagWords(day).find((word) => word.flag === 'late');
    return `Checked in at ${time(day.checkInAt)}.${late ? ` ${late.text}.` : ''}`;
  }
  if (action === 'check-out') return `Checked out at ${time(day.checkOutAt)}. ${formatMinutes(day.workedMinutes)} worked.`;
  if (action === 'break/start') return `Break started at ${time(day.onBreakSince)}.`;
  return 'Break ended.';
}

/**
 * The time worked so far, counted on the server's clock with the engine's own arithmetic, so
 * it shows what checking out now would record. It is drawn again every second; nothing else
 * on the page is.
 */
function LiveTimer({ today }: { today: TodayPayload }) {
  const now = useServerNow(1000);
  const live = liveDay(today, now);
  if (!live) return null;
  const words = liveWords(today, live);
  const tracksBreak = today.dayRules?.break.mode !== 'none';
  return (
    <div className="timer" data-moving={live.moving}>
      <div className="timer-main">
        {/* A timer is not read out as it ticks; its label gives the time in words when asked. */}
        <span className="timer-digits" role="timer" aria-label={`Worked so far: ${formatMinutes(live.workedMinutes)}`}>
          {stopwatch(live.workedMinutes, live.seconds)}
        </span>
        <span className="timer-label">worked so far</span>
      </div>
      {words.paused && (
        <p className="timer-paused">
          <Pause size={14} aria-hidden="true" />
          {words.paused}
        </p>
      )}
      {words.progress && (
        <div>
          <div
            className="progress"
            role="progressbar"
            aria-label="Progress to a full day"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(words.progress.fraction * 100)}
            aria-valuetext={words.progress.text}
            style={{ '--p': words.progress.fraction } as CSSProperties}
          >
            <i />
            {words.progress.halfAt !== null && <span className="progress-mark" style={{ '--at': words.progress.halfAt } as CSSProperties} />}
          </div>
          <p className="timer-caption">{words.progress.text}</p>
        </div>
      )}
      <dl className="timer-facts">
        <div>
          <dt>Since check-in</dt>
          <dd>{formatMinutes(live.grossMinutes)}</dd>
        </div>
        {tracksBreak && (
          <div>
            <dt>Break taken off</dt>
            <dd>{formatMinutes(live.breakMinutes)}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/** Asked before a check-out, which cannot be taken back: what the day will count as. */
function CheckOutDialog({ today, onConfirm, onClose }: { today: TodayPayload; onConfirm: () => void; onClose: () => void }) {
  // The wording is to the minute, so it only needs to keep up with the minute.
  const now = useServerNow(5000);
  const words = checkOutInWords(today, now);
  const title = today.day.date === today.today ? 'Check out now?' : `Check out for ${dayInWords(today.day.date)}?`;
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button type="button" className="btn ghost on-surface" onClick={onClose}>
            Not yet
          </button>
          <button type="button" className="btn" onClick={onConfirm}>
            <LogOut size={16} aria-hidden="true" /> Check out
          </button>
        </>
      }
    >
      <div className="confirm-lines" data-warn={words?.warn ?? false}>
        {(words?.lines ?? ['The time is recorded as it is now.']).map((line, index) => (
          <p key={index}>{line}</p>
        ))}
      </div>
    </Modal>
  );
}

interface Props {
  today: TodayPayload;
  /** A punch went through: this is the new state. */
  onChanged: (today: TodayPayload) => void;
  /** A punch was refused, so what is on screen is out of date: fetch it again. */
  onStale: () => void;
}

/**
 * Today: the state in words, the live timer while a day is open, and the buttons the server
 * says are possible right now. Every state and every sentence comes from `describeToday` in
 * shared; this component only lays them out.
 */
export function TodayCard({ today, onChanged, onStale }: Props) {
  const toast = useToast();
  const [sending, setSending] = useState<Action | null>(null);
  const [confirming, setConfirming] = useState(false);
  // State is set a moment after a tap. This is set at once, so a second tap in between sends nothing.
  const inFlight = useRef(false);

  const { day, can } = today;
  const words = describeToday(today);
  const Icon = STATE_ICON[words.state];
  const otherDay = day.date !== today.today;
  const weekday = WEEKDAY_NAMES[weekdayOf(day.date)];
  const hours = today.hours ? (today.hours.start && today.hours.end ? `${today.hours.start} to ${today.hours.end}` : `Flexible, ${formatMinutes(today.hours.requiredMinutes)}`) : null;
  const sub = [dayInWords(today.today), today.dayRules?.name ?? today.rules?.name, hours].filter(Boolean).join(' · ');

  async function act(action: Action) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(action);
    try {
      // Nothing is sent but the request itself: the time is the server's.
      const after = await api.post<TodayPayload>(`/attendance/${action}`);
      syncServerClock(after.serverNow);
      onChanged(after);
      toast(doneInWords(action, after));
    } catch (error) {
      toast(messageOf(error), 'error');
      onStale();
    } finally {
      inFlight.current = false;
      setSending(null);
    }
  }

  const label = (action: Action, text: string) => (sending === action ? SENDING[action] : text);
  const busy = sending !== null;
  const checkInText = day.kind !== null && day.kind !== 'working' ? 'Check in on a day off' : otherDay ? `Check in for ${weekday}` : 'Check in';
  const checkOutText = otherDay ? `Check out for ${weekday}` : 'Check out';
  // On a break the way back to work comes first; checking out stays possible beside it.
  const breakFirst = can.endBreak;

  return (
    <section className="card today" aria-labelledby="today-title">
      <div className="card-head">
        <div>
          <h2 className="card-title" id="today-title">
            Today
          </h2>
          <p className="card-sub">{sub}</p>
        </div>
      </div>

      <div aria-live="polite">
        <div className="today-status" style={tone(TONE_COLOR[words.tone])}>
          <span className="state-icon">
            <Icon size={22} aria-hidden="true" />
          </span>
          <b>{words.headline}</b>
        </div>
        <div className="today-lines">
          {words.lines.map((line, index) => (
            <p key={index}>{line}</p>
          ))}
        </div>
      </div>

      {flagWords(day).length > 0 && (
        <div className="badges today-flags">
          <FlagBadges day={day} />
        </div>
      )}

      {can.checkOut && <LiveTimer today={today} />}

      {(can.checkIn || can.checkOut || can.startBreak || can.endBreak) && (
        <div className="today-actions">
          {can.checkIn && (
            <button type="button" className="btn lg" disabled={busy} onClick={() => void act('check-in')}>
              <LogIn size={19} aria-hidden="true" /> {label('check-in', checkInText)}
            </button>
          )}
          {can.endBreak && (
            <button type="button" className="btn lg" disabled={busy} onClick={() => void act('break/end')}>
              <Play size={19} aria-hidden="true" /> {label('break/end', 'End break')}
            </button>
          )}
          {can.checkOut && (
            <button type="button" className={breakFirst ? 'btn lg ghost' : 'btn lg'} disabled={busy} onClick={() => setConfirming(true)}>
              <LogOut size={19} aria-hidden="true" /> {label('check-out', checkOutText)}
            </button>
          )}
          {can.startBreak && (
            <button type="button" className="btn lg ghost" disabled={busy} onClick={() => void act('break/start')}>
              <Coffee size={19} aria-hidden="true" /> {label('break/start', 'Start break')}
            </button>
          )}
        </div>
      )}

      {/* A day that was never checked out, or one still open from an earlier date: the other way out is a correction. */}
      {(words.state === 'missing_check_out' || today.openFromEarlier) && (
        <p className="today-more">
          <Link className="link" to={`/attendance?day=${day.date}${words.state === 'missing_check_out' ? '&ask=1' : ''}`}>
            {words.state === 'missing_check_out' ? 'Ask for a correction of this day' : 'Open that day, to ask for a correction once it has closed'}
          </Link>
        </p>
      )}

      {confirming && (
        <CheckOutDialog
          today={today}
          onClose={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void act('check-out');
          }}
        />
      )}
    </section>
  );
}
