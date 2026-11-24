import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarCheck, CalendarClock, KeyRound, Pencil, TreePalm, UserCheck, UserX } from 'lucide-react';
import { accountBlocker, EMPLOYEE_STATUS, ROLE_INFO, startingRules, type EmployeeRow, type EmployeeSchedulePayload, type ScheduleAssignment, type TemporaryPasswordPayload } from '@delta-hrms/shared';
import { AssignDialog } from '../components/AssignDialog';
import { RulesSummary } from '../components/RulesEditor';
import { LoadError, SkeletonLines, TemporaryPasswordDialog } from '../components/states';
import { Avatar, Badge, Confirm, Empty } from '../components/ui';
import { useAuth, useMe } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { api, messageOf } from '../lib/api';
import { dayDate, shortDate } from '../lib/format';
import { useLoad } from '../lib/useLoad';
import { ChangeCalendarDialog } from './people/ChangeCalendarDialog';
import { ResetPasswordDialog, StatusDialog } from './people/dialogs';
import { EmployeeForm } from './people/EmployeeForm';
import { PersonLeave } from './leave/PersonLeave';

function Fact({ label, value, none = 'Not set' }: { label: string; value: string | null | undefined; none?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      {value ? <dd>{value}</dd> : <dd className="none">{none}</dd>}
    </div>
  );
}

const assignmentKind = (a: ScheduleAssignment) => (a.scheduleId ? a.rules.name : `${a.rules.name} (for them only)`);

