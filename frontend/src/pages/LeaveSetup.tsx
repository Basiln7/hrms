import { useState } from 'react';
import { Pencil, Plus, TreePalm, TriangleAlert, Users } from 'lucide-react';
import { approverInWords, daysInWords, LEAVE_TONE_COLOR, type AssignmentResult, type LeavePolicyRow, type LeaveSetupPayload, type LeaveType, type PersonOption } from '@delta-hrms/shared';
import { AssignmentOutcome } from '../components/PeoplePicker';
import { LoadError, SkeletonLines } from '../components/states';
import { Badge, Confirm, Empty, TabPanel, Tabs, tone } from '../components/ui';
import { useToast } from '../context/ToastContext';
import { api, messageOf } from '../lib/api';
import { dayCount } from '../lib/format';
import { useLoad } from '../lib/useLoad';
import { PersonLeave } from './leave/PersonLeave';
import { AssignPolicyDialog, PolicyDialog, TypeDialog } from './leave/setupDialogs';
import { useMe } from '../context/AuthContext';

type Tab = 'policies' | 'types' | 'balances';

/** One policy: who approves, who is on it, and its rules for each kind of leave. */
function PolicyCard({ policy, types, onEdit, onAssign, onDefault, onDelete }: { policy: LeavePolicyRow; types: LeaveType[]; onEdit: () => void; onAssign: () => void; onDefault: () => void; onDelete: () => void }) {
  const typeOf = new Map(types.map((type) => [type.id, type]));
  return (
    <section className="card" aria-label={`Policy ${policy.name}`}>
      <div className="card-head">
        <div>
          <h2 className="card-title">{policy.name}</h2>
          <p className="card-sub">
            Approved by {approverInWords(policy.approver, 'their')} · {policy.peopleCount} {policy.peopleCount === 1 ? 'person' : 'people'} on it
          </p>
        </div>
        <div className="badges">{policy.isDefault && <Badge color="var(--green)">Given to new people</Badge>}</div>
      </div>
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              <th scope="col">Kind of leave</th>
              <th scope="col" className="cell-end">
                Days a year
              </th>
              <th scope="col">Carry forward</th>
              <th scope="col">Longest run</th>
              <th scope="col">Asking</th>
              <th scope="col">Eligible</th>
              <th scope="col">Below zero</th>
            </tr>
          </thead>
          <tbody>
            {policy.entries.map((entry) => {
              const type = typeOf.get(entry.leaveTypeId);
              return (
                <tr key={entry.leaveTypeId}>
                  <td>
                    <span className="leave-name" style={tone(LEAVE_TONE_COLOR[type?.tone ?? 'slate'])}>
                      <i aria-hidden="true" />
                      {type?.name ?? 'A kind that no longer exists'}
                    </span>
                    {type?.archived && <span className="cell-sub">Archived: no longer offered</span>}
                  </td>
                  <td className="cell-end num">
                    {type && !type.paid && entry.annualDays === 0 ? '—' : dayCount(entry.annualDays)}
                    {entry.annualDays > 0 && entry.prorateFirstYear && <span className="cell-sub">first year pro-rated</span>}
                  </td>
                  <td className={entry.carryForwardMax > 0 ? undefined : 'cell-none'}>{entry.carryForwardMax > 0 ? `Up to ${daysInWords(entry.carryForwardMax)}` : 'None'}</td>
                  <td className={entry.maxConsecutiveDays !== null ? undefined : 'cell-none'}>{entry.maxConsecutiveDays !== null ? daysInWords(entry.maxConsecutiveDays) : 'No limit'}</td>
                  <td>{entry.minNoticeDays > 0 ? `${entry.minNoticeDays} ${entry.minNoticeDays === 1 ? 'day' : 'days'} ahead` : entry.backdateDays > 0 ? `Up to ${entry.backdateDays} ${entry.backdateDays === 1 ? 'day' : 'days'} back` : 'From today on'}</td>
                  <td className={entry.eligibleAfterDays > 0 ? undefined : 'cell-none'}>{entry.eligibleAfterDays > 0 ? `After ${entry.eligibleAfterDays} days` : 'From day one'}</td>
                  <td className={entry.allowNegative || (type && !type.paid) ? undefined : 'cell-none'}>{type && !type.paid ? 'No balance needed' : entry.allowNegative ? 'Allowed' : 'No'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="form-actions">
        {policy.peopleCount === 0 && (
          <button type="button" className="btn ghost sm" onClick={onDelete}>
            Delete
          </button>
        )}
        {!policy.isDefault && (
          <button type="button" className="btn ghost sm" onClick={onDefault}>
            Give to new people
          </button>
        )}
        <button type="button" className="btn ghost sm" onClick={onEdit}>
          <Pencil size={15} aria-hidden="true" /> Change
        </button>
        <button type="button" className="btn sm" onClick={onAssign}>
          <Users size={15} aria-hidden="true" /> Put people on it
        </button>
      </div>
    </section>
  );
}

/** One person's leave, chosen from everyone: for looking at a balance and adjusting it. */
function BalancesTab() {
  const { employee: me } = useMe();
  const people = useLoad<PersonOption[]>('/employees/picker');
  const [employeeId, setEmployeeId] = useState('');

  if (people.error) return <LoadError message={people.error} onRetry={people.reload} />;
  if (!people.data) return <SkeletonLines lines={4} />;
  return (
    <>
      <div className="toolbar">
        <select className="select" aria-label="Person" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
          <option value="">Choose a person…</option>
          {people.data.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name} · {person.code}
            </option>
          ))}
        </select>
      </div>
      {employeeId ? (
        <PersonLeave key={employeeId} employeeId={employeeId} mine={employeeId === me.id} />
      ) : (
        <Empty icon={<TreePalm size={30} />} title="Choose a person" body="Their balances, their requests and everything added to their account are shown here. A balance is corrected with an adjustment, which carries your reason." />
      )}
    </>
  );
}

/**
 * Leave setup, for HR and Admin: the kinds of leave, the policies and who is on them, and
 * each person's balances. The API checks the permission again on every call.
 */
export default function LeaveSetup() {
  const toast = useToast();
  const setup = useLoad<LeaveSetupPayload>('/leave-policies');
  const [tab, setTab] = useState<Tab>('policies');
  const [typeDialog, setTypeDialog] = useState<{ type?: LeaveType } | null>(null);
  const [policyDialog, setPolicyDialog] = useState<{ policy?: LeavePolicyRow } | null>(null);
  const [assigning, setAssigning] = useState<LeavePolicyRow | null>(null);
  const [outcome, setOutcome] = useState<{ policy: LeavePolicyRow; result: AssignmentResult } | null>(null);
  const [deleting, setDeleting] = useState<LeavePolicyRow | null>(null);
  const [archiving, setArchiving] = useState<LeaveType | null>(null);

  const act = async (run: () => Promise<unknown>, done: string) => {
    try {
      await run();
      toast(done);
    } catch (failure) {
      toast(messageOf(failure), 'error');
    }
    setup.reload();
  };
  const setArchived = (type: LeaveType, archived: boolean) =>
    act(() => api.patch(`/leave-types/${type.id}`, { name: type.name, code: type.code, paid: type.paid, allowHalfDay: type.allowHalfDay, tone: type.tone, archived }), archived ? `${type.name} is archived. Leave already booked under it stays as it is.` : `${type.name} is offered again.`);

  const data = setup.data;
  const activeTypes = data?.types.filter((type) => !type.archived) ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Leave setup</h1>
          <p>Kinds of leave, the policies that say how much of each a person gets, and who is on which policy.{data ? ` The leave year is ${data.yearLabel}.` : ''}</p>
        </div>
        <div className="head-actions">
          {tab === 'types' && (
            <button type="button" className="btn" onClick={() => setTypeDialog({})}>
              <Plus size={17} aria-hidden="true" /> Add a kind of leave
            </button>
          )}
          {tab === 'policies' && data && activeTypes.length > 0 && (
            <button type="button" className="btn" onClick={() => setPolicyDialog({})}>
              <Plus size={17} aria-hidden="true" /> Add a policy
            </button>
          )}
        </div>
      </div>

      <Tabs
        name="leave-setup"
        label="Leave setup"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'policies', label: 'Policies', count: data?.policies.length },
          { id: 'types', label: 'Kinds of leave', count: activeTypes.length || undefined },
          { id: 'balances', label: 'Balances' },
        ]}
      />

      <TabPanel name="leave-setup" tab={tab}>
      {setup.error && !data ? (
        <section className="card">
          <LoadError message={setup.error} onRetry={setup.reload} />
        </section>
      ) : !data ? (
        <section className="card">
          <SkeletonLines lines={6} />
        </section>
      ) : tab === 'policies' ? (
        <div className="stack">
          {data.withoutPolicy > 0 && data.policies.length > 0 && (
            <p className="note warn" style={{ marginTop: 0 }}>
              <TriangleAlert size={16} aria-hidden="true" />
              <span>
                {data.withoutPolicy} {data.withoutPolicy === 1 ? 'person is' : 'people are'} on no leave policy: nothing is granted to them and they cannot ask for leave. Use “Put people on it” on a policy.
              </span>
            </p>
          )}
          {data.policies.length === 0 ? (
            <section className="card">
              <Empty
                icon={<TreePalm size={30} />}
                title="No leave policy yet"
                body={activeTypes.length === 0 ? 'Start with the kinds of leave (casual, sick, earned, unpaid). A policy then says how many days of each a person gets.' : 'A policy says how many days of each kind a person gets a year, and the rules for asking. The first one is given to people as they are added.'}
                action={
                  activeTypes.length === 0 ? (
                    <button type="button" className="btn" onClick={() => setTab('types')}>
                      Go to kinds of leave
                    </button>
                  ) : (
                    <button type="button" className="btn" onClick={() => setPolicyDialog({})}>
                      <Plus size={17} aria-hidden="true" /> Add a policy
                    </button>
                  )
                }
              />
            </section>
          ) : (
            data.policies.map((policy) => (
              <PolicyCard
                key={policy.id}
                policy={policy}
                types={data.types}
                onEdit={() => setPolicyDialog({ policy })}
                onAssign={() => setAssigning(policy)}
                onDefault={() => void act(() => api.post(`/leave-policies/${policy.id}/default`), `New people are now put on “${policy.name}”. Nobody already here was changed.`)}
                onDelete={() => setDeleting(policy)}
              />
            ))
          )}
        </div>
      ) : tab === 'types' ? (
        <section className="card">
          {data.types.length === 0 ? (
            <Empty
              icon={<TreePalm size={30} />}
              title="No kind of leave yet"
              body="Add the kinds your company gives: casual, sick, earned, unpaid. Each gets a short code and a colour."
              action={
                <button type="button" className="btn" onClick={() => setTypeDialog({})}>
                  <Plus size={17} aria-hidden="true" /> Add a kind of leave
                </button>
              }
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Kind of leave</th>
                    <th scope="col">Code</th>
                    <th scope="col">Paid</th>
                    <th scope="col">Half-days</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="cell-end">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.types.map((type) => (
                    <tr key={type.id}>
                      <td>
                        <span className="leave-name" style={tone(LEAVE_TONE_COLOR[type.tone])}>
                          <i aria-hidden="true" />
                          {type.name}
                        </span>
                      </td>
                      <td>{type.code}</td>
                      <td>{type.paid ? 'Paid' : 'Unpaid'}</td>
                      <td>{type.allowHalfDay ? 'Allowed' : 'Whole days only'}</td>
                      <td>
                        <Badge color={type.archived ? 'var(--text-3)' : 'var(--green)'} dot>
                          {type.archived ? 'Archived' : 'Offered'}
                        </Badge>
                      </td>
                      <td className="cell-end">
                        <span className="actions">
                          <button type="button" className="btn ghost sm" onClick={() => setTypeDialog({ type })}>
                            Change
                          </button>
                          <button type="button" className="btn ghost sm" onClick={() => (type.archived ? void setArchived(type, false) : setArchiving(type))}>
                            {type.archived ? 'Restore' : 'Archive'}
                          </button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : (
        <section className="card">
          <BalancesTab />
        </section>
      )}
      </TabPanel>

      {typeDialog && (
        <TypeDialog
          type={typeDialog.type}
          onClose={() => setTypeDialog(null)}
          onSaved={(saved) => {
            toast(typeDialog.type ? `${saved.name} is saved.` : `${saved.name} is added. Include it in a policy to grant it.`);
            setup.reload();
          }}
        />
      )}
      {policyDialog && data && (
        <PolicyDialog
          policy={policyDialog.policy}
          types={data.types}
          onClose={() => setPolicyDialog(null)}
          onSaved={(saved) => {
            toast(policyDialog.policy ? `“${saved.name}” is saved.` : `“${saved.name}” is added. Put people on it to grant them its leave.`);
            setup.reload();
          }}
        />
      )}
      {assigning && (
        <AssignPolicyDialog
          policy={assigning}
          onClose={() => setAssigning(null)}
          onDone={(result) => {
            setOutcome({ policy: assigning, result });
            setup.reload();
          }}
        />
      )}
      {outcome && <AssignmentOutcome what={`the policy “${outcome.policy.name}”`} result={outcome.result} onClose={() => setOutcome(null)} />}
      {deleting && <Confirm title={`Delete “${deleting.name}”?`} body="Nobody is on this policy, so nothing else changes." onConfirm={() => void act(() => api.delete(`/leave-policies/${deleting.id}`), `“${deleting.name}” is deleted.`)} onClose={() => setDeleting(null)} />}
      {archiving && (
        <Confirm
          title={`Archive ${archiving.name}?`}
          body="It can no longer be asked for, and no new allowance is granted for it. Leave already booked or taken under it stays as it is. It can be restored."
          confirmLabel="Archive"
          onConfirm={() => void setArchived(archiving, true)}
          onClose={() => setArchiving(null)}
        />
      )}
    </>
  );
}
