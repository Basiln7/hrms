import { useState } from 'react';
import { FilePenLine, StickyNote } from 'lucide-react';
import { changeInWords, CORRECTION_INFO, dayInWords, formatMinutes, HOLIDAY_TYPE_INFO, LEAVE_PART_LABEL, localParts, type AttendanceHistoryEntry, type DayDetailPayload, type LocalDate } from '@delta-hrms/shared';
import { FlagBadges, StatusBadge } from '../../components/attendance';
import { LoadError, SkeletonLines } from '../../components/states';
import { Confirm, Modal } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { api, messageOf } from '../../lib/api';
import { shortDate } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { CorrectionDialog, DirectCorrectionDialog, NoteDialog } from './correctionDialogs';

const HISTORY_WORDS: Record<AttendanceHistoryEntry['kind'], string> = {
  check_in: 'Checked in',
  check_out: 'Checked out',
  break_start: 'Break started',
  break_end: 'Break ended',
  corrected: 'Times corrected',
  overridden: 'Status set by hand',
  excused: 'Late entry excused',
  note: 'Note changed',
};

function Fact({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

interface Props {
  employeeId: string;
  date: LocalDate;
  timeZone: string;
  /** Start with the form to ask for a correction open (from a link on the home page). */
  asking?: boolean;
  onClose: () => void;
  /** Something about the day changed: the page behind should ask the server again. */
  onChanged: () => void;
}

/**
 * One day in full: how it reads now, what was recorded, HR's note, a request that is waiting,
 * and everything that ever happened to it. What may be done about it (ask for a correction,
 * correct it, leave a note) is offered only where the server says it is possible.
 */
export function DayDialog({ employeeId, date, timeZone, asking, onClose, onChanged }: Props) {
  const toast = useToast();
  const { data, error, reload } = useLoad<DayDetailPayload>(`/attendance/days/${employeeId}/${date}`);
  const [dialog, setDialog] = useState<'ask' | 'correct' | 'note' | 'cancel' | null>(asking ? 'ask' : null);
  const zone = data?.timeZone ?? timeZone;
  const time = (moment: string | null) => (moment ? localParts(moment, zone).time : null);
  const day = data?.day;
  const changed = () => {
    reload();
    onChanged();
  };

  const cancelRequest = async () => {
    if (!data?.pending) return;
    try {
      await api.post(`/regularizations/${data.pending.id}/cancel`);
      toast('The request is cancelled.');
    } catch (failure) {
      toast(messageOf(failure), 'error');
    }
    changed();
  };

  const mine = data?.requestable !== null && data?.requestable !== undefined;
  const canAsk = mine && data.requestable!.types.length > 0;

  return (
    <>
    <Modal
      title={`${dayInWords(date)} ${date.slice(0, 4)}`}
      onClose={onClose}
      width={540}
      footer={
        <>
          {data?.editable && (
            <>
              <button type="button" className="btn ghost on-surface" onClick={() => setDialog('note')}>
                <StickyNote size={16} aria-hidden="true" /> {data.record?.note ? 'Change note' : 'Add note'}
              </button>
              <button type="button" className="btn ghost on-surface" onClick={() => setDialog('correct')}>
                <FilePenLine size={16} aria-hidden="true" /> Correct this day
              </button>
            </>
          )}
          {canAsk && (
            <button type="button" className="btn ghost on-surface" onClick={() => setDialog('ask')}>
              <FilePenLine size={16} aria-hidden="true" /> Ask for a correction
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {error && !data ? (
        <LoadError message={error} onRetry={reload} />
      ) : !data || !day ? (
        <SkeletonLines lines={5} />
      ) : (
        <div className="day-detail">
          <div className="badges">
            <StatusBadge status={day.status} />
            <FlagBadges day={day} />
          </div>

          {day.holiday && (
            <p className="muted">
              {day.holiday.name}: {HOLIDAY_TYPE_INFO[day.holiday.type].label.toLowerCase()}. {HOLIDAY_TYPE_INFO[day.holiday.type].hint}
            </p>
          )}
          {day.leave && (
            <p className="muted">
              Approved leave: {day.leave.name ?? 'leave'}
              {day.leave.units === 0.5 ? `, ${LEAVE_PART_LABEL[day.leave.part].toLowerCase()}` : ''}.{day.flags.includes('worked_on_leave') ? ' The hours worked are recorded, and the day still counts as leave.' : ''}
            </p>
          )}
          {day.flags.includes('pending_leave') && <p className="muted">A leave request that includes this day is waiting for a decision. Until it is approved the day reads as it would without it.</p>}
          {day.status === 'not_applicable' && <p className="muted">Attendance was not counted for this day: it is outside their time on a work schedule.</p>}

          {data.record?.note && (
            <div className="note">
              <b>Note from HR</b>
              <p>{data.record.note.text}</p>
              <span className="field-hint">
                {data.record.note.byName} · {shortDate(data.record.note.at, zone)}
              </span>
            </div>
          )}

          {data.pending && (
            <div className="note warn" style={{ marginTop: 0 }}>
              <div className="effect-lines">
                <p>
                  <b>A correction is waiting for a decision:</b> {CORRECTION_INFO[data.pending.type].label.toLowerCase()}
                  {changeInWords(data.pending.requested, date, zone).length > 0 ? ` (${changeInWords(data.pending.requested, date, zone).join(', ').toLowerCase()})` : ''}.
                </p>
                <p className="quote">{data.pending.reason}</p>
                {mine && (
                  <p>
                    <button type="button" className="link" onClick={() => setDialog('cancel')}>
                      Cancel this request
                    </button>
                  </p>
                )}
              </div>
            </div>
          )}

          <dl className="facts">
            <Fact label="Schedule" value={data.scheduleName} />
            <Fact label="Expected" value={day.requiredMinutes !== null ? formatMinutes(day.requiredMinutes) : null} />
            <Fact label="Checked in" value={time(day.checkInAt)} />
            <Fact label="Checked out" value={day.checkInAt ? (time(day.checkOutAt) ?? 'Not checked out') : null} />
            <Fact label="Break taken off" value={day.checkInAt && (day.checkOutAt || day.closableUntil) ? formatMinutes(day.breakMinutes) : null} />
            <Fact label={day.checkOutAt ? 'Time worked' : 'Worked so far'} value={day.checkInAt && (day.checkOutAt || day.closableUntil) ? formatMinutes(day.workedMinutes) : null} />
          </dl>

          {!data.record?.checkInAt && day.kind !== null && <p className="muted">Nothing was punched on this day.</p>}
          {mine && !canAsk && !data.pending && data.requestable?.blocked && day.kind !== null && <p className="field-hint">{data.requestable.blocked}</p>}

          {data.record && data.record.breaks.length > 0 && (
            <>
              <h3 className="subhead">Breaks</h3>
              <ul className="history">
                {data.record.breaks.map((b) => (
                  <li key={b.startAt}>
                    <span>
                      {time(b.startAt)} to {time(b.endAt) ?? 'still running'}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {data.record && data.record.history.length > 0 && (
            <>
              <h3 className="subhead">What happened, in order</h3>
              <ol className="history">
                {data.record.history.map((entry, index) => {
                  // A punch is listed at its own time; anything done afterwards, on the day it was done.
                  const punched = entry.kind === 'check_in' || entry.kind === 'check_out' || entry.kind === 'break_start' || entry.kind === 'break_end';
                  const change = entry.kind === 'corrected' || entry.kind === 'overridden' || entry.kind === 'excused' ? changeInWords((entry.after ?? {}) as Parameters<typeof changeInWords>[0], date, zone).join(', ') : '';
                  return (
                    <li key={index}>
                      <b>{punched ? time(entry.at) : shortDate(entry.at, zone).replace(/ \d{4}$/, '')}</b>
                      <span>
                        {HISTORY_WORDS[entry.kind]}
                        {change ? `: ${change.toLowerCase()}` : ''}
                        {/* A change that came from a request was asked for by the person and approved by someone else: say which is which. */}
                        {entry.requestId ? ` · approved by ${entry.byName}` : ` · ${entry.byName}`}
                        {entry.reason ? ` · ${entry.requestId ? 'reason given' : 'reason'}: “${entry.reason}”` : ''}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </div>
      )}
    </Modal>

      {data && dialog === 'ask' && canAsk && (
        <CorrectionDialog
          date={date}
          detail={data}
          onClose={() => setDialog(null)}
          onSent={() => {
            toast('Your request is sent. You will see here when it is decided.');
            changed();
          }}
        />
      )}
      {data && dialog === 'correct' && (
        <DirectCorrectionDialog
          employeeId={employeeId}
          date={date}
          detail={data}
          onClose={() => setDialog(null)}
          onDone={() => {
            toast('The day is corrected.');
            changed();
          }}
          onStale={(message) => {
            toast(message, 'error');
            changed();
          }}
        />
      )}
      {data && dialog === 'note' && (
        <NoteDialog
          employeeId={employeeId}
          date={date}
          current={data.record?.note?.text ?? ''}
          onClose={() => setDialog(null)}
          onDone={() => {
            toast('The note is saved.');
            changed();
          }}
        />
      )}
      {dialog === 'cancel' && <Confirm title="Cancel this request?" body="It is taken back and nobody decides it. You can ask again afterwards." confirmLabel="Cancel the request" onConfirm={() => void cancelRequest()} onClose={() => setDialog(null)} />}
    </>
  );
}
