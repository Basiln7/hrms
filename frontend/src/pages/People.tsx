import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Building2, ChevronRight, Search, UserPlus, UsersRound } from 'lucide-react';
import { EMPLOYEE_STATUS, ROLE_INFO, ROLES, type DepartmentRow, type EmployeeRow, type Page, type TemporaryPasswordPayload } from '@delta-hrms/shared';
import { FlagBadges, StatusBadge, timesOf } from '../components/attendance';
import { LoadError, SkeletonRows, TemporaryPasswordDialog } from '../components/states';
import { Avatar, Badge, Empty, Pager } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { queryOf, useLoad } from '../lib/useLoad';
import { DepartmentsDialog } from './people/dialogs';
import { EmployeeForm } from './people/EmployeeForm';

/** The team list has one column more: each person's day today. */
const COLUMNS = 6;
const TEAM_COLUMNS = 7;

/**
 * A list of people. As "Employees" it is everyone, for HR and Admin, with the tools to add and
 * organise them. As "My team" it is the people who report to the signed-in person, to look at.
 * Either way the server decides who is in it.
 */
export default function People({ team = false }: { team?: boolean }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const manage = !team && can('employees.manage');

  // The filters live in the address, so coming back from a person's page keeps them.
  const filters = { search: params.get('search') ?? '', departmentId: params.get('departmentId') ?? '', role: params.get('role') ?? '', status: params.get('status') ?? '', page: Number(params.get('page') ?? '1') || 1 };
  const setFilter = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    if (name !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };
  const filtered = Boolean(filters.search || filters.departmentId || filters.role || filters.status);

  // Typing does not ask the server on every letter.
  const [typed, setTyped] = useState(filters.search);
  useEffect(() => {
    if (typed === filters.search) return;
    const timer = window.setTimeout(() => setFilter('search', typed.trim()), 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);

  const list = useLoad<Page<EmployeeRow>>(`/employees${queryOf({ ...filters, page: filters.page > 1 ? filters.page : undefined, team: team ? '1' : undefined })}`);
  const departments = useLoad<DepartmentRow[]>('/departments');
  const [adding, setAdding] = useState(false);
  const [editingDepartments, setEditingDepartments] = useState(false);
  const [created, setCreated] = useState<TemporaryPasswordPayload | null>(null);

  const page = list.data;
  const pages = page ? Math.max(1, Math.ceil(page.total / page.pageSize)) : 1;
  const open = (id: string) => navigate(`/employees/${id}`, { state: { from: team ? 'team' : 'employees' } });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{team ? 'My team' : 'Employees'}</h1>
          <p>{team ? 'The people who report to you, directly or through their own reports.' : page ? `${page.total} ${page.total === 1 ? 'person' : 'people'}${filtered ? ' match' : ' in the company, counting anyone deactivated'}.` : 'Everyone in the company.'}</p>
        </div>
        {manage && (
          <div className="head-actions">
            <button type="button" className="btn ghost" onClick={() => setEditingDepartments(true)}>
              <Building2 size={17} /> Departments
            </button>
            <button type="button" className="btn" onClick={() => setAdding(true)}>
              <UserPlus size={17} /> Add employee
            </button>
          </div>
        )}
      </div>

      <section className="card" aria-label={team ? 'My team' : 'Employees'}>
        <div className="toolbar">
          <span className="input-icon">
            <Search size={17} />
            <input className="input" type="search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search name, email, code or designation" aria-label="Search people" />
          </span>
          <select className="select" value={filters.departmentId} onChange={(e) => setFilter('departmentId', e.target.value)} aria-label="Department">
            <option value="">Every department</option>
            {(departments.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
            <option value="none">No department</option>
          </select>
          <select className="select" value={filters.role} onChange={(e) => setFilter('role', e.target.value)} aria-label="Role">
            <option value="">Every role</option>
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
          <select className="select" value={filters.status} onChange={(e) => setFilter('status', e.target.value)} aria-label="Status">
            <option value="">Every status</option>
            <option value="active">Active</option>
            <option value="invited">Invited</option>
            <option value="inactive">Inactive</option>
          </select>
          {filtered && (
            <button
              type="button"
              className="link"
              onClick={() => {
                setTyped('');
                setParams(new URLSearchParams(), { replace: true });
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        {list.error ? (
          <LoadError message={list.error} onRetry={list.reload} />
        ) : page && page.items.length === 0 ? (
          filtered ? (
            <Empty icon={<Search size={30} />} title="Nobody matches" body="Try a different search, or clear the filters." />
          ) : team ? (
            <Empty icon={<UsersRound size={30} />} title="Nobody reports to you yet" body="When HR makes you someone’s manager, they appear here." />
          ) : (
            <Empty icon={<UsersRound size={30} />} title="No employees yet" body="Add the first person to get started." action={manage ? <button type="button" className="btn" onClick={() => setAdding(true)}>Add employee</button> : undefined} />
          )
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Department</th>
                  <th scope="col">Role</th>
                  <th scope="col">Reports to</th>
                  <th scope="col">Schedule</th>
                  {team && <th scope="col">Today</th>}
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody aria-busy={list.loading}>
                {!page ? (
                  <SkeletonRows columns={team ? TEAM_COLUMNS : COLUMNS} />
                ) : (
                  page.items.map((e) => (
                    <tr key={e.id} className="clickable" onClick={() => open(e.id)}>
                      <td>
                        <div className="cell-person">
                          <Avatar name={e.name} />
                          <div>
                            <Link to={`/employees/${e.id}`} state={{ from: team ? 'team' : 'employees' }} onClick={(event) => event.stopPropagation()}>
                              {e.name}
                            </Link>
                            <span>{[e.code, e.designation].filter(Boolean).join(' · ')}</span>
                          </div>
                        </div>
                      </td>
                      <td className={e.departmentName ? undefined : 'cell-none'}>{e.departmentName ?? 'None'}</td>
                      <td>
                        <Badge color={ROLE_INFO[e.role].tone}>{e.role}</Badge>
                      </td>
                      <td className={e.managerName ? undefined : 'cell-none'}>{e.managerName ?? 'Nobody'}</td>
                      <td>{e.scheduleName ?? (e.status === 'inactive' ? <span className="cell-none">None</span> : <Badge color="var(--orange)">No schedule</Badge>)}</td>
                      {team && (
                        <td>
                          {e.today ? (
                            <>
                              <span className="badges">
                                <StatusBadge status={e.today.day.status} />
                                <FlagBadges day={e.today.day} />
                              </span>
                              {e.today.day.checkInAt && <span className="cell-sub">{timesOf(e.today.day, e.today.timeZone)}</span>}
                            </>
                          ) : (
                            <span className="cell-none">Not known</span>
                          )}
                        </td>
                      )}
                      <td>
                        <span className="cell-person" style={{ justifyContent: 'space-between' }}>
                          <Badge color={EMPLOYEE_STATUS[e.status].tone} dot>
                            {EMPLOYEE_STATUS[e.status].label}
                          </Badge>
                          <ChevronRight size={16} className="cell-none" aria-hidden="true" />
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
        {page && <Pager page={page.page} pages={pages} total={page.total} pageSize={page.pageSize} onPage={(n) => setFilter('page', n > 1 ? String(n) : '')} noun="people" />}
      </section>

      {adding && (
        <EmployeeForm
          employee={null}
          onClose={() => setAdding(false)}
          onSaved={(result) => {
            list.reload();
            if (result) setCreated(result);
          }}
        />
      )}
      {editingDepartments && (
        <DepartmentsDialog
          onClose={() => setEditingDepartments(false)}
          onChanged={() => {
            departments.reload();
            list.reload();
          }}
        />
      )}
      {created && (
        <TemporaryPasswordDialog
          title={`${created.employee.name} is added`}
          name={created.employee.name}
          email={created.employee.email}
          password={created.temporaryPassword}
          onClose={() => {
            const id = created.employee.id;
            setCreated(null);
            open(id);
          }}
        />
      )}
    </>
  );
}
