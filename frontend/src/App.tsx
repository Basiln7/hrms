import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import type { PermissionId } from '@delta-hrms/shared';
import { NoAccess } from './components/controls';
import { Layout } from './components/Layout';
import { useAuth } from './context/AuthContext';
import { lazyPage } from './lib/lazyPage';
import ChangePassword from './pages/ChangePassword';
import Login from './pages/Login';

// Each section is downloaded the first time it is opened, so the first load stays small.
const Announcements = lazyPage(() => import('./pages/Announcements'));
const AnnouncementsManage = lazyPage(() => import('./pages/AnnouncementsManage'));
const Approvals = lazyPage(() => import('./pages/Approvals'));
const Attendance = lazyPage(() => import('./pages/Attendance'));
const AuditLog = lazyPage(() => import('./pages/AuditLog'));
const EmployeeDetail = lazyPage(() => import('./pages/EmployeeDetail'));
const HolidayCalendar = lazyPage(() => import('./pages/HolidayCalendar'));
const HolidayCalendars = lazyPage(() => import('./pages/HolidayCalendars'));
const Holidays = lazyPage(() => import('./pages/Holidays'));
const Home = lazyPage(() => import('./pages/Home'));
const Leave = lazyPage(() => import('./pages/Leave'));
const LeaveSetup = lazyPage(() => import('./pages/LeaveSetup'));
const Overview = lazyPage(() => import('./pages/Overview'));
const People = lazyPage(() => import('./pages/People'));
const Records = lazyPage(() => import('./pages/Records'));
const Reports = lazyPage(() => import('./pages/Reports'));
const Profile = lazyPage(() => import('./pages/Profile'));
const ScheduleEdit = lazyPage(() => import('./pages/ScheduleEdit'));
const Schedules = lazyPage(() => import('./pages/Schedules'));
const Settings = lazyPage(() => import('./pages/Settings'));
const Setup = lazyPage(() => import('./pages/Setup'));

/** Shows the page only when the signed-in role holds the permission. The API refuses them whatever this shows. */
function Guard({ permission, section, children }: { permission: PermissionId | PermissionId[]; section: string; children: ReactNode }) {
  const { can } = useAuth();
  // With several permissions, holding any one of them is enough.
  return [permission].flat().some(can) ? children : <NoAccess section={section} />;
}

export default function App() {
  const { employee, ready } = useAuth();

  // Wait for the saved session to be checked so signed-in people never flash the sign-in page.
  if (!ready) {
    return (
      <div className="boot" role="status">
        <p>Connecting to the server…</p>
      </div>
    );
  }

  // Someone still on a temporary password sees one screen until they have chosen their own.
  const shell = !employee ? <Navigate to="/login" replace /> : employee.mustChangePassword ? <ChangePassword /> : <Layout />;

  return (
    <Routes>
      <Route path="/login" element={employee ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/setup" element={employee ? <Navigate to="/" replace /> : <Setup />} />
      <Route element={shell}>
        <Route index element={<Home />} />
        <Route path="profile" element={<Profile />} />
        <Route path="attendance" element={<Attendance />} />
        <Route path="leave" element={<Leave />} />
        <Route path="announcements" element={<Announcements />} />
        <Route
          path="announcements/manage"
          element={
            <Guard permission="announcements.manage" section="Managing announcements">
              <AnnouncementsManage />
            </Guard>
          }
        />
        <Route path="holidays" element={<Holidays />} />
        <Route
          path="leave-setup"
          element={
            <Guard permission="leave.configure" section="Leave setup">
              <LeaveSetup />
            </Guard>
          }
        />
        <Route
          path="team"
          element={
            <Guard permission="team.view" section="My team">
              <People team />
            </Guard>
          }
        />
        <Route
          path="approvals"
          element={
            <Guard permission={['team.approve', 'requests.approveAll']} section="Approvals">
              <Approvals />
            </Guard>
          }
        />
        {(
          [
            ['overview', 'Overview', <Overview key="overview" />],
            ['records', 'Attendance records', <Records key="records" />],
            ['reports', 'Reports', <Reports key="reports" />],
          ] as const
        ).map(([path, section, page]) => (
          <Route
            key={path}
            path={path}
            element={
              <Guard permission="reports.view" section={section}>
                {page}
              </Guard>
            }
          />
        ))}
        <Route
          path="employees"
          element={
            <Guard permission="employees.viewAll" section="Employees">
              <People />
            </Guard>
          }
        />
        {/* One person: their own page, a report's, or anyone's for HR. The API answers "not found" for the rest. */}
        <Route path="employees/:id" element={<EmployeeDetail />} />
        {/* Their month. The same rule: your own, a report's, or anyone's for HR. */}
        <Route path="employees/:id/attendance" element={<Attendance />} />
        <Route
          path="holiday-calendars"
          element={
            <Guard permission="holidays.manage" section="Holiday calendars">
              <HolidayCalendars />
            </Guard>
          }
        />
        <Route
          path="holiday-calendars/:id"
          element={
            <Guard permission="holidays.manage" section="Holiday calendars">
              <HolidayCalendar />
            </Guard>
          }
        />
        {['schedules/new', 'schedules/:id'].map((path) => (
          <Route
            key={path}
            path={path}
            element={
              <Guard permission="schedules.manage" section="Schedules">
                <ScheduleEdit />
              </Guard>
            }
          />
        ))}
        <Route
          path="schedules"
          element={
            <Guard permission="schedules.manage" section="Schedules">
              <Schedules />
            </Guard>
          }
        />
        <Route
          path="settings"
          element={
            <Guard permission="settings.manage" section="Settings">
              <Settings />
            </Guard>
          }
        />
        <Route
          path="audit"
          element={
            <Guard permission="audit.view" section="The audit log">
              <AuditLog />
            </Guard>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
