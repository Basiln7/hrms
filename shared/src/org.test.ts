import { describe, expect, it } from 'vitest';
import { inScope, managerChain, ownRecordVerdict, reportsOf, scopeIds, scopeOf, wouldLoop, type OrgNode } from './org';
import type { Role } from './roles';

const person = (id: string, role: Role, managerId: string | null = null, status: OrgNode['status'] = 'active'): OrgNode => ({ id, role, managerId, status });

/*
 * admin
 * hr
 * head (Manager) ── lead (Manager) ── asha, binu
 *                └─ chitra
 * other (Manager) ── dev
 * loner
 */
const company: OrgNode[] = [
  person('admin', 'Admin'),
  person('hr', 'HR'),
  person('head', 'Manager'),
  person('lead', 'Manager', 'head'),
  person('asha', 'Employee', 'lead'),
  person('binu', 'Employee', 'lead'),
  person('chitra', 'Employee', 'head'),
  person('other', 'Manager'),
  person('dev', 'Employee', 'other'),
  person('loner', 'Employee'),
];

const sorted = (ids: string[]) => [...ids].sort();

describe('the manager chain', () => {
  it('lists the managers above a person, nearest first', () => {
    expect(managerChain(company, 'asha')).toEqual(['lead', 'head']);
    expect(managerChain(company, 'chitra')).toEqual(['head']);
    expect(managerChain(company, 'head')).toEqual([]);
    expect(managerChain(company, 'nobody')).toEqual([]);
  });

  it('stops at a manager who does not exist', () => {
    expect(managerChain([person('a', 'Employee', 'ghost')], 'a')).toEqual([]);
  });

  it('does not spin on a loop in the data', () => {
    const loop = [person('a', 'Manager', 'b'), person('b', 'Manager', 'c'), person('c', 'Manager', 'a')];
    expect(managerChain(loop, 'a')).toEqual(['b', 'c']);
    expect(sorted(reportsOf(loop, 'a'))).toEqual(['b', 'c']);
  });

  it('finds everyone who reports to a person, at any depth, and never the person', () => {
    expect(sorted(reportsOf(company, 'head'))).toEqual(['asha', 'binu', 'chitra', 'lead']);
    expect(sorted(reportsOf(company, 'lead'))).toEqual(['asha', 'binu']);
    expect(reportsOf(company, 'asha')).toEqual([]);
    expect(reportsOf(company, 'head')).not.toContain('head');
  });

  it('keeps people under a deactivated manager in sight of the manager above', () => {
    const people = company.map((p) => (p.id === 'lead' ? { ...p, status: 'inactive' as const } : p));
    expect(sorted(reportsOf(people, 'head'))).toEqual(['asha', 'binu', 'chitra', 'lead']);
    expect(managerChain(people, 'asha')).toEqual(['lead', 'head']);
  });

  it('spots an assignment that would make someone their own manager', () => {
    expect(wouldLoop(company, 'head', 'head')).toBe(true);
    expect(wouldLoop(company, 'head', 'lead')).toBe(true);
    expect(wouldLoop(company, 'head', 'asha')).toBe(true);
    expect(wouldLoop(company, 'asha', 'head')).toBe(false);
    expect(wouldLoop(company, 'head', 'other')).toBe(false);
    expect(wouldLoop(company, 'loner', 'lead')).toBe(false);
  });
});

describe('who may see whom', () => {
  it('lets an Employee see only themselves', () => {
    const scope = scopeOf(company[4]!, company);
    expect(scope.kind).toBe('self');
    expect(inScope(scope, 'asha')).toBe(true);
    expect(inScope(scope, 'binu')).toBe(false);
    expect(inScope(scope, 'lead')).toBe(false);
    expect(scopeIds(scope)).toEqual(['asha']);
  });

  it('lets a Manager see themselves and their whole chain, and nobody else', () => {
    const scope = scopeOf(company[2]!, company);
    expect(scope.kind).toBe('team');
    for (const id of ['head', 'lead', 'asha', 'binu', 'chitra']) expect(inScope(scope, id), id).toBe(true);
    for (const id of ['admin', 'hr', 'other', 'dev', 'loner', 'ghost']) expect(inScope(scope, id), id).toBe(false);
    expect(sorted(scopeIds(scope) as string[])).toEqual(['asha', 'binu', 'chitra', 'head', 'lead']);
  });

  it('does not let a Manager see their own manager or a sibling team', () => {
    const scope = scopeOf(company[3]!, company);
    expect(inScope(scope, 'head')).toBe(false);
    expect(inScope(scope, 'chitra')).toBe(false);
    expect(inScope(scope, 'asha')).toBe(true);
  });

  it('gives a Manager with no reports only themselves', () => {
    const scope = scopeOf(person('solo', 'Manager'), company);
    expect(scopeIds(scope)).toEqual(['solo']);
  });

  it('lets HR and Admin see everyone', () => {
    for (const viewer of [company[0]!, company[1]!]) {
      const scope = scopeOf(viewer, company);
      expect(scope.kind).toBe('all');
      expect(inScope(scope, 'loner')).toBe(true);
      expect(scopeIds(scope)).toBe('all');
    }
  });
});

describe('nobody uses an HR power on their own record', () => {
  it('allows an action on other people', () => {
    expect(ownRecordVerdict(company[1]!, ['asha', 'binu'], company)).toBe('ok');
    expect(ownRecordVerdict(company[0]!, [], company)).toBe('ok');
  });

  it('blocks HR acting on themselves, alone or inside a bulk action', () => {
    expect(ownRecordVerdict(company[1]!, ['hr'], company)).toBe('blocked');
    expect(ownRecordVerdict(company[1]!, ['asha', 'hr', 'binu'], company)).toBe('blocked');
  });

  it('blocks an Admin acting on themselves when another HR or Admin exists', () => {
    expect(ownRecordVerdict(company[0]!, ['admin'], company)).toBe('blocked');
    const twoAdmins = [person('a1', 'Admin'), person('a2', 'Admin')];
    expect(ownRecordVerdict(twoAdmins[0]!, ['a1'], twoAdmins)).toBe('blocked');
  });

  it('counts someone who has been invited but has not signed in yet', () => {
    const people = [person('a1', 'Admin'), person('h1', 'HR', null, 'invited')];
    expect(ownRecordVerdict(people[0]!, ['a1'], people)).toBe('blocked');
  });

  it('lets the only Admin in a company with no HR act on themselves, and says so', () => {
    const small = [person('owner', 'Admin'), person('m', 'Manager'), person('e', 'Employee', 'm')];
    expect(ownRecordVerdict(small[0]!, ['owner'], small)).toBe('self_administered');
    expect(ownRecordVerdict(small[0]!, ['e', 'owner'], small)).toBe('self_administered');
  });

  it('does not count a deactivated HR or Admin as someone who could do it', () => {
    const people = [person('owner', 'Admin'), person('gone', 'HR', null, 'inactive'), person('left', 'Admin', null, 'inactive')];
    expect(ownRecordVerdict(people[0]!, ['owner'], people)).toBe('self_administered');
  });

  it('never gives the exception to HR, Managers or Employees', () => {
    const odd = [person('h', 'HR'), person('m', 'Manager'), person('e', 'Employee')];
    expect(ownRecordVerdict(odd[0]!, ['h'], odd)).toBe('blocked');
    expect(ownRecordVerdict(odd[1]!, ['m'], odd)).toBe('blocked');
    expect(ownRecordVerdict(odd[2]!, ['e'], odd)).toBe('blocked');
  });
});
