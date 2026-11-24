import { describe, expect, it } from 'vitest';
import type { OrgNode } from './org';
import { accountBlocker, closeEmployment, employmentAfterAssignments, grantableRoles, isEmployedOn, managerBlocker, openPeriod, reactivatedStatus, reopenEmployment, roleBlocker } from './people';
import type { Role } from './roles';

const person = (id: string, role: Role, managerId: string | null = null, status: OrgNode['status'] = 'active'): OrgNode => ({ id, role, managerId, status });

const admin = person('admin', 'Admin');
const admin2 = person('admin2', 'Admin');
const hr = person('hr', 'HR');
const hr2 = person('hr2', 'HR');
const head = person('head', 'Manager');
const lead = person('lead', 'Manager', 'head');
const asha = person('asha', 'Employee', 'lead');
const solo = person('solo', 'Manager');
const gone = person('gone', 'Manager', null, 'inactive');
const company = [admin, admin2, hr, hr2, head, lead, asha, solo, gone];

describe('who may give which role', () => {
  it('lets an Admin give any role, HR the two ordinary ones, and nobody else any', () => {
    expect(grantableRoles('Admin')).toEqual(['Employee', 'Manager', 'HR', 'Admin']);
    expect(grantableRoles('HR')).toEqual(['Employee', 'Manager']);
    expect(grantableRoles('Manager')).toEqual([]);
    expect(grantableRoles('Employee')).toEqual([]);
  });

  it('never lets anyone change their own role', () => {
    expect(roleBlocker(admin, admin, 'HR', company)).toBe('You cannot change your own role.');
    expect(roleBlocker(hr, hr, 'Admin', company)).toBe('You cannot change your own role.');
    // Saving a form that leaves the role as it is changes nothing and is fine.
    expect(roleBlocker(hr, hr, 'HR', company)).toBeNull();
  });

  it('stops HR handing out, or taking away, the HR and Admin roles', () => {
    expect(roleBlocker(hr, asha, 'HR', company)).toBe('Only an Admin can give the HR and Admin roles.');
    expect(roleBlocker(hr, asha, 'Admin', company)).toBe('Only an Admin can give the HR and Admin roles.');
    expect(roleBlocker(hr, hr2, 'Employee', company)).toBe('Only an Admin can change an HR or Admin account.');
    expect(roleBlocker(hr, admin, 'Employee', company)).toBe('Only an Admin can change an HR or Admin account.');
  });

  it('lets HR move people between Employee and Manager', () => {
    expect(roleBlocker(hr, asha, 'Manager', company)).toBeNull();
    expect(roleBlocker(hr, solo, 'Employee', company)).toBeNull();
  });

  it('lets an Admin give and take any role from someone else', () => {
    expect(roleBlocker(admin, asha, 'Admin', company)).toBeNull();
    expect(roleBlocker(admin, hr, 'Employee', company)).toBeNull();
    expect(roleBlocker(admin, admin2, 'HR', company)).toBeNull();
  });

  it('keeps a manager a manager while people still report to them', () => {
    expect(roleBlocker(hr, lead, 'Employee', company)).toMatch(/Move those people/);
    expect(roleBlocker(admin, head, 'Employee', company)).toMatch(/Move those people/);
    // Another managing role is fine: they can still be a manager.
    expect(roleBlocker(admin, head, 'HR', company)).toBeNull();
  });

  it('gives Managers and Employees no say over anyone’s role or account', () => {
    expect(roleBlocker(head, asha, 'Manager', company)).toBe('Your role cannot manage employees.');
    expect(accountBlocker(head, asha)).toBe('Your role cannot manage employees.');
    expect(accountBlocker(asha, asha)).toBe('Your role cannot manage employees.');
  });

  it('lets HR change ordinary accounts, and only an Admin change HR and Admin ones', () => {
    expect(accountBlocker(hr, asha)).toBeNull();
    expect(accountBlocker(hr, head)).toBeNull();
    expect(accountBlocker(hr, hr2)).toBe('Only an Admin can change an HR or Admin account.');
    expect(accountBlocker(hr, admin)).toBe('Only an Admin can change an HR or Admin account.');
    expect(accountBlocker(admin, hr)).toBeNull();
    expect(accountBlocker(admin, admin2)).toBeNull();
  });
});

describe('who may be whose manager', () => {
  it('accepts a Manager, HR or Admin who is not deactivated', () => {
    expect(managerBlocker(company, 'asha', 'head')).toBeNull();
    expect(managerBlocker(company, 'asha', 'hr')).toBeNull();
    expect(managerBlocker(company, 'asha', 'admin')).toBeNull();
    expect(managerBlocker(company, null, 'lead')).toBeNull();
  });

  it('refuses someone who does not exist, is deactivated, or is an Employee', () => {
    expect(managerBlocker(company, 'asha', 'ghost')).toBe('That manager does not exist.');
    expect(managerBlocker(company, 'asha', 'gone')).toMatch(/deactivated/);
    expect(managerBlocker([...company, person('binu', 'Employee')], 'asha', 'binu')).toMatch(/Only a Manager, HR or Admin/);
  });

  it('refuses a loop', () => {
    expect(managerBlocker(company, 'head', 'head')).toBe('Nobody can be their own manager.');
    expect(managerBlocker(company, 'head', 'lead')).toBe('That would put them above their own manager.');
    expect(managerBlocker(company, 'lead', 'solo')).toBeNull();
  });
});