/** One person: who they are, and the schedule they work under, with its history. */
export default function EmployeeDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const { employee: me, company } = useMe();
  const toast = useToast();
  const fromTeam = (useLocation().state as { from?: string } | null)?.from === 'team';
  const person = useLoad<EmployeeRow>(`/employees/${id}`);
  const schedule = useLoad<EmployeeSchedulePayload>(`/employees/${id}/schedule`);

  const [dialog, setDialog] = useState<'edit' | 'status' | 'reset' | 'assign' | 'calendar' | null>(null);
  const [cancelling, setCancelling] = useState<ScheduleAssignment | null>(null);
  const [newPassword, setNewPassword] = useState<TemporaryPasswordPayload | null>(null);

  const back = (
    <Link className="back" to={fromTeam ? '/team' : can('employees.viewAll') ? '/employees' : '/'}>
      <ArrowLeft size={16} /> {fromTeam ? 'My team' : can('employees.viewAll') ? 'Employees' : 'Home'}
    </Link>
  );

  if (person.error) {
    return (
      <>
        {back}
        <section className="card">
          <LoadError message={person.error} onRetry={person.reload} />
        </section>
      </>
    );
  }
  const e = person.data;
  if (!e) {
    return (
      <>
        {back}
        <section className="card">
          <SkeletonLines lines={5} />
        </section>
      </>
    );
  }

  // The same rules the server applies, used here only to decide which buttons to offer.
  const mine = e.id === me.id;
  const mayChangeAccount = can('employees.manage') && accountBlocker(me, e) === null && !mine;
  // Your own schedule is someone else's to change. An Admin may be the only one who can (no HR, no other
  // Admin), which this page cannot know: it offers the button, and the server allows it or says why not.
  const mayChangeSchedule = can('schedules.manage') && e.status !== 'inactive' && (!mine || me.role === 'Admin');
  const mayChangeCalendar = can('holidays.manage') && e.status !== 'inactive' && (!mine || me.role === 'Admin');
  const status = EMPLOYEE_STATUS[e.status];
  const s = schedule.data;
  /** The holiday calendar an assignment names, in words. */
  const calendarOf = (a: ScheduleAssignment) => (a.holidayCalendarId ? (s?.calendarNames[a.holidayCalendarId] ?? 'A calendar that no longer exists') : 'No holiday calendar');
  const reload = () => {
    person.reload();
    schedule.reload();
  };

  const cancelPlanned = async (assignment: ScheduleAssignment) => {
    try {
      await api.delete(`/schedule-assignments/${assignment.id}`);
      toast('The planned schedule is cancelled.');
    } catch (failure) {
      toast(messageOf(failure), 'error');
    }
    reload();
  };

  return (
    <>
      {back}

      <section className="card" style={{ marginBottom: 18 }} aria-label="Person">
        <div className="profile-head">
          <div className="person">
            <Avatar name={e.name} size={56} />
            <div className="person-main">
              <h1>{e.name}</h1>
              <span>{[e.code, e.designation].filter(Boolean).join(' · ')}</span>
            </div>
          </div>
          <div className="badges">
            <Badge color={ROLE_INFO[e.role].tone}>{e.role}</Badge>
            <Badge color={status.tone} dot>
              {status.label}
            </Badge>
          </div>
        </div>
        <div className="actions" style={{ marginTop: 16 }}>
          {/* Anyone who may see this page may see the person's month: the server applies the same rule to both. */}
          <Link className="btn ghost sm" to={mine ? '/attendance' : `/employees/${e.id}/attendance`}>
            <CalendarCheck size={15} /> Attendance calendar
          </Link>
          {mayChangeAccount && (
            <>
              <button type="button" className="btn ghost sm" onClick={() => setDialog('edit')}>
                <Pencil size={15} /> Change details
              </button>
              {e.status !== 'inactive' && (
                <button type="button" className="btn ghost sm" onClick={() => setDialog('reset')}>
                  <KeyRound size={15} /> Reset password
                </button>
              )}
              <button type="button" className="btn ghost sm" onClick={() => setDialog('status')}>
                {e.status === 'inactive' ? <UserCheck size={15} /> : <UserX size={15} />} {e.status === 'inactive' ? 'Reactivate' : 'Deactivate'}
              </button>
            </>
          )}
        </div>
        {can('employees.manage') && mine && <p className="note" style={{ marginTop: 16 }}>This is your own record. Another HR or Admin makes changes to it.</p>}
        {can('employees.manage') && !mine && !mayChangeAccount && <p className="note" style={{ marginTop: 16 }}>Only an Admin can change an HR or Admin account.</p>}
      </section>

      <div className="grid">
        <section className="card col-5" aria-labelledby="person-details">
          <div className="card-head">
            <h2 className="card-title" id="person-details">
              Details
            </h2>
          </div>
          <dl className="facts">
            <Fact label="Email" value={e.email} />
            <Fact label="Phone" value={e.phone} none="Not added" />
            <Fact label="Department" value={e.departmentName} none="None" />
            <Fact label="Reports to" value={e.managerName} none="Nobody" />
            <Fact label="Joined the company" value={e.joinDate ? dayDate(e.joinDate) : null} none="Not recorded" />
            <Fact label="Last signed in" value={e.lastLoginAt ? shortDate(e.lastLoginAt, company.timeZone) : null} none="Never" />
          </dl>
          <h3 className="subhead">Attendance counts for</h3>
          {e.employment.length === 0 ? (
            <p className="muted">Nothing yet. It starts counting from their first schedule.</p>
          ) : (
            <ul className="plain-words">
              {e.employment.map((p) => (
                <li key={p.from}>
                  <CalendarClock size={16} aria-hidden="true" />
                  <span>
                    {dayDate(p.from)} {p.to ? `to ${dayDate(p.to)}` : 'onwards'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card col-7" aria-labelledby="person-schedule">
          <div className="card-head">
            <div>
              <h2 className="card-title" id="person-schedule">
                Work schedule
              </h2>
              <p className="card-sub">The rules their attendance is judged by. Theirs alone: changing a standard schedule does not change this.</p>
            </div>
            {mayChangeSchedule && s && (
              <button type="button" className="btn sm" onClick={() => setDialog('assign')}>
                {s.current || s.planned.length > 0 ? 'Change schedule' : 'Give a schedule'}
              </button>
            )}
          </div>

          {schedule.error ? (
            <LoadError message={schedule.error} onRetry={schedule.reload} />
          ) : !s ? (
            <SkeletonLines lines={6} />
          ) : (
            <>
              {s.current ? (
                <>
                  <div className="planned" style={{ marginTop: 0, marginBottom: 14 }}>
                    <div>
                      <b>{assignmentKind(s.current)}</b>
                      <span>In force since {dayDate(s.current.effectiveFrom)}</span>
                    </div>
                    <Badge color="var(--green)" dot>
                      Now
                    </Badge>
                  </div>
                  <RulesSummary rules={s.current.rules} />
                  <div className="planned">
                    <div>
                      <b>
                        <TreePalm size={15} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 6 }} />
                        {calendarOf(s.current)}
                      </b>
                      <span>{s.current.holidayCalendarId ? 'Their holidays come from this calendar.' : 'No day is a holiday for them until they are put on a calendar.'}</span>
                    </div>
                    {mayChangeCalendar && (
                      <button type="button" className="btn ghost sm" onClick={() => setDialog('calendar')}>
                        Change calendar
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <Empty
                  icon={<CalendarClock size={30} />}
                  title={e.status === 'inactive' ? 'No schedule in force' : s.planned.length > 0 ? 'Their schedule has not started yet' : 'No schedule yet'}
                  body={e.status === 'inactive' ? 'They are deactivated, and never started on a schedule. Nothing is counted for them.' : s.planned.length > 0 ? 'Until it starts they cannot check in, and nothing is counted.' : 'Without one they cannot check in, and no attendance is counted.'}
                />
              )}

              {s.planned.map((p) => (
                <div className="planned" key={p.id}>
                  <div>
                    <b>{assignmentKind(p)}</b>
                    <span>
                      Starts {dayDate(p.effectiveFrom)} · {calendarOf(p)}
                      {p.note ? ` · ${p.note}` : ''}
                    </span>
                  </div>
                  {mayChangeSchedule ? (
                    <button type="button" className="btn ghost sm" onClick={() => setCancelling(p)}>
                      Cancel
                    </button>
                  ) : (
                    <Badge color="var(--blue)">Planned</Badge>
                  )}
                </div>
              ))}

              {s.history.length > 0 && (
                <>
                  <h3 className="subhead">History</h3>
                  <div className="table-wrap">
                    <table className="table compact">
                      <thead>
                        <tr>
                          <th scope="col">From</th>
                          <th scope="col">Schedule</th>
                          <th scope="col">Holiday calendar</th>
                          <th scope="col">Given by</th>
                          <th scope="col">Note</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.history.map((h) => (
                          <tr key={h.id}>
                            <td className="nowrap">{dayDate(h.effectiveFrom)}</td>
                            <td>{assignmentKind(h)}</td>
                            <td className={h.holidayCalendarId ? undefined : 'cell-none'}>{h.holidayCalendarId ? calendarOf(h) : 'None'}</td>
                            <td>
                              {h.createdByName}
                              <span className="cell-none"> · {shortDate(h.createdAt, company.timeZone)}</span>
                            </td>
                            <td className={h.note ? undefined : 'cell-none'}>{h.note || 'None'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </section>

        <section className="card col-12" aria-labelledby="person-leave">
          <div className="card-head">
            <div>
              <h2 className="card-title" id="person-leave">
                Leave
              </h2>
              <p className="card-sub">Their leave policy, what is left of each kind, and what became of every request.</p>
            </div>
          </div>
          <PersonLeave employeeId={e.id} mine={mine} />
        </section>
      </div>

      {dialog === 'edit' && (
        <EmployeeForm
          employee={e}
          onClose={() => setDialog(null)}
          onSaved={() => {
            toast('The changes are saved.');
            reload();
          }}
        />
      )}
      {dialog === 'status' && s && (
        <StatusDialog
          employee={e}
          today={s.today}
          onClose={() => setDialog(null)}
          onDone={() => {
            toast(e.status === 'inactive' ? `${e.name} is reactivated.` : `${e.name} is deactivated.`);
            reload();
          }}
        />
      )}
      {dialog === 'reset' && <ResetPasswordDialog employee={e} onClose={() => setDialog(null)} onReset={setNewPassword} />}
      {dialog === 'assign' && s && (
        <AssignDialog
          target={{ kind: 'person', id: e.id, name: e.name, hasSchedule: s.current !== null, today: s.today, seedRules: s.current?.rules ?? { ...startingRules(company.timeZone), name: `${e.name}’s schedule` } }}
          onClose={() => setDialog(null)}
          onDone={() => {
            toast('The schedule is saved.');
            reload();
          }}
        />
      )}
      {dialog === 'calendar' && s?.current && (
        <ChangeCalendarDialog
          employee={e}
          today={s.today}
          currentId={s.current.holidayCalendarId}
          onClose={() => setDialog(null)}
          onDone={() => {
            toast('The holiday calendar is saved.');
            reload();
          }}
        />
      )}
      {cancelling && (
        <Confirm
          title="Cancel this planned schedule?"
          body={`${assignmentKind(cancelling)} was going to start on ${dayDate(cancelling.effectiveFrom)}. ${e.name} stays on what they have now.`}
          confirmLabel="Cancel the plan"
          onConfirm={() => void cancelPlanned(cancelling)}
          onClose={() => setCancelling(null)}
        />
      )}
      {newPassword && <TemporaryPasswordDialog title="New temporary password" name={newPassword.employee.name} email={newPassword.employee.email} password={newPassword.temporaryPassword} onClose={() => setNewPassword(null)} />}
    </>
  );
}
