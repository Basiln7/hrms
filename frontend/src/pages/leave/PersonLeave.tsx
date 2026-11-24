import { useState } from 'react';
import { TreePalm } from 'lucide-react';
import { approverInWords, type AssignmentResult, type LeaveBalancesPayload, type LeaveSetupPayload, type PolicyAssignInput } from '@delta-hrms/shared';
import { FormField } from '../../components/FormField';
import { AdjustDialog, BalanceCards, EntriesTable, LeaveRequestList } from '../../components/leave';
import { LoadError, SkeletonLines } from '../../components/states';
import { Empty, Modal } from '../../components/ui';
import { useAuth, useMe } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { api, messageOf } from '../../lib/api';
import { dayDate } from '../../lib/format';
import { queryOf, useLoad } from '../../lib/useLoad';

const NONE = 'none';

/** Moves one person to another leave policy, or to none. */
export function ChangePolicyDialog({ employee, currentId, onClose, onDone }: { employee: { id: string; name: string }; currentId: string | null; onClose: () => void; onDone: () => void }) {
  const setup = useLoad<LeaveSetupPayload>('/leave-policies');
  const [policyId, setPolicyId] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setFailure(null);
    if (!policyId) {
      setError('Choose a policy.');
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      const input: PolicyAssignInput = { policyId: policyId === NONE ? null : policyId, employeeIds: [employee.id] };
      const answer = await api.post<AssignmentResult>('/leave-policies/assign', input);
      // For one person a refusal is simply the reason, shown here so it can be put right.
      if (answer.assigned.length === 0) setFailure(answer.skipped[0]?.reason ?? 'The policy could not be changed.');
      else {
        onDone();
        onClose();
      }
    } catch (failed) {
      setFailure(messageOf(failed));
    } finally {
      setBusy(false);
    }
  };

  const options = (setup.data?.policies ?? []).filter((policy) => policy.id !== currentId);

  return (
    <Modal
      title={`Leave policy for ${employee.name}`}
      onClose={onClose}
      width={480}
      onSubmit={() => void submit()}
      ownValidation
      footer={
        <>
          <button type="button" className="btn ghost on-surface" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy || !setup.data}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      {setup.error ? (
        <LoadError message={setup.error} onRetry={setup.reload} />
      ) : !setup.data ? (
        <SkeletonLines lines={3} />
      ) : (
        <>
          <FormField label="Leave policy" required error={error} hint={<span className="field-hint">What they were already granted stays. Kinds of leave they had no allowance for yet are granted now, under the new policy.</span>}>
            {({ id, describedBy, invalid }) => (
              <select id={id} className="select" value={policyId} onChange={(e) => setPolicyId(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid}>
                <option value="">Choose…</option>
                {options.map((policy) => (
                  <option key={policy.id} value={policy.id}>
                    {policy.name}
                    {policy.isDefault ? ' (default)' : ''}
                  </option>
                ))}
                {currentId && <option value={NONE}>No leave policy</option>}
              </select>
            )}
          </FormField>
          {options.length === 0 && <p className="note" style={{ marginTop: 14 }}>There is no other policy yet. Add one under Leave setup.</p>}
        </>
      )}
      {failure && (
        <div className="form-error" role="alert" style={{ marginTop: 14 }}>
          {failure}
        </div>
      )}
    </Modal>
  );
}

/**
 * One person's leave, for those who may see it: the policy they are on, what is left of each
 * kind, their requests, and everything that was added to the account. HR can adjust a balance
 * or move them to another policy from here, though never their own.
 */
export function PersonLeave({ employeeId, mine }: { employeeId: string; mine: boolean }) {
  const { can } = useAuth();
  const { employee: me, company } = useMe();
  const toast = useToast();
  const [year, setYear] = useState<number | undefined>();
  const account = useLoad<LeaveBalancesPayload>(`/leave/balances${queryOf({ employeeId, year })}`);
  const [dialog, setDialog] = useState<'adjust' | 'policy' | null>(null);
  const [listVersion, setListVersion] = useState(0);

  if (account.error && !account.data) return <LoadError message={account.error} onRetry={account.reload} />;
  const a = account.data;
  if (!a) return <SkeletonLines lines={5} />;

  // Your own policy is someone else's to change, unless you are the only one who could: the server decides.
  const mayChangePolicy = can('leave.configure') && (!mine || me.role === 'Admin');
  const changed = () => {
    account.reload();
    setListVersion((n) => n + 1);
  };

  return (
    <>
      <div className="planned" style={{ marginTop: 0, marginBottom: 16 }}>
        <div>
          <b>{a.policy ? a.policy.name : 'No leave policy'}</b>
          <span>{a.policy ? `Requests are approved by ${approverInWords(a.policy.approver, 'their')}.` : 'Without a policy no leave is granted and none can be asked for.'}</span>
        </div>
        <div className="actions">
          {a.years.length > 1 && (
            <select className="select" aria-label="Leave year" value={a.leaveYear} onChange={(e) => setYear(Number(e.target.value))}>
              {a.years.map((y) => (
                <option key={y.year} value={y.year}>
                  {y.label}
                  {y.year === a.currentYear ? ' (now)' : ''}
                </option>
              ))}
            </select>
          )}
          {a.canAdjust && a.rows.length > 0 && (
            <button type="button" className="btn ghost sm" onClick={() => setDialog('adjust')}>
              Adjust balance
            </button>
          )}
          {mayChangePolicy && (
            <button type="button" className="btn ghost sm" onClick={() => setDialog('policy')}>
              {a.policy ? 'Change policy' : 'Give a policy'}
            </button>
          )}
        </div>
      </div>

      {a.rows.length === 0 ? (
        <Empty icon={<TreePalm size={28} />} title={`No leave in ${a.yearLabel}`} body={a.policy ? 'Nothing has been granted for this leave year.' : 'They are on no leave policy, so nothing is granted.'} />
      ) : (
        <>
          <p className="card-sub" style={{ marginBottom: 10 }}>
            Leave year {a.yearLabel}: {dayDate(a.range.from)} to {dayDate(a.range.to)}
          </p>
          <BalanceCards rows={a.rows} />
        </>
      )}

      <h3 className="subhead">Requests</h3>
      <LeaveRequestList key={listVersion} query={`?view=person&employeeId=${employeeId}`} own={mine} timeZone={company.timeZone} onChanged={account.reload} empty={{ title: 'No leave asked for', body: 'Their requests appear here, whatever became of them.' }} />

      {a.entries.length > 0 && (
        <>
          <h3 className="subhead">The account for {a.yearLabel}</h3>
          <EntriesTable entries={a.entries} timeZone={company.timeZone} />
        </>
      )}

      {dialog === 'adjust' && (
        <AdjustDialog
          account={a}
          onClose={() => setDialog(null)}
          onDone={() => {
            toast('The balance is adjusted.');
            changed();
          }}
        />
      )}
      {dialog === 'policy' && (
        <ChangePolicyDialog
          employee={a.employee}
          currentId={a.policy?.id ?? null}
          onClose={() => setDialog(null)}
          onDone={() => {
            toast('The leave policy is saved.');
            changed();
          }}
        />
      )}
    </>
  );
}