describe('when attendance counts for a person', () => {
  const today = '2026-11-23';
  const running = [{ from: '2026-06-01', to: null }];
  const twice = [
    { from: '2024-01-10', to: '2025-03-31' },
    { from: '2026-06-01', to: null },
  ];

  it('is inside their periods and nowhere else', () => {
    expect(isEmployedOn(twice, '2024-01-09')).toBe(false);
    expect(isEmployedOn(twice, '2024-01-10')).toBe(true);
    expect(isEmployedOn(twice, '2025-03-31')).toBe(true);
    expect(isEmployedOn(twice, '2025-04-01')).toBe(false);
    expect(isEmployedOn(twice, '2026-05-31')).toBe(false);
    expect(isEmployedOn(twice, '2026-06-01')).toBe(true);
    expect(isEmployedOn(twice, '2031-01-01')).toBe(true);
    expect(isEmployedOn([], today)).toBe(false);
    expect(openPeriod(twice)).toEqual({ from: '2026-06-01', to: null });
    expect(openPeriod([twice[0]!])).toBeNull();
  });

  it('closes on the last working day when someone is deactivated', () => {
    expect(closeEmployment(running, '2026-11-20', today)).toEqual({ employment: [{ from: '2026-06-01', to: '2026-11-20' }] });
    expect(closeEmployment(running, today, today)).toEqual({ employment: [{ from: '2026-06-01', to: today }] });
    expect(closeEmployment(twice, '2026-11-20', today)).toEqual({ employment: [twice[0], { from: '2026-06-01', to: '2026-11-20' }] });
  });

  it('will not take a last working day in the future, or inside an earlier period', () => {
    expect(closeEmployment(running, '2026-11-24', today)).toHaveProperty('error');
    expect(closeEmployment(running, 'soon', today)).toHaveProperty('error');
    expect(closeEmployment(twice, '2025-03-31', today)).toHaveProperty('error');
  });

  it('leaves no days behind for someone who goes before their first day', () => {
    const notYet = [{ from: '2026-12-01', to: null }];
    expect(closeEmployment(notYet, today, today)).toEqual({ employment: [] });
    expect(closeEmployment([twice[0]!, { from: '2026-12-01', to: null }], today, today)).toEqual({ employment: [twice[0]] });
  });

  it('has nothing to close for someone who never had a schedule, or has already left', () => {
    expect(closeEmployment([], today, today)).toEqual({ employment: [] });
    expect(closeEmployment([twice[0]!], today, today)).toEqual({ employment: [twice[0]] });
  });

  it('opens a new period when someone comes back, from today at the earliest', () => {
    const left = [{ from: '2024-01-10', to: '2025-03-31' }];
    expect(reopenEmployment(left, today, today, true)).toEqual({ employment: [left[0], { from: today, to: null }] });
    expect(reopenEmployment(left, '2026-12-01', today, true)).toEqual({ employment: [left[0], { from: '2026-12-01', to: null }] });
    expect(reopenEmployment(left, '2026-11-22', today, true)).toHaveProperty('error');
    expect(reopenEmployment(left, '2028-01-01', today, true)).toHaveProperty('error');
    // The days in between stay outside every period: not applicable, never absent.
    const back = reopenEmployment(left, today, today, true) as { employment: typeof left };
    expect(isEmployedOn(back.employment, '2026-01-15')).toBe(false);
  });

  it('opens nothing for someone who never had a schedule, or whose period is still running', () => {
    expect(reopenEmployment([], today, today, false)).toEqual({ employment: [] });
    expect(reopenEmployment(running, today, today, true)).toEqual({ employment: running });
    // Removed before their first day, then brought back: they have a schedule, so a period opens.
    expect(reopenEmployment([], today, today, true)).toEqual({ employment: [{ from: today, to: null }] });
  });

  it('opens a first period with the first assignment, and follows it until it begins', () => {
    expect(employmentAfterAssignments([], [], today)).toEqual([]);
    expect(employmentAfterAssignments([], ['2026-12-01'], today)).toEqual([{ from: '2026-12-01', to: null }]);
    expect(employmentAfterAssignments([], ['2026-12-10', '2026-12-01'], today)).toEqual([{ from: '2026-12-01', to: null }]);
    // The planned start is brought forward, pushed back, or cancelled before it arrives.
    const planned = [{ from: '2026-12-01', to: null }];
    expect(employmentAfterAssignments(planned, ['2026-12-01', today], today)).toEqual([{ from: today, to: null }]);
    expect(employmentAfterAssignments(planned, ['2026-12-10'], today)).toEqual([{ from: '2026-12-10', to: null }]);
    expect(employmentAfterAssignments(planned, [], today)).toEqual([]);
  });

  it('never moves a period that has begun, and never opens one in the past', () => {
    expect(employmentAfterAssignments(running, ['2026-06-01', '2026-12-01'], today)).toEqual(running);
    expect(employmentAfterAssignments(running, [], today)).toEqual(running);
    expect(employmentAfterAssignments(twice, ['2027-01-01'], today)).toEqual(twice);
    expect(employmentAfterAssignments([{ from: today, to: null }], ['2026-12-01'], today)).toEqual([{ from: today, to: null }]);
    expect(employmentAfterAssignments([], ['2026-01-01'], today)).toEqual([{ from: today, to: null }]);
  });

  it('brings someone back as Invited if they have never signed in', () => {
    expect(reactivatedStatus({})).toBe('invited');
    expect(reactivatedStatus({ lastLoginAt: '2026-11-01T04:00:00.000Z' })).toBe('active');
  });
});
