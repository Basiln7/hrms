import { can } from '@delta-hrms/shared';
import type { Account } from '../db';
import { loadOrg } from './access';
import { approvalsWaitingFor } from './corrections';
import { leaveWaitingFor } from './leave';

/** How many requests, corrections and leave together, are waiting for this person to decide. 0 for someone who decides none. */
export async function approvalsWaiting(employee: Pick<Account, 'id' | 'role'>): Promise<number> {
  if (!can(employee.role, 'team.approve') && !can(employee.role, 'requests.approveAll')) return 0;
  const [corrections, leave] = await Promise.all([approvalsWaitingFor(employee), loadOrg().then((org) => leaveWaitingFor(employee, org))]);
  return corrections + leave;
}
