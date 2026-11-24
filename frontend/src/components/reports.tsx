import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Download } from 'lucide-react';
import { formatMinutes, type DayResult, type DepartmentRow, type ReportPerson } from '@delta-hrms/shared';
import { useToast } from '../context/ToastContext';
import { download, messageOf } from '../lib/api';
import { useLoad } from '../lib/useLoad';
import { FlagBadges, StatusBadge, timesOf } from './attendance';
import { Avatar } from './ui';

/*
 * What the overview, the records and the reports share: the filters that narrow them to a
 * department, a manager's team or one person, a button that downloads a file, and a person
 * and their day as table cells. Who a caller may see at all is the server's decision; these
 * only offer the choices the server sent.
 */

/** Downloads a file from the API. A refusal is shown as the API's own message. */
export function DownloadButton({ path, children, small }: { path: string; children: ReactNode; small?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await download(path);
    } catch (failure) {
      toast(messageOf(failure), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className={small ? 'btn ghost sm' : 'btn ghost'} disabled={busy} onClick={() => void run()}>
      <Download size={small ? 15 : 17} aria-hidden="true" /> {busy ? 'Preparing…' : children}
    </button>
  );
}

/** The people the caller's reports cover. Asked once per page. */
export const useReportPeople = () => useLoad<ReportPerson[]>('/reports/people');

export function DepartmentSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const departments = useLoad<DepartmentRow[]>('/departments');
  return (
    <select className="select" aria-label="Department" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Every department</option>
      {(departments.data ?? []).map((department) => (
        <option key={department.id} value={department.id}>
          {department.name}
        </option>
      ))}
    </select>
  );
}

/** Narrows to one manager's team: offered only when someone in view has people reporting to them. */
export function ManagerSelect({ people, value, onChange }: { people: ReportPerson[] | null; value: string; onChange: (id: string) => void }) {
  const managers = (people ?? []).filter((person) => person.hasReports);
  if (managers.length === 0) return null;
  return (
    <select className="select" aria-label="Manager" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Every manager’s team</option>
      {managers.map((manager) => (
        <option key={manager.id} value={manager.id}>
          {manager.name}’s team
        </option>
      ))}
    </select>
  );
}

export function PersonSelect({ people, value, onChange, none }: { people: ReportPerson[] | null; value: string; onChange: (id: string) => void; none: string }) {
  return (
    <select className="select" aria-label="Person" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{none}</option>
      {(people ?? []).map((person) => (
        <option key={person.id} value={person.id}>
          {person.name} · {person.code}
          {person.status === 'inactive' ? ' (deactivated)' : ''}
        </option>
      ))}
    </select>
  );
}

/** Who a row is about: their name, linked to their page, and their code. */
export function PersonCell({ person }: { person: Pick<ReportPerson, 'id' | 'name' | 'code'> }) {
  return (
    <div className="cell-person">
      <Avatar name={person.name} />
      <div>
        <Link to={`/employees/${person.id}`} onClick={(event) => event.stopPropagation()}>
          {person.name}
        </Link>
        <span>{person.code}</span>
      </div>
    </div>
  );
}

/** A day in three cells: how it reads, its times, the time worked. */
export function DayCells({ day, timeZone }: { day: DayResult; timeZone: string }) {
  return (
    <>
      <td>
        <span className="badges">
          <StatusBadge status={day.status} />
          {day.leave?.name && <span className="day-holiday">{day.leave.name}</span>}
          {day.holiday && <span className="day-holiday">{day.holiday.name}</span>}
          <FlagBadges day={day} />
        </span>
      </td>
      <td className={day.checkInAt ? 'nowrap' : 'cell-none'}>{timesOf(day, timeZone) ?? 'No punch'}</td>
      <td className={day.checkOutAt ? 'nowrap num' : 'cell-none'}>{day.checkOutAt ? formatMinutes(day.workedMinutes) : day.checkInAt ? 'Not yet' : ''}</td>
    </>
  );
}
