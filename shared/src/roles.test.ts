import { describe, expect, it } from 'vitest';
import { validateCompany } from './company';
import { ALL_PERMISSIONS, can, canBeManager, isPrivileged, isRole, PERMISSIONS, permissionsOf, ROLE_PERMISSIONS, ROLES, type PermissionId } from './roles';

describe('the role table', () => {
  it('names each permission once', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('grants only permissions that exist, none of them twice', () => {
    for (const role of ROLES) {
      const granted = ROLE_PERMISSIONS[role];
      expect(new Set(granted).size, role).toBe(granted.length);
      for (const id of granted) expect(ALL_PERMISSIONS, `${role} ${id}`).toContain(id);
    }
  });

  it('gives an Employee no permission: self-service needs none', () => {
    expect(permissionsOf('Employee')).toEqual([]);
  });

  it('gives a Manager their team and its reports, and nothing about the company', () => {
    expect([...permissionsOf('Manager')].sort()).toEqual(['reports.export', 'reports.view', 'team.approve', 'team.view']);
  });

  it('keeps company settings, HR and Admin accounts and the audit log for the Admin', () => {
    const adminOnly: PermissionId[] = ['settings.manage', 'audit.view', 'roles.assignPrivileged'];
    for (const id of adminOnly) {
      expect(can('Admin', id), id).toBe(true);
      expect(can('HR', id), id).toBe(false);
      expect(can('Manager', id), id).toBe(false);
      expect(can('Employee', id), id).toBe(false);
    }
  });

  it('gives the Admin everything HR has', () => {
    for (const id of permissionsOf('HR')) expect(can('Admin', id), id).toBe(true);
  });

  it('lets HR run people, schedules, holidays, leave and announcements', () => {
    const expected: PermissionId[] = ['employees.viewAll', 'employees.manage', 'roles.assign', 'schedules.manage', 'holidays.manage', 'attendance.edit', 'leave.configure', 'requests.approveAll', 'announcements.manage', 'reports.view', 'reports.export'];
    for (const id of expected) expect(can('HR', id), id).toBe(true);
  });

  it('knows which roles run the HRMS and which may manage people', () => {
    expect(ROLES.filter(isPrivileged)).toEqual(['HR', 'Admin']);
    expect(ROLES.filter(canBeManager)).toEqual(['Manager', 'HR', 'Admin']);
    expect(isRole('HR')).toBe(true);
    expect(isRole('Super Admin')).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});

describe('company settings', () => {
  const good = { name: 'Delta', timeZone: 'Asia/Kolkata', weekStartsOn: 'monday' as const, leaveYearStartMonth: 4 };

  it('accepts sound settings', () => {
    expect(validateCompany(good)).toEqual({});
    expect(validateCompany({ ...good, timeZone: 'Asia/Dubai', weekStartsOn: 'sunday', leaveYearStartMonth: 1 })).toEqual({});
  });

  it('names each field that is wrong', () => {
    expect(Object.keys(validateCompany({ ...good, name: ' ' }))).toEqual(['name']);
    expect(Object.keys(validateCompany({ ...good, name: 'x'.repeat(121) }))).toEqual(['name']);
    expect(Object.keys(validateCompany({ ...good, timeZone: 'India' }))).toEqual(['timeZone']);
    expect(Object.keys(validateCompany({ ...good, leaveYearStartMonth: 13 }))).toEqual(['leaveYearStartMonth']);
    expect(Object.keys(validateCompany({ ...good, leaveYearStartMonth: 1.5 }))).toEqual(['leaveYearStartMonth']);
    expect(Object.keys(validateCompany({ ...good, weekStartsOn: 'friday' as never }))).toEqual(['weekStartsOn']);
  });
});
