import { Fragment, Suspense, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { CalendarCheck, CalendarClock, CalendarRange, ClipboardList, FileSpreadsheet, House, Inbox, LayoutDashboard, LogOut, Megaphone, PanelLeftClose, PanelLeftOpen, Plane, ScrollText, Settings, SlidersHorizontal, TreePalm, Users, UsersRound, WifiOff, type LucideIcon } from 'lucide-react';
import type { PermissionId } from '@delta-hrms/shared';
import { useAuth } from '../context/AuthContext';
import { readJson, writeJson } from '../lib/storage';
import { Brand } from './controls';
import { ErrorBoundary } from './ErrorBoundary';
import { Topbar } from './Topbar';
import { keepFocusInside } from './ui';

const COLLAPSE_KEY = 'delta.hrms.sidebar.collapsed';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  /** Shown only to roles that hold this. The API checks again whatever the menu shows. */
  permission?: PermissionId;
  /** Shown to roles that hold any of these. */
  anyOf?: PermissionId[];
  /** Carries a number from the server: requests waiting for the signed-in person, or announcements they have still to read. */
  counts?: 'approvals' | 'announcements';
}

/*
 * The whole menu. A section is added here in the phase that builds it, so nothing in the
 * menu ever leads to a page that does not exist.
 */
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Me',
    items: [
      { to: '/', label: 'Home', icon: House, end: true },
      { to: '/attendance', label: 'Attendance', icon: CalendarCheck },
      { to: '/leave', label: 'Leave', icon: Plane, end: true },
      { to: '/holidays', label: 'Holidays', icon: TreePalm },
      { to: '/announcements', label: 'Announcements', icon: Megaphone, end: true, counts: 'announcements' },
    ],
  },
  {
    group: 'Team',
    items: [
      { to: '/team', label: 'My team', icon: UsersRound, permission: 'team.view' },
      { to: '/approvals', label: 'Approvals', icon: Inbox, anyOf: ['team.approve', 'requests.approveAll'], counts: 'approvals' },
    ],
  },
  {
    group: 'Organisation',
    items: [
      { to: '/overview', label: 'Overview', icon: LayoutDashboard, permission: 'reports.view' },
      { to: '/employees', label: 'Employees', icon: Users, permission: 'employees.viewAll' },
      { to: '/records', label: 'Attendance records', icon: ClipboardList, permission: 'reports.view' },
      { to: '/schedules', label: 'Schedules', icon: CalendarClock, permission: 'schedules.manage' },
      { to: '/leave-setup', label: 'Leave setup', icon: SlidersHorizontal, permission: 'leave.configure' },
      { to: '/holiday-calendars', label: 'Holiday calendars', icon: CalendarRange, permission: 'holidays.manage' },
      { to: '/announcements/manage', label: 'Post announcements', icon: Megaphone, permission: 'announcements.manage' },
      { to: '/reports', label: 'Reports', icon: FileSpreadsheet, permission: 'reports.view' },
    ],
  },
  {
    group: 'Admin',
    items: [
      { to: '/settings', label: 'Settings', icon: Settings, permission: 'settings.manage' },
      { to: '/audit', label: 'Audit log', icon: ScrollText, permission: 'audit.view' },
    ],
  },
];

export function Layout() {
  const { logout, can, offline, approvalsWaiting, unreadAnnouncements } = useAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => readJson(COLLAPSE_KEY, false));
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close the drawer whenever the route changes on small screens.
  useEffect(() => setMobileOpen(false), [location.pathname]);

  // The open drawer is on top of the page: the keyboard goes into it and stays in it, Escape
  // closes it, and closing puts the keyboard back on the button that opened it.
  const sidebarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!mobileOpen) return;
    const opener = document.activeElement as HTMLElement | null;
    sidebarRef.current?.querySelector<HTMLElement>('a[href], button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
      else if (sidebarRef.current) keepFocusInside(sidebarRef.current, e);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [mobileOpen]);

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      writeJson(COLLAPSE_KEY, !c);
      return !c;
    });

  const groups = NAV.map(({ group, items }) => ({ group, items: items.filter((item) => (!item.permission || can(item.permission)) && (!item.anyOf || item.anyOf.some(can))) })).filter((g) => g.items.length > 0);

  return (
    <div className="shell" data-collapsed={collapsed} data-mobile-open={mobileOpen}>
      {/* The first stop for the Tab key: past the menu, straight to the page. Seen only while it has focus. */}
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to the page
      </a>
      <aside className="sidebar" aria-label="Main navigation" ref={sidebarRef}>
        <Brand />
        <nav className="nav">
          {groups.map(({ group, items }) => (
            <Fragment key={group}>
              <div className="nav-group">{group}</div>
              {items.map(({ to, label, icon: Icon, end, counts }) => {
                const waiting = counts === 'approvals' ? approvalsWaiting : counts === 'announcements' ? unreadAnnouncements : 0;
                return (
                  <NavLink key={to} to={to} end={end} className="nav-link" title={collapsed ? label : undefined} aria-label={waiting > 0 ? `${label}, ${waiting} ${counts === 'announcements' ? 'unread' : 'waiting'}` : undefined}>
                    <Icon size={19} />
                    <span>{label}</span>
                    {waiting > 0 && (
                      <span className="nav-count" aria-hidden="true">
                        {waiting}
                      </span>
                    )}
                  </NavLink>
                );
              })}
            </Fragment>
          ))}
        </nav>
        <div className="side-foot">
          <button type="button" className="nav-link only-desktop" onClick={toggleCollapsed} title={collapsed ? 'Expand sidebar' : undefined} aria-pressed={collapsed}>
            {collapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}
            <span>Collapse</span>
          </button>
          <button type="button" className="nav-link" onClick={() => void logout()} title={collapsed ? 'Sign out' : undefined}>
            <LogOut size={19} />
            <span>Sign out</span>
          </button>
        </div>
      </aside>
      {mobileOpen && <div className="side-scrim" onClick={() => setMobileOpen(false)} />}

      <div className="main">
        {offline && (
          <div className="offline-bar" role="status">
            <WifiOff size={17} aria-hidden="true" />
            The server cannot be reached. Trying again…
          </div>
        )}
        <Topbar onMenu={() => setMobileOpen(true)} />
        <main className="content" id="main" tabIndex={-1}>
          <div className="page" key={location.pathname}>
            {/* Keyed by address, so moving to another page clears a page that failed. */}
            <ErrorBoundary>
              <Suspense
                fallback={
                  <p className="page-loading" role="status">
                    Loading…
                  </p>
                }
              >
                <Outlet />
              </Suspense>
            </ErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}
