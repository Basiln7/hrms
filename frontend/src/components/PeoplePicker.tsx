import { useMemo, useState } from 'react';
import { CircleCheck, Search, TriangleAlert } from 'lucide-react';
import { touchedInWords, type AssignmentResult, type DepartmentRow, type PersonOption } from '@delta-hrms/shared';
import { useLoad } from '../lib/useLoad';
import { LoadError, SkeletonLines } from './states';
import { Modal } from './ui';

interface PickerProps {
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  /** The message when nobody was chosen. */
  error?: string;
  /** What to say under each name beside their department: the schedule they are on, their holiday calendar. */
  detail: (person: PersonOption) => string;
}

/**
 * Chooses people: one, several, or a whole department at once (pick the department, then
 * "Tick everyone shown"). Used wherever something is given to many people from a date.
 */
export function PeoplePicker({ selected, onChange, error, detail }: PickerProps) {
  const people = useLoad<PersonOption[]>('/employees/picker');
  const departments = useLoad<DepartmentRow[]>('/departments');
  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState('');

  const shown = useMemo(() => {
    const text = search.trim().toLowerCase();
    return (people.data ?? []).filter((p) => (!department || p.departmentId === department) && (!text || p.name.toLowerCase().includes(text) || p.code.toLowerCase().includes(text)));
  }, [people.data, search, department]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  if (people.error) return <LoadError message={people.error} onRetry={people.reload} />;
  if (people.loading) return <SkeletonLines lines={5} />;

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <span className="input-icon">
          <Search size={17} />
          <input className="input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or code" aria-label="Search people" />
        </span>
        <select className="select" value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="Department">
          <option value="">Every department</option>
          {(departments.data ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      <div className="picker-bar">
        <span>
          {selected.size} chosen · {shown.length} shown
        </span>
        <span className="actions">
          <button type="button" className="link" onClick={() => onChange(new Set([...selected, ...shown.map((p) => p.id)]))}>
            Tick everyone shown
          </button>
          <button type="button" className="link" onClick={() => onChange(new Set())}>
            Clear
          </button>
        </span>
      </div>
      <div className="picker" role="group" aria-label="People">
        {shown.length === 0 && <p className="picker-empty">Nobody matches.</p>}
        {shown.map((p) => (
          <label key={p.id}>
            <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
            <b>{p.name}</b>
            <span>{[p.departmentName, detail(p)].filter(Boolean).join(' · ')}</span>
          </label>
        ))}
      </div>
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** What happened to each person when something was given to many: who got it, and for everyone else why not. */
export function AssignmentOutcome({ what, result, onClose }: { what: string; result: AssignmentResult; onClose: () => void }) {
  const given = result.assigned.length;
  return (
    <Modal
      title={given === 0 ? `Nobody was given ${what}` : `Given to ${given} ${given === 1 ? 'person' : 'people'}`}
      onClose={onClose}
      width={520}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      }
    >
      <ul className="outcome">
        {given > 0 && (
          <li className="ok">
            <CircleCheck size={17} />
            <span>
              <b>{result.assigned.map((p) => p.name).join(', ')}</b>
            </span>
          </li>
        )}
        {result.skipped.map((p) => (
          <li className="skipped" key={p.employeeId}>
            <TriangleAlert size={17} />
            <span>
              <b>{p.name || 'Someone'}</b> was left as they are. {p.reason}
            </span>
          </li>
        ))}
        {touchedInWords(result.leave ?? []).map((line, index) => (
          <li className="skipped" key={`leave-${index}`}>
            {index === 0 ? <TriangleAlert size={17} /> : <span style={{ width: 17 }} />}
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
