# Delta HRMS: the plan

A basic HRMS for Delta: attendance with check-in and check-out, a work schedule per employee,
holidays, leave, attendance corrections, announcements, an HR dashboard and reports.

This file is the plan and, as the work goes on, the record of it. It is updated at the end of
every phase. Phases 0 to 9 are done; only the final pass (Phase 10) is left. People can check
in and out from Home, see any month of their attendance day by day, see their holidays, ask
for a day to be corrected, ask for leave against a balance, and read the announcements that
are for them. Managers and HR decide those requests; HR can also correct a day directly and
leave a note on it. HR keeps holiday calendars, the kinds of leave and the leave policies,
adjusts balances, and posts announcements. HR sees an overview of any day for everyone, the
attendance records and the reports, and a Manager sees the same for their team; reports
download as CSV. The audit log is written but has no page yet.

Last updated: 23 Nov 2026, end of Phase 9 (reports in section 15).

---

## Status

| Phase | What | State |
|---|---|---|
| 0 | Analysis and this plan | Done. Approved as written on 23 Nov 2026 |
| 1 | Foundation: workspace, sign-in, roles, shell, first-run setup | Done. Approved on 23 Nov 2026 |
| 2 | Employees, departments, work schedules | Done. Approved on 23 Nov 2026 |
| 3 | Attendance engine: check-in, check-out, calculations | Done. Approved on 23 Nov 2026 |
| 4 | Employee dashboard | Done. Approved on 23 Nov 2026 |
| 5 | Attendance calendar and holidays | Done. Approved on 23 Nov 2026 |
| 6 | Attendance corrections (regularization) and approvals | Done. Approved on 23 Nov 2026 |
| 7 | Leave | Done. Approved on 23 Nov 2026 |
| 8 | Announcements | Done. Approved on 23 Nov 2026 |
| 9 | HR dashboard, attendance records, reports, exports | Done. Approved on 23 Nov 2026 |
| 10 | Final testing, security pass, polish, documentation | Done. Approved on 23 Nov 2026 |

Rules for the work (from the brief, kept here so they travel with the plan):

- One phase at a time. A phase is done only when it is built, tested and its tests pass.
- Unfinished work is never marked done. A failing or skipped test is written down here.
- After each phase: tick its checklist, record changed decisions, write a short report.
- Stop after Phase 1 for review.

---

## 1. What exists today (Phase 0 findings)

### 1.1 The `hrms` folder is empty

`C:\Users\MSI-PC\Delta-upcoming\hrms` was created on 23 Nov 2026 and has no files. It is not a
git repository. So there is **no existing application here to build inside**: no code, no
sign-in system, no user or employee model, no navigation, no tests.

What does exist is the family of Delta projects beside it:

| Folder | What it is | Relevant to the HRMS |
|---|---|---|
| `../sales-CRM-new` | Delta Sales CRM, the newest app (about 48,000 lines, built 14 to 21 Nov 2026) | **The closest relative: an internal staff tool.** Sign-in, sessions, roles and permissions, users, teams, audit log, design system, test set-up |
| `../sales-CRM/dilshad-crm` | The older CRM, with a `SECURITY_FINDINGS.md` | **It calls an existing Delta HRMS** (below). Its security findings are lessons to avoid (1.4) |
| `../LMS-recorded-class` | The LMS (NestJS, Prisma, PostgreSQL; two Next.js apps) | A different stack; useful patterns (1.4) |
| `../Landing-page` | The public website (Next.js) | Not related |

**There is already a Delta HRMS somewhere else.** The older CRM talks to one
(`sales-CRM/dilshad-crm/backend/src/lib/hrms.ts`): a signed server-to-server API at
`/api/v1/integrations/…` that keeps the office's meeting rooms and each person's "wallet"
(salary a day at a time), for more than one organization, and is also called by a "Root
portal", a "CS Portal" and finance. **Its code is not on this machine**, so it could not be
read, reused or built inside. This plan therefore treats the HRMS in this folder as a new
product that neither replaces nor talks to that one. If it is meant to, that changes the
scope: see decision D1 and the questions in 13.4.

None of the projects on this machine has attendance, leave, shifts, holidays or an employee
record. The older CRM has activity tracking of its own (break logs, active minutes per day,
idle alerts, sign-in history); that is surveillance of screen time, not attendance, and is
not part of this plan.

### 1.2 The stack this plan follows (the Delta Sales CRM's)

The family does not have one stack. The LMS is NestJS, Prisma and PostgreSQL with Next.js;
the older CRM is Express on Bun with Mongoose and Next.js; the newest CRM is the one below.
The HRMS follows the newest CRM because it is the same kind of product (an internal tool with
people, roles, dashboards and reports), it is the most recent work, MongoDB already runs
here, and its `shared` package of tested rules is exactly the shape an attendance engine
needs. Decision D2 gives the alternative.

| Part | Technology | Notes |
|---|---|---|
| Layout | npm workspaces: `frontend/`, `backend/`, `shared/` | The two sides never import each other; both import `shared` |
| Web app | React 19, TypeScript (strict), Vite 8, React Router 7 | Pages are loaded lazily |
| API | Node 22+, Express 5, Zod 4 | Every request body is checked with Zod |
| Database | MongoDB, official driver (no ORM) | The app's `id` is stored as `_id`; indexes are created on start-up |
| Tests | Vitest 4 | Unit tests of `shared`; API tests against a real, throwaway MongoDB |
| UI | Hand-written CSS with design tokens, `lucide-react` icons | Fonts: Figtree (text), Bricolage Grotesque (headings). Dark and light themes. No component library |
| Sign-in | httpOnly session cookie; the session lives in MongoDB (only a SHA-256 of the token is stored) | Passwords: scrypt with a salt per person. Sign-in attempts are throttled |
| Access | Roles with a permission table; the API checks every request | The browser hiding a button is a convenience only |
| Safety | `helmet` with a strict content policy, same-origin check on every change, 200 kB body limit, one JSON error shape | |

The rule that matters most there, and that the HRMS keeps: **business rules are written once,
as plain functions in `shared`, with unit tests**. The browser uses them to explain; the API
uses the same code to decide.

This machine: Node 25.7, npm 11.10, MongoDB 8.3 running on `127.0.0.1:27017`, Docker and git
installed. Time zone of the machine: Asia/Kolkata.

### 1.3 What can be reused, and how

The HRMS is a separate app (decision D1), so these are **copied and adapted**, not imported
across folders. Each is small and already proven in the CRM.

| From the CRM | Reused as |
|---|---|
| `backend/src/auth/passwords.ts`, `auth/sessions.ts` | The same scrypt passwords and server-side sessions |
| `backend/src/http/errors.ts`, `http/security.ts`, `http/context.ts` | The error shape, the same-origin guard, the sign-in throttle, `authenticate` and `requirePermission` |
| `backend/src/config.ts`, `db.ts`, `app.ts`, `server.ts` | Environment checked with Zod, typed collections, indexes on start-up, health check, graceful shutdown, one deployable in production |
| `shared/src/roles.ts` (pattern) | A permission list and a role table, with HR roles instead of sales roles |
| `shared/src/leadAccess.ts` + `services/leadAccess.ts` (pattern) | "Who may see which employee", written once and used by every query |
| The lead rotation's versioned settings document (pattern) | Safe concurrent saves: a write goes through only if nobody else wrote in between |
| `frontend/src/lib/api.ts`, `lib/storage.ts`, `lib/lazyPage.ts`, `lib/format.ts` (dates, CSV) | The same |
| `frontend/src/components/ui.tsx`, `controls.tsx`, `FormField.tsx`, `ErrorBoundary.tsx` | Avatar, Badge, Modal, Confirm, Empty, Pager, Switch, RowMenu, Popover, NoAccess, form fields |
| `frontend/src/context/ThemeContext.tsx`, `ToastContext.tsx` | The same |
| `styles.css`: tokens, base, app shell, buttons, inputs, badges, cards, tables, modal, toasts, sign-in, responsive | The same look, split into several files instead of one 9,800-line file |
| `backend/src/api.test.ts` (set-up) | The same throwaway-database API test harness |

### 1.4 What the other projects teach

**Where Delta works.** The older CRM runs on Asia/Dubai time with AED throughout; the LMS
tests in Asia/Kolkata and is in English and Malayalam; the website defaults to INR. Delta has
people in India and the UAE, whose weekends and public holidays differ. So the time zone, the
weekly offs and the holiday calendar are per schedule and per employee from the first phase,
and the company's default zone is asked at setup rather than assumed.

**People are matched by email** across the Delta systems (the existing HRMS's wallet is
looked up by email). Email is the unique key for an employee here too.

**Patterns worth borrowing from the LMS**: announcements with a scheduled start, an expiry
and pinning; a time zone per person; pure policy functions; one migration per phase (here:
one start-up upgrade step per change to stored data).

**Lessons from `sales-CRM/SECURITY_FINDINGS.md`**, each turned into a rule for this build:

| What went wrong there | The rule here |
|---|---|
| Passwords and keys committed in docs, env defaults and seed scripts | No secret has a default. Production refuses to start without its settings. Sample accounts exist only in the development seed, which refuses to run in production |
| Some endpoints needed no sign-in | The API router requires a session by default; public routes are a short named list. A test walks every route and expects 401 without a session |
| A database join returned password hashes | Password digests are removed in the query itself, in one place. A test scans every API answer for them |
| Anyone who could edit users could make themselves Super Admin | Role changes are checked on the server against the caller's own role; nobody uses an HR power on their own record (section 4) |
| Records fetched by id were not checked against the caller's team | One "may this person see that employee" function, used by every route that takes an id |
| Long-lived tokens in browser storage, no way to end them, role changes applied only at next sign-in | Server-side sessions in an httpOnly cookie; role and status are re-read on every request |
| No sign-in rate limit | Throttled per address and email |
| Search text went into a database pattern unescaped | Search text is escaped before it is used |
| User HTML was rendered; CSV exports could carry formulas | Text is shown as text; CSV cells that start like a formula are made safe |
| Data left the system (exports to chat apps, records to AI services, connection strings and stack traces in logs and answers) | The HRMS calls no outside service. Errors shown to people are safe sentences; the connection string is never logged |

### 1.5 Where the HRMS deliberately differs from the CRM

| The CRM does | The HRMS does | Why |
|---|---|---|
| Loads every record at sign-in and filters in the browser | Asks the API for one page of what the person may see | HR data is private per person; nobody's browser should hold everyone's records |
| Shows a change at once and saves in the background | Waits for the server's answer on attendance, leave and approvals | The server is the only source of truth for time and for decisions |
| Ids are made in the browser | Ids are made on the server | Nothing about an attendance record is trusted from the device |
| Five sales roles | Four HR roles: Employee, Manager, HR, Admin | From the brief |
| Has impersonation | Does not | Not asked for, and acting as someone else in an attendance system is a risk |
| Sample data on first start; the first person to sign up becomes Super Admin | Empty on first start; a first-run setup creates the Admin, and in production needs a setup code from the server's settings. Sample data only with `npm run seed`, never in production | Sample attendance must never mix with real records, and a fresh production address must not be claimable by whoever finds it first |
| Cookie `delta_session`, ports 4100 and 5173, database `delta_sales_crm` | Cookie `delta_hrms_session`, ports 4200 and 5174, database `delta_hrms` | Both apps can run on one machine. Cookies are shared between ports on `localhost`, so the same cookie name would sign people out of the other app |

---

## 2. Project overview

### 2.1 Purpose

Give Delta one place where people record their working day and time off, and where HR sees
it truthfully: who is in, who is late, who is on leave, what needs approving, and the month's
attendance for everyone, each person measured against **their own** schedule.

### 2.2 Scope of the first version

In: sign-in and four roles; employees and departments; a work schedule per employee with
effective dates and history; check-in, check-out and optional breaks on the server's clock;
attendance calculation (present, late, half-day, absent, holiday, weekly off, leave,
incomplete); a monthly calendar; holiday calendars; attendance corrections with approval and
an audit trail; leave types, policies, balances, requests and approval; announcements; an HR
dashboard; attendance records with filters; monthly and per-employee reports with CSV export;
an audit log.

Out (not asked for, or deliberately left for later; see section 13):

- Payroll, salary, deductions. Attendance decides a status and nothing else.
- Email or SMS. Like the CRM, no messages are sent; a temporary password is passed on by HR.
- File attachments on leave and correction requests.
- Location, IP or device restrictions on check-in (the address and browser are recorded for the audit trail only).
- Single sign-on with the CRM, biometric devices, mobile apps.
- Acting as another person (impersonation).
- More than one company in one installation.
- Importing people or past attendance from a file.

### 2.3 Architecture

```
Browser (React)                       API (Express)                         MongoDB
───────────────                       ─────────────                         ───────
pages ── small fetch hooks ──►        /api/...  routes                      delta_hrms
  │  waits for the server's answer      │  Zod checks every input           employees, sessions, meta,
  │  shows the server's time            │  who-may-see-whom on every query  departments, schedules,
  │                                     │  server clock for every stamp     schedule_assignments,
  ▼                                     ▼                                   attendance_days,
@delta-hrms/shared ◄── one copy of every rule: schedules, the attendance    holiday_calendars, holidays,
                       engine, leave counting, permissions ──► shared       leave_types, leave_policies,
                                                                            leave_accounts, leave_requests,
                                                                            regularization_requests,
                                                                            announcements, audit
```

- **`shared/`** holds types and pure functions: date maths in a time zone, schedule rules,
  the attendance engine, leave counting, permissions and scope. No I/O, no clock of its own
  (the time is always passed in), so it is fully unit-tested.
- **`backend/`** owns the clock, the database and every decision. It never accepts a time,
  an employee id for "me", a status or a duration from the browser for a punch.
- **`frontend/`** shows what the API returns. It runs `shared` only to preview and explain
  (for example the days a leave request will use), never to decide.

Folder layout:

```
hrms/
  package.json              workspace: one install, one set of commands
  tsconfig.base.json
  docker-compose.yml        optional local MongoDB
  README.md                 how to run it, how each feature behaves
  plan.md                   this file
  shared/src/               ids, dates, roles, org, schedules, attendance, holidays, leave,
                            regularization, announcements, reports, contract (+ *.test.ts)
  backend/src/
    server.ts app.ts config.ts db.ts clock.ts
    auth/        passwords.ts sessions.ts
    http/        context.ts errors.ts schemas.ts security.ts
    routes/      auth, me, employees, departments, schedules, attendance, holidays, leave,
                 regularizations, announcements, dashboard, reports, settings, audit
    services/    access, audit, employees, schedules, attendance, holidays, leave,
                 regularizations, reports, settings
    seed/        demo.ts run.ts
    *.test.ts    API tests
  frontend/src/
    main.tsx App.tsx
    components/  context/  lib/  pages/  styles/
  qa/                       role-sweep and attack scripts (Phase 10)
```

---

## 3. Decisions

| # | Decision | Why | If you want it otherwise |
|---|---|---|---|
| D1 | **The HRMS is a new app of its own in `hrms/`.** It does not replace, extend or talk to the Delta HRMS that already exists elsewhere, and it is not a module of the CRM | The folder is empty and the existing HRMS's code is not here. The brief says to choose the safest path when something is unclear, and this touches no existing project. The CRM's roles are sales roles, its user record has no employee fields, and it keeps every record in every browser, which is wrong for HR data | **(a)** If the work was meant to happen inside the existing HRMS, its repository is needed here first and Phase 0 is redone against it. **(b)** If this is to replace it one day, its integration API (meeting rooms, wallet, signed `X-Delta-*` requests, several organizations) becomes extra phases after Phase 10. **(c)** A module inside `sales-CRM-new` is possible (one sign-in, one user list) but changes the CRM's user model, roles, navigation and data loading |
| D2 | The newest CRM's technology, at the versions in its lockfile: Express 5, MongoDB driver, Zod, React 19, Vite, Vitest | Reasons in 1.2. These versions are known to work together on this machine | The LMS's stack (NestJS, Prisma, PostgreSQL, Next.js) gives real transactions and foreign keys, which suit attendance and leave well and would make 5.3 simpler. It is heavier to build and run (a PostgreSQL container, migrations, two frameworks). The rules, API and screens in this plan stay the same; sections 2.3 and 5 would be rewritten |
| D3 | The employee record is the account: one `employees` collection holds the person, their role and their password digest | The brief: no duplicate accounts or sign-in data | |
| D4 | One bundle of rules per employee per date range: hours, weekly offs, break rule, grace, thresholds, holiday calendar | The thresholds depend on the hours, and the brief's examples configure them together. "Applicable attendance policy" is the rules half of this bundle | A separate library of named attendance policies can be added later without changing stored history |
| D5 | Schedule assignments are append-only snapshots with a start date; nothing is ever back-dated | History cannot change when a schedule is edited (section 6.2) | |
| D6 | **Only facts are stored** (the punches, the approved corrections). Status, flags and totals are worked out whenever they are asked for, by one function | A stored status goes stale the moment something else changes (a leave approved at 14:00 for a day checked out at 13:00). One function over facts cannot disagree with itself, and needs no nightly job | |
| D7 | No database transactions are assumed | A single MongoDB server does not support them. Every fact has one document that owns it; anything that needs two documents is a single-winner step followed by a step that can be repeated safely (section 5.3) | |
| D8 | Each employee has one leave account document per leave year: credits, and the days held or taken by live requests. The balance is worked out from it, never stored as a number | Overlap and balance are checked and the days are held in **one** write to **one** document, so two requests sent at the same instant cannot both pass | |
| D9 | Days are stored as `YYYY-MM-DD` in the schedule's time zone; moments as UTC | A "day" in attendance is a local idea; a punch is a moment (section 6.6) | |
| D10 | The role table is fixed in code for v1 (four roles, section 4) | Asked for: assigning roles. Not asked for: editing what a role may do. The table is data, so an editor can be added | |
| D11 | A "team" is a manager's reports (direct, and through their reports) | The brief speaks of "employees or teams assigned to" a manager. A separate team record would be a second way to say the same thing | |
| D12 | One check-in and one check-out per working day; breaks cover the gaps | "Prevent duplicate check-ins". A check-out made by mistake is fixed with a correction request, which keeps the original | |
| D13 | **Nobody uses an HR power on their own record**: not their requests, attendance, schedule, leave balance, role, status or manager. Another HR or Admin does it | Without this, HR could add leave days to themselves or give themselves a schedule that makes every day a full day. The one exception: an Admin who is the only HR or Admin in the company may, and the audit log marks each such action as self-administered | |
| D14 | Scope and reports follow **today's** organisation: a manager sees the whole history of the people who report to them now; a department filter uses people's current department | Keeping a dated history of who reported to whom is a feature of its own. Left for later | |
| D15 | A leave request lies inside one leave year. A break over the year end is two requests | One account document per year stays the single place a request is checked against | |
| D16 | The API listens on `API_PORT` (4200). A `PORT` variable is honoured only in production (added in Phase 1) | Tools that start the web app in development set `PORT` for it. The API read the same variable and both landed on one port | |
| D17 | A collection and its indexes are created in the phase that first uses it (added in Phase 1) | Phase 1 made the four it uses: `employees`, `sessions`, `meta`, `audit`. Section 5.1 stays the target | |
| D18 | The sign-in screens are one plain card, the shell has a flat background, and the theme follows the device until someone chooses (added in Phase 1) | The CRM's sign-in has a marketing panel with gradients and a drawn chart, and its shell a glow. The brief asks for minimal and no excess gradients. Tokens, type and components are the CRM's unchanged | Say so and the CRM's sign-in layout can be brought over |
| D19 | A first schedule is offered, not forced, when adding someone (changed in Phase 2) | Section 12 said "create (with a first schedule)". HR and Admin accounts that never punch need none, and HR may not know the schedule yet. Someone without one is marked "No schedule" in the list, cannot check in, and has nothing counted | |
| D20 | Giving a schedule always answers with who got it and, for each person who did not, why (added in Phase 2) | One wrong date or one deactivated person should not fail a bulk action for everyone, and nobody should be skipped silently | |
| D21 | Temporary passwords are made by the server and shown once (added in Phase 2) | A password HR types is a password HR chose. This one is random, is stored only as a digest, and is never written to the audit log | |
| D22 | A change of schedule is judged against today in the zone of the rules the person is on now; a first schedule, in the zone of the rules being given (added in Phase 2) | "Tomorrow at the earliest" must mean the person's tomorrow, not the server's or the company's | |
| D23 | New schedules start from a built-in starting point or a copy of an existing one. There is no company-wide "default rules" setting (changed in Phase 2) | 5.1 listed default rules under company settings. Copying a schedule does the same job with nothing extra to keep in step | |
| D24 | "My team" is in the menu for roles that hold `team.view` (Managers). HR and Admin find their own reports under Employees, with the manager filter (changed in Phase 2) | Section 11 listed it for all three. HR and Admin already see everyone | |
| D25 | **A flexible day always ends at its local midnight**, also when the next day is a day off. After that it cannot be checked out and needs a correction (changed in Phase 3) | 6.4 let an open day be closed until the next window opened, which for flexible hours before a weekend could be two days later. 6.5 already says a flexible day is over at midnight; one rule for both is simpler to explain | Someone on flexible hours who works past midnight cannot check out. If that happens in practice, the day can stay closable for a set time past midnight: one function (`closableUntil`) and its test |
| D26 | While an earlier day is still open and can still be closed, a new check-in is refused: "check out first". Once it can no longer be closed it stops nothing (added in Phase 3) | Otherwise a person could have two days open at once (work on a day off after a forgotten check-out), and "check out" would not say which | |
| D27 | A day's history is returned without where each change came from (IP address, browser). Both stay in the database (added in Phase 3) | A manager reading a report's day has no use for them. They are there for HR to look into a disputed punch, and can be shown to `audit.view` later | |
| D28 | The four punches answer with the same thing as `GET /attendance/today` (added in Phase 3) | The screen shows the new state without asking again, and there is one shape to keep right | |
| D29 | **What Home says is decided in `shared`, not in the page.** Today's state is put together by one function (`composeToday`) that the API answers with, and its words (`describeToday`), the timer's count (`liveDay`) and the check-out warning are functions beside it (added in Phase 4) | The web app has no test runner; `shared` does. Every state in 6.5 is tested there, including the ones the running app cannot reach yet (holiday, leave). The Phase 3 code that built "today" inside the API moved there unchanged, and its 25 tests pass untouched | |
| D30 | **The timer shows time worked, counted as the server will count it**, ticking in seconds. It stands still on a recorded break and while a fixed break is being taken off, and says why. It starts from the minute of the check-in, not the second (added in Phase 4) | 6.3 counts in whole minutes and takes the break off gradually. A clock that ran straight through would promise time the check-out then does not record | A plain "time since check-in" is shown beside it |
| D31 | **Checking out asks first**, and says what the day will count as (a full day, a half-day, absent, an early departure). Checking in does not ask (added in Phase 4) | Section 11: anything that cannot be undone asks first. A check-out cannot be taken back, and until Phase 6 cannot be corrected either | |
| D32 | Home asks the server again every minute while it is being looked at, and when someone returns to it. The browser decides nothing about state (added in Phase 4) | What is true changes with the time alone: check-in opens, the grace runs out, a day stops being closable. The same answer re-sets the page's clock | |
| D33 | This month shows five numbers, not six: present, half-days, absent, late entries, time worked. Leave joins them in Phase 7. Unresolved days are a warning under the numbers (changed in Phase 4) | Section 11 listed leave among the six. A "Leave: 0" before leave exists would look like a fact | |
| D34 | The blocks on Home do not link anywhere yet, and "still checked in from an earlier day" offers one button and the advice to ask HR (changed in Phase 4) | Section 11 has each block link to its page, and 6.4 offers "ask for a correction". Those pages are phases 5 and 6; a link or button to nothing is what the brief forbids | Both are added by the phase that builds the page |
| D35 | `npm run seed -- --history` gives the sample company three weeks of sample attendance. Off by default, never in production, and written as plain punches that the engine judges like any others (added in Phase 4) | A sample company created today has no yesterday, so the month and recent days could not be looked at. The tests use the plain sample company and one test covers the history | |
| D36 | **Someone's holiday calendar is changed by a new schedule assignment from a date**: the same rules, the new calendar, tomorrow at the earliest. Assignments that have not started yet follow. Someone with no schedule cannot be put on a calendar. A change of schedule keeps the calendar the person is on; a first schedule gets the company default (added in Phase 5) | 6.7 freezes the choice of calendar in the assignment. This is the only way to change it without changing a day that has begun | A company that enters its people before its holidays has to give them the calendar afterwards, and the days in between have no holidays. The Holiday calendars page counts who has none and says so |
| D37 | The company's default calendar is a setting of its own, kept by whoever manages holidays, not a field of the company settings. The first calendar made becomes the default (changed in Phase 5) | 5.1 put it in the company settings, which only an Admin may change. It only preselects a calendar for new people, and HR runs holidays | |
| D38 | **A holiday is confirmed only when it changes how a day that has begun reads**, for someone who was on the calendar that day. The API refuses with what would change (so many days from this status to that), and does it when asked again with the confirmation. A new name or note asks nothing (added in Phase 5) | 6.7 asked for "a confirmation that counts the days and people affected". Counting days by how they would read, with the engine itself, is exact; "is the date in the past" is not, across time zones and calendars people joined later | The leave requests touching the date are listed from Phase 7, when leave exists |
| D39 | Copying a year copies date for date and never writes a date that has begun: those are left out, each with its reason, to be added by hand where the effect is shown (added in Phase 5) | A copy must not be a way round D38 | |
| D40 | A calendar that is part of anyone's schedule, now or in their history, cannot be deleted (added in Phase 5) | Their past days read their holidays from it | |
| D41 | Employees read their own holidays through `GET /holidays/mine`, and the next few arrive with `/dashboard/me`. There is no `GET /holidays?calendarId` and no `/holidays/upcoming`; a calendar as such is read through `/holiday-calendars/:id` by those who manage them (changed in Phase 5) | A person's holidays are not one calendar's: each date comes from the calendar they were on then. Section 10 has the routes as built | |
| D42 | On the calendar, a working day still to come is left blank; on a phone a cell is the number and the status icon, with the day list underneath; "My late entries" is a filter on that list. Asking for a correction from a day, and HR's note on it, arrive in Phase 6 (added in Phase 5) | Section 11 describes the page. These are the parts that needed a choice, and the two that belong to a later phase | |
| D43 | An error can carry `details` beside its message, for the cases the web app shows them (added in Phase 5) | D38 needs to say what would change, not only that something would | |
| D44 | The sample company gets a sample holiday calendar when it is made from the command line. The tests' sample company has none, and each test makes the holidays it needs through the API (added in Phase 5) | Existing tests walk real weeks on a set clock and must not meet a holiday they did not ask for | |
| D45 | **The one write that corrects a day reads its own "before".** It sets the corrected facts and adds the history row in a single update in which the database itself fills in what was there a moment earlier. The row carries the request's id, and a day that already holds it is left alone (added in Phase 6) | 5.3 asked for one write and for settling twice to change nothing. Letting the database read the old values in the same write also means no punch can slip in between "read" and "write": the history row cannot disagree with what it replaced | |
| D46 | An approval names the version of the day the approver was shown and is refused, with the day as it is now, if the day has changed. It is also checked again against the day: a request that no longer fits can only be rejected (added in Phase 6) | Section 8 asked for the first. The second closes what the first leaves open: a day that changed and was looked at again, but which the request no longer describes | |
| D47 | Which kinds of correction are offered depends on the day: "missing check-out" only once the day can no longer be checked out; "missing check-in" only while it still can be afterwards; "incorrect" only with a time different from the one recorded; the two status corrections only for a day that reads half-day or absent (added in Phase 6) | Each of the eight kinds then means one thing, and the form never offers a request that would be refused | |
| D48 | The monthly limit counts requests that are waiting or approved for days of the same month. Rejected and cancelled ones do not count. Both limits are those of the rules the person is on today (added in Phase 6) | A limit on how many days of a month are corrected is what "per month" means to HR. A rejected request changed nothing | Two requests for two different days sent in the same instant could pass a limit by one: the count and the insert are two steps. One open request per day, which matters more, is held by the database |
| D49 | A status set by hand counts on a day with nothing punched (engine change, added in Phase 6) | An absent correction for someone who worked away from the office has no punches to keep. 6.5 already had the row; the engine only honoured it on days with a check-in | |
| D50 | HR's direct correction sets the day's four facts as they should be (the two times, a status by hand, a late entry excused) and may take a mistaken punch away. It is not held to the employee's limits, is refused over a day that has changed, and needs a reason. A note is its own text and needs no further reason; notes and corrections are for days that have begun (added in Phase 6) | Section 8: both go through the same write and the same history | |
| D51 | Approvals shows corrections; the leave tab arrives with leave. A person's own requests are on the Attendance page and, while waiting, on Home. `GET /regularizations` has three views: mine, inbox, decided. `GET /me` carries how many wait for the caller (changed in Phase 6) | Section 11 put my requests on Home only, and section 10 had one list | |
| D52 | An Admin who is the only HR or Admin in the company has nobody to approve their own request. They correct their own day directly, which the own-record rule allows them alone, and the audit log marks it (added in Phase 6) | "Never the requester" has no exception. D13's exception for a lone Admin covers the direct edit | |
| D53 | The API tests are given 60 seconds to start and 20 per test, and a test file registers its clean-up before it starts connecting (added in Phase 6) | With seven files each creating a database, its indexes and the sample company at once, start-up passed Vitest's 10-second default and the files failed without running. Timed-out starts had left throwaway databases behind | |
| D54 | What an account is owed (the year's grant, the carry-forward) is **shown** whenever the account is read and **written** with the first change made to it: a request or an adjustment. Reading a balance never writes. The account of the current leave year is opened, and so written, when someone is put on a policy or is added with the default one (changed in Phase 7) | Section 7.2 said the grant is added "the first time the account is needed". If looking at a balance counted, carry-forward would depend on who happened to look, and a preview for next year would freeze next year's grant under today's policy | |
| D55 | Days are carried forward only from a year for which leave was already kept: an account that exists, or a year after the first one that does. An account also records that its carry-forward has been made (`carried`), and the account of a year that is over is granted nothing new (added in Phase 7) | Otherwise everyone who was employed before the HRMS would start with "left-over" days from years nobody recorded, a carry-forward could be made twice, and a kind of leave added to a policy today would be granted for last year | |
| D56 | A policy's rules for a kind of leave also say how many days back it may start (`backdateDays`), beside the notice it needs; the two cannot both be set. Carry-forward is one number, the most that is carried, where 0 carries nothing (changed in Phase 7) | Sick leave is asked for after the fact and casual leave is not: that is a policy value, and the brief forbids fixing policy values in the code. "On or off, with a maximum" was two fields saying one thing | |
| D57 | Leave can be asked for in the current leave year and the next. A leave year that is over is closed: no request and no adjustment can be made in it. HR corrects the current year instead (added in Phase 7) | What was left of the old year has been carried forward. Days added to or freed in the old year afterwards could be spent twice | |
| D58 | The longest run counts leave of the same kind that touches the request: booked right before or right after it with no working day in between, across a weekly off or a holiday (added in Phase 7) | A limit of three days in a row could otherwise be passed by asking twice | |
| D59 | A request keeps who decides it (manager chain, or HR only) as the person's policy said when it was sent (added in Phase 7) | A request waiting for a manager does not vanish from their inbox, or appear in it, because the policy was edited meanwhile | |
| D60 | HR cancels leave that was approved, with a reason, at any time. A request still waiting is not cancelled by HR: it is rejected, which says why. HR's own leave, once started, is cancelled by another HR or Admin (D13), or by a lone Admin with the audit mark (changed in Phase 7) | Section 10 gave HR "cancel with a reason" without saying of what. Two ways for HR to end a waiting request would be one too many | |
| D61 | A request still `submitting` is left alone by list reads for a minute and finished by any read after that, and always at start-up. If one is cleared away while its days are being held, the sender takes the days back and is told to send again (added in Phase 7) | A list read by someone else must not clear away a request that is simply on its way; and whichever of the two gets there first, no days stay held for a request that does not exist | |
| D62 | The company has a default leave policy: the first one created, changeable by hand ("Give to new people"). Someone added afterwards is put on it. Leave setup counts the people on no policy (added in Phase 7) | The same reasoning as the default holiday calendar (D37): otherwise every new person silently has no leave until HR remembers | |
| D63 | A kind of leave is archived, never deleted; its name and its code are each unique; and whether it is paid cannot be changed once it has been asked for (added in Phase 7) | Requests and accounts point at the kind for ever, and "paid or unpaid" decides how leave already taken is counted | |
| D64 | Changing a holiday asks for confirmation also when a leave request, waiting or approved, includes a date whose kind of day changes for that person, on dates still to come as well. Giving people a schedule or a holiday calendar answers with their leave requests from that date on (completes D38) | Section 7.3: whoever makes the change is shown the requests it touches. The days charged stay as they were counted; nothing is refunded or charged by itself | |
| D65 | The engine's day carries the approved leave on it (its name, how much is unpaid) and a mark while a leave request for it waits; the summary counts unpaid leave apart; the month now shows six numbers, leave among them (completes D33) | Section 6.5 asked for paid and unpaid apart. A day that waits for a decision reads exactly as it would without the request, and says that one is waiting | |
| D66 | The month the leave year starts in cannot be changed once any leave account or request exists (as section 7.1 said; enforced in Phase 7) | Every account is for a leave year as it is: moving the year would put leave in the wrong account | |
| D67 | Approvals has two tabs, Leave and Corrections, each with its own count and each with Waiting and Decided. The number in the menu is the two together. `GET /leave/requests` has four views: mine, person, inbox, decided (completes D51) | One inbox per kind keeps each card about one thing: a balance for leave, a day for a correction | |
| D68 | An adjustment cannot take a balance below what is available, unless the policy lets that kind go below zero or the kind is unpaid. It is checked in the same versioned write as a request (added in Phase 7) | HR taking days off while a request for the same days arrives must not leave the account overdrawn | |
| D69 | Days of service, for eligibility and for a pro-rated first year, are counted from the joining date HR recorded, or failing that from the first day attendance counted for the person. A first year is pro-rated by the months left, the month of joining counted whole, rounded down to half a day (added in Phase 7) | A joining date is optional. Without either date eligibility cannot be judged and the person is told to ask HR; an unknown date grants the whole allowance | |
| D70 | An announcement is unread until the person opens it, and again once its title or body has changed. The announcement keeps when its text last changed (`revisedAt`) and a read mark keeps when it was made; pinning it, or changing its importance, its times or its audience, makes nobody read it again (added in Phase 8) | A corrected time or place has to reach the people who read the first version. Comparing two times is one write; deleting everyone's read marks would be a second one that a stop could leave undone | |
| D71 | Who an announcement is for is judged against each person's role and department as they are when they look, by list and by id alike. Someone who may manage announcements is shown, in their own list, only what is for them; the manage page lists everything (added in Phase 8) | Section 9 said "live for them". Freezing the audience when it is posted would hide a department's notice from someone who joins it the next day; and an id that leaked must not open an announcement meant for others | |
| D72 | The start and the end are typed on the company's clock and stored as moments. No start means now. A start in the past is allowed; an end that has already passed, or is not after the start, is refused (added in Phase 8) | HR thinks in the office's time, whatever zone their device is in. An announcement that could never show is a mistake to catch at the form | |
| D73 | Reading an announcement is opening it: a row opens it in full and tells the server. The Announcements page and Home show the same rows; the number in the menu is the server's count of what is unread (added in Phase 8) | Section 9: "an unread mark that clears when opened". A mark that cleared just because a list was on screen would say people had read what they scrolled past | |
| D74 | The manage page shows, for each announcement, how many people it is for today and how many of them have read it as it now stands. Deleting one is for good and takes its read marks with it; the audit log keeps what it said. To stop showing one and keep it, HR gives it an end. Pinning has a quick action of its own (added in Phase 8) | HR posts something to be read: the count says whether it was. The brief asks for delete; an end time is the gentler tool and the confirmation says so | |
| D75 | Home shows the first three announcements, and the block only when there is at least one. The menu has "Announcements" for everyone and "Post announcements" for those who manage them (changed in Phase 8) | Section 11 listed the second as "Announcements (manage)" under the same name. Two menu items with one name read the same to a screen reader | |
| D76 | The overview puts every person into exactly one group for the day: working now, present (a full day done), half-day, absent (the day counts as absent, or they should be in by now and are not), unresolved, on leave, day off, not due yet, to come, not counted. "Checked in" and "Late" are counted across the groups. The people counted are those not deactivated today (added in Phase 9) | Section 6.5: the dashboard uses the engine's statuses, and "absent today" is Not in plus Absent. Groups that add up to everyone can be checked against the engine; "present" as "came in" could not, because a person who came in may still count as absent | |
| D77 | For the overview, the records and the reports, HR and Admin reach everyone and a Manager reaches the people who report to them, directly or through their reports, and not themselves. A filter only narrows that; naming a person or a manager outside it answers "not found" (added in Phase 9) | The brief: a Manager sees their team. A team report that included the manager would be a report on oneself; their own days are on their own pages | |
| D78 | The list behind a number is asked from the server: the number's filter, a search and a page travel with the request, and the counts are always those of everyone in view. Each number is a button (added in Phase 9) | Section 11: every number opens the list behind it. Sending five hundred rows to filter them in the browser would not scale, and would put the deciding of who is "absent" on the wrong side | |
| D79 | On the day that is today for a person, someone still at work on a shift that began the day before is shown on that shift, in the overview and in "My team" (added in Phase 9) | At one in the morning a night worker is "working now". Reading only today's date would show them as not due | |
| D80 | Attendance records list the days there is something to say about: none still to come, none that does not count for the person, and no day off on which nothing happened unless days off are asked for by status. With nothing asked for it is this month so far; at most 92 days at a time. The late frequency is for the people and dates in view, whatever status or mark the list is narrowed to (added in Phase 9) | A list of everyone's Sundays is noise. Three months is what a review needs and bounds what one request can make the server read | |
| D81 | The monthly report has a row for everyone in view for whom at least one day of the month counts, also someone who has since left. The others are left out and their number is given. It ends with a total (added in Phase 9) | A month's report is for that month: a person who worked the first week and left must be in it, and a person with no schedule has nothing to report | |
| D82 | One person's report, also as a file, is open to that person without any permission. Anyone else needs the permission to see reports and the person within their reach, and the permission to export for the file. At most 366 days at a time (added in Phase 9) | Section 10: "self or scoped". A person's own attendance is theirs to take away | |
| D83 | Exports are CSV: UTF-8 with a byte-order mark, CRLF line ends, numbers as numbers, hours as decimals. Text that starts with =, +, -, @, a tab or a carriage return is written with an apostrophe in front. There is no .xlsx (as section 13.3 said) | A spreadsheet runs a cell that starts like a formula, and names, departments and reasons are typed by people. The mark makes Excel read the file as UTF-8, so names in any script come out right | |
| D84 | Every download of other people's attendance is written to the audit log, with who took what and how much. A person downloading their own is not (added in Phase 9) | It is the one way attendance leaves the HRMS in bulk | |
| D85 | Many people are read with a fixed handful of queries (schedules, holidays, waiting corrections, leave, the days themselves), and two pure date functions remember their answers. A month for 500 people is read in about a second on this machine (added in Phase 9) | One query per person per report would be thousands. The same shift start on the same date was being worked out once per person | |
| D86 | "My team" carries each person's day today, sent with that list only. Overview, Attendance records and Reports are in the menu for everyone who may see reports, so for Managers too; a Manager's overview is titled "Team overview" (changed in Phase 9) | Section 11 listed the three under Organisation for HR and Admin, while section 4 gives Managers the permission for their team | |
| D87 | The QA scripts are test files in `backend/src/qa`, run by `npm test` and, on their own, by `npm run qa`. They are not separate `qa/*.mts` scripts (changed in Phase 10) | They need what the API tests already have: a throwaway database, the clock set by the test, a client that keeps cookies. As part of `npm test` they run every time and cannot fall behind the app | Scripts run by hand against a running server: they would need their own set-up, and nobody runs them |
| D88 | Each permission guard carries the name of the permission it checks. The sweep reads from the app itself which routes exist and what each declares, then checks role by role that the route does what it declares. A route that declares nothing must be on a list in the sweep, with the reason it is open to anyone signed in (added in Phase 10) | A list of routes written by hand in a test is out of date the day a route is added. Read from the app, a new route with no guard and no reason fails the suite | |
| D89 | The audit log has one route and it reads. The page narrows by part of the HRMS (worked out from the action's name), by who did it, by whom it concerns, by date on the company's clock and by words; fifty lines a page, newest first. "Who did it" is the name recorded at the time; "about" is the person's name today. No download, no clean-up (added in Phase 10) | Section 10 asked for "the log, filtered and paged". An audit log that the app can change is not one | |
| D90 | How many proxies to believe about the visitor's address is a setting, `TRUST_PROXY`. It is 1 in development (the web app's dev server) and 0 everywhere else until set. It was fixed at 1 (changed in Phase 10, from the security review) | Reached directly, a server that believes one proxy believes the visitor: a forwarded-address header then names any address, and each new one started a fresh count of sign-in attempts and went into the audit log. With 0 behind a real proxy nothing breaks: everyone only appears to come from the proxy until the setting is made | |
| D91 | The limit on sign-in attempts also guards the current password asked for when changing it, counted per person (added in Phase 10, from the security review) | A session left open on a shared computer could otherwise be used to find the password by trying, and so turn a borrowed session into the account | |
| D92 | Two colour rules differ from the CRM's tokens. `--text-3`, the faintest text, is deeper in the light theme and lighter in the dark one. And words written in a tone (a badge, an avatar's initials, the red of an error, the amber of a warning) use that tone deepened towards the text colour, 65 parts to 35; fills, dots and tints keep the tone itself (changed in Phase 10, from the browser pass) | At the CRM's values the faintest text measured 2.9 to 4.0 against the backgrounds here, and tone-on-tint words 2.9 to 4.3 in the light theme. The brief asks for an accessible interface; 4.5 is the usual minimum for text this size | Darker tones everywhere: the fills and tints would lose the family look for no gain |
| D93 | The shell has a "Skip to the page" link as its first stop. On a phone the closed menu is hidden from the keyboard and from screen readers, and the open one takes the keyboard, keeps it and gives it back. Tabs are one component: the arrow keys, Home and End move between them and each is linked to what it shows. Every screen has one main heading (changed in Phase 10, from the browser pass) | Found by using the app with the keyboard alone: sixteen menu links before every page, a hidden menu that still took the Tab key, and tabs that were announced as tabs and did not behave as them | |
| D94 | An index for a list ends with the order the list is shown in, so a page is read from the index and the rest is not touched. The audit log's "who did it" choices are read as the distinct values of an index, and its "part of the HRMS" filter is asked as ranges of action names (changed in Phase 10, from the scale check) | With 20,000 lines, a page of the audit log read and sorted all of them, and its filter list alone took 0.7 s. After: 22 ms for the page | |

---

## 4. Roles and permissions

Four roles, in order of access: **Employee**, **Manager**, **HR**, **Admin**.

Everyone, whatever their role, has self-service over their own record: check in and out, see
their own attendance, calendar, schedule, leave balances, requests, holidays and
announcements. That needs no permission; it is tied to the signed-in person on the server
(the API takes "me" from the session, never from the request).

| Permission | Employee | Manager | HR | Admin |
|---|:-:|:-:|:-:|:-:|
| `team.view` See the attendance, calendar, leave and requests of their reports | | ✓ | | |
| `team.approve` Approve or reject leave and corrections of their reports | | ✓ | | |
| `employees.viewAll` See every employee and their records | | | ✓ | ✓ |
| `employees.manage` Add, edit, activate, deactivate; assign department, manager; reset passwords | | | ✓ | ✓ |
| `roles.assign` Give or remove the Employee and Manager roles | | | ✓ | ✓ |
| `roles.assignPrivileged` Give or remove the HR and Admin roles; change an HR or Admin account | | | | ✓ |
| `schedules.manage` Standard schedules; assign and customise per employee | | | ✓ | ✓ |
| `holidays.manage` Holiday calendars and holidays | | | ✓ | ✓ |
| `leave.configure` Leave types, policies, balance adjustments | | | ✓ | ✓ |
| `requests.approveAll` Approve or reject anyone's leave and corrections | | | ✓ | ✓ |
| `attendance.edit` Correct someone's attendance directly, with a reason | | | ✓ | ✓ |
| `announcements.manage` Create, edit, pin, delete announcements | | | ✓ | ✓ |
| `reports.view` Reports and attendance records (Managers: their reports only) | | ✓ | ✓ | ✓ |
| `reports.export` Download CSV (same scope as `reports.view`) | | ✓ | ✓ | ✓ |
| `settings.manage` Company name, time zone, leave year, defaults | | | | ✓ |
| `audit.view` The audit log | | | | ✓ |

**Scope**, enforced on the server for every read and write:

- **Self**: always.
- **Team**: a Manager reaches the people whose manager chain leads to them, worked out from
  `managerId` by one shared function. The chain passes through a manager who has been
  deactivated, so nobody falls out of sight while they wait for a new manager.
- **All**: HR and Admin.
- Asking for a person outside your scope is answered **404, as if they did not exist**
  (the CRM's rule), so ids cannot be probed.

**Guards that go beyond the table:**

- **Your own record (D13).** Every HR write names the employees it touches, and the caller
  is never one of them: adjustments, assignments (a bulk action skips the caller and says
  so), corrections, notes, role, status, manager. Checked in one place.
- **Requests from HR and Admin** are decided only by another HR or Admin, never through a
  manager chain. This closes the path of making a second account your own manager.
- Only an Admin changes an HR or Admin account or grants those roles.
- Only someone who holds Manager, HR or Admin can be named as a manager. A Manager who still
  has reports cannot be made an Employee until the reports are moved. Nobody is their own
  manager, directly or in a loop.
- **The last active Admin cannot be deactivated or demoted**, even when two Admins try it on
  each other at the same instant (5.3).
- Deactivating someone ends their sessions at once.

---

## 5. Database design

MongoDB, database `delta_hrms`. Ids are `prefix_xxxxxxxxxxxx`, made on the server from
`crypto.randomBytes`. Moments are ISO-8601 UTC strings (the house convention; they sort
correctly as text). Days are `YYYY-MM-DD` strings.

### 5.1 Collections

| Collection | One document is | Main fields |
|---|---|---|
| `meta` | A single setting | `company` (name, timeZone, weekStartsOn, leaveYearStartMonth), `holidays` (which calendar is the company default, D37), `leave` (which leave policy new people are put on, D62), `admins` (the ids of the active Admins: the guard for "never the last one"), `counters` (next employee code) |
| `employees` | A person and their account | `id`, `code` (EMP-0001), `name`, `email`, `phone`, `role`, `departmentId`, `designation`, `managerId`, `joinDate`, `employment[]` (`from`, `to`: the periods attendance counts for), `status` (invited, active, inactive), `leavePolicyId`, `passwordHash` (never leaves the server), `mustChangePassword`, `createdAt`, `updatedAt`, `lastLoginAt` |
| `sessions` | A signed-in browser | `_id` (hash of the cookie token), `employeeId`, `createdAt`, `expiresAt` |
| `departments` | A department | `id`, `name`, `nameKey`, `createdAt` |
| `schedules` | A standard schedule that can be assigned | `id`, `name`, `nameKey`, `rules` (section 6.1), `archived`, `createdAt`, `updatedAt` |
| `schedule_assignments` | The rules one employee works under from a date. Never edited once started | `id`, `employeeId`, `effectiveFrom`, `scheduleId` (or null when custom), `rules` (**a frozen copy**), `holidayCalendarId`, `note`, `createdBy`, `createdAt` |
| `attendance_days` | The facts of one employee's one working day | `_id` = `employeeId\|date`, `employeeId`, `date`, `assignmentId`, `checkInAt`, `checkOutAt`, `breaks[]` (`startAt`, `endAt`), `override` (a status set by an approved correction), `lateExcused`, `note` (HR's), `history[]` (every change: `at`, `by`, `kind`, `before`, `after`, `requestId`, `reason`, `ip`, `userAgent`), `version`, `createdAt`, `updatedAt`. **No status is stored** (D6) |
| `holiday_calendars` | A named set of holidays | `id`, `name`, `nameKey`, `createdAt` |
| `holidays` | One holiday or special working day | `id`, `calendarId`, `date`, `name`, `type` (public, company, optional, special_working_day), `description`, `createdBy`, `createdAt`, `updatedAt` |
| `leave_types` | A kind of leave | `id`, `name`, `nameKey`, `code`, `paid`, `allowHalfDay`, `tone`, `archived`, `createdAt`, `updatedAt` |
| `leave_policies` | A set of leave rules | `id`, `name`, `nameKey`, `approver` (manager, hr), `entries[]`, one per kind of leave: `leaveTypeId`, `annualDays`, `prorateFirstYear`, `carryForwardMax`, `eligibleAfterDays`, `maxConsecutiveDays`, `minNoticeDays`, `backdateDays`, `allowNegative` (section 7.1); `createdAt`, `updatedAt` |
| `leave_accounts` | One employee's leave for one leave year | `_id` = `employeeId\|leaveYear`, `employeeId`, `leaveYear`, `entries[]` (credits and debits: `kind` grant, carry_forward or adjustment, `leaveTypeId`, `days`, `note`, `by`, `byName`, `at`), `bookings[]` (one per live request: `requestId`, `leaveTypeId`, `startDate`, `endDate`, `dayPart`, `days`, `state` held or taken), `carried` (D55), `version`, `createdAt`, `updatedAt` |
| `leave_requests` | A request for time off | `id`, `employeeId`, `leaveTypeId`, `leaveYear`, `startDate`, `endDate`, `dayPart` (full, first_half, second_half), `days`, `charged[]` (which dates were counted, as known when sent), `reason`, `approver` (D59), `status` (submitting, pending, approved, rejected, cancelled), `settled`, `submittedAt`, `decidedBy`, `decidedByName`, `decidedAt`, `decisionNote` |
| `regularization_requests` | A request to correct a day | `id`, `employeeId`, `date`, `type` (8 kinds, section 8), `original` (a copy of the day as it was), `requested` (checkInAt, checkOutAt, status), `reason`, `status`, `settled`, `submittedAt`, `decidedBy`, `decidedAt`, `decisionNote` |
| `announcements` | An announcement | `id`, `title`, `body` (plain text), `importance` (normal, important), `pinned`, `startsAt`, `expiresAt`, `audience` (all, or departments, or roles), `revisedAt` (when its text last changed, D70), `createdBy`, `createdByName`, `createdAt`, `updatedAt` |
| `announcement_reads` | "This person has read this" | `_id` = `announcementId\|employeeId`, `announcementId`, `employeeId`, `readAt` |
| `audit` | One HR or admin action. Append-only | `id`, `at`, `actor` (id, name, role: a snapshot), `action`, `targetType`, `targetId`, `employeeId`, `summary`, `before`, `after`, `selfAdministered`, `ip` |

### 5.2 Constraints and indexes

| Collection | Index | Guarantees or serves |
|---|---|---|
| `employees` | `email` unique; `code` unique | One account per email; one code per person; first-run setup can only succeed once (it inserts `EMP-0001`) |
| | `managerId`; `departmentId`; `status` | Team scope, filters |
| `sessions` | `expiresAt` TTL; `employeeId` | Sessions expire by themselves; sign someone out everywhere |
| `departments`, `schedules`, `holiday_calendars`, `leave_policies` | `nameKey` unique | No two with the same name (ignoring case and spaces) |
| `schedule_assignments` | `employeeId + effectiveFrom` unique | One set of rules per person per start date; "the rules on date D" is one indexed lookup |
| `attendance_days` | `_id` = `employeeId\|date` | **One document per person per day, whatever happens** |
| | `employeeId + date`; `date` | Calendar; daily dashboard and records |
| `holidays` | `calendarId + date` unique; `date` | One holiday per calendar per day |
| `leave_types` | `code` unique; `nameKey` unique | No two kinds with the same code or name |
| `leave_accounts` | `_id` = `employeeId\|leaveYear` | **The one document every balance and overlap check goes through** |
| | `employeeId + leaveYear` | A person's accounts in order: last year's is what is carried forward from |
| `leave_requests` | `employeeId + startDate`; `employeeId + submittedAt`; `status + submittedAt`; `status + startDate + endDate` | A person's leave by date and newest first; the approvals inbox; "who is on leave on day D" |
| `employees` | `leavePolicyId` | Who is on a policy |
| `regularization_requests` | `employeeId + date` unique while `status` is pending | One open correction per day |
| | `status + submittedAt`; `employeeId + date` | Inbox; history |
| `announcements` | `startsAt`; `expiresAt` | What is showing now; the manage list, newest first |
| `announcement_reads` | `_id` = `announcementId\|employeeId`; `announcementId`; `employeeId` | One mark per person per announcement; who has read one; what a person has read |
| `audit` | `at`; `employeeId + at`; `action + at` | The audit log and its filters |

Zod checks the shape of everything written. MongoDB's unique keys and conditional updates
are the last line for the rules that must hold when two requests arrive together.

### 5.3 Changes that must not go wrong when two things happen at once

There are no transactions (D7), so the design gives each fact **one document that owns it**
and makes every change to it a single write.

| Change | How it is one safe write |
|---|---|
| Check-in | One conditional insert-or-update of the day: it goes through only if the day has no check-in yet. A second check-in, or two at the same instant, finds one already there and is refused. (An insert alone would be wrong: a day document may already exist because HR left a note on it.) The same write adds the history row |
| Check-out, break start, break end | One conditional update (for check-out: only while there is no check-out), with its history row |
| Leave: balance, overlap and holding the days | One versioned write to the employee's leave account: it adds the booking only if the dates overlap no other booking and enough days are available, and only if nobody else wrote the account in between (otherwise it is worked out again) |
| Adjust a balance, grant a year's allowance | One versioned write to the same account |
| Correct a day | One update of the day that sets the corrected values and adds a history row carrying the request's id. It cannot apply twice: it skips a day whose history already has that request |
| Deactivate or demote an Admin | One conditional removal from `meta.admins` that fails if it would empty the list. The employee record is changed only after it succeeds. `meta.admins` is rebuilt from the employee records on start-up |
| First-run setup | One insert of the employee `EMP-0001`. A second setup, or two at once, hits the unique code |

**Where two documents are involved** (a request and the thing it changes), the request's
status is the truth and the other document is made to match it:

1. A decision is a conditional update of the request (`pending → approved`, and so on) that
   only one caller can win. The same write marks the request `settled: false`.
2. **Settle**: make the other document match the request's status. For leave: approved →
   the booking is `taken`; pending → `held`; rejected or cancelled → the booking is removed.
   For a correction: approved → the day carries the correction. Settling the same request
   twice changes nothing the second time.
3. Mark the request `settled: true`.

If the server stops between 1 and 3, the request is still marked unsettled. Settle runs again
on start-up and whenever an unsettled request is read. Because settle looks only at the
request's current status, it gives the right answer whatever happened in between, including
a cancel that arrives in the middle of an approval.

**Sending a leave request** is the one chain that starts without a request: the request is
inserted first with the status `submitting` (shown to nobody), then the account write holds
the days, then it becomes `pending`. A `submitting` request left behind by a crash is
finished if its booking is in the account, and deleted if not.

---

## 6. Work schedules and attendance rules

Nothing in this section is a constant in the code. Every number is a field of the rules
assigned to the employee.

### 6.1 The rules an employee works under

```
ScheduleRules
  name                 "General 9 to 6"                      the shift name
  kind                 fixed | flexible
  timeZone             IANA zone, defaults to the company's   e.g. Asia/Kolkata
  standard             the hours of a normal working day:
                         start, end          HH:mm (fixed only; end before start = overnight shift)
                         requiredMinutes     the hours expected
                         fullDayMinutes      worked time needed for a full day
                         halfDayMinutes      worked time needed for half a day
  days                 for each of Mon..Sun: off | standard | its own hours (the same five fields)
  break
    mode               none | fixed | tracked
    minutes            the break allowance
    appliesAfter       the allowance is taken from time beyond this many minutes
  lateGraceMinutes     fixed only
  earlyCheckInMinutes  fixed only: how long before the start time check-in opens
  earlyLeave           tracked: yes/no, graceMinutes
  missingCheckOut      closeAfterMinutes (how long after check-in a day can still be closed),
                       countsAs: unresolved | half_day | absent
  offDayWork           allowed | blocked    (checking in on a weekly off or holiday)
  corrections          windowDays (how far back an employee may ask), maxPerMonth (or no limit)
```

Checks when rules are saved: at least one working day; `0 < half ≤ full ≤ required`; for a
fixed day, required plus a fixed break fits between start and end; grace and break are not
negative; the time zone is real. The zone is stored in the copy itself, so changing the
company's default zone later moves nobody's history.

How the brief's words map onto these fields: *required working hours* = `requiredMinutes`;
*full-day threshold* = `fullDayMinutes`; *half-day threshold* and *minimum working hours* =
`halfDayMinutes` (below it the day does not count); *break duration* and *break policy* =
`break`; *late calculation rules* = `lateGraceMinutes`; *early departure rules* =
`earlyLeave`; *missing checkout handling* = `missingCheckOut`; *weekly offs* and *working
days* = `days`; *shift name* = `name`; *effective date* = the assignment's start date.

**Why the full-day threshold is separate from the required hours.** With both at 8 h on a
09:00 to 18:00 shift, someone who arrives at 09:10 (inside the grace, so not late) and leaves
at 18:00 has worked 7 h 50 and would be marked half-day. The form therefore suggests a
full-day threshold a little under the required hours and shows, in words, what the numbers
mean ("arriving by 09:10 and leaving at 18:00 counts as a full day").

The brief's three examples:

| | Kind | Hours | Break | Weekly off | Grace | Required / full / half |
|---|---|---|---|---|---|---|
| Employee A | fixed | 09:00 to 18:00 | 60 min, fixed | Sunday | 10 min | 8 h / 7 h 30 / 4 h |
| Employee B | fixed | 10:00 to 19:00 | 60 min, fixed | Friday | 5 min | 8 h / 7 h 30 / 4 h |
| Employee C | flexible | any time | tracked | custom week (e.g. Mon to Thu 8 h, Fri 4 h, Sat and Sun off) | none | per day |

### 6.2 Assigning rules, and why history cannot change

- A **standard schedule** is a named set of rules HR can assign to many people.
- An **assignment** gives one employee a set of rules **from a date**. It stores a full copy
  of the rules as they were at that moment, and names a holiday calendar (or none). A custom
  schedule is simply an assignment whose copy was edited for that person.
- The rules for an employee on a date are those of the latest assignment that starts on or
  before it. That list of assignments is the schedule history shown to HR.
- **Nothing is back-dated.** A person's first assignment starts on the day HR picks, today
  at the earliest. Every later one starts tomorrow or later (in that employee's time zone),
  so the rules never change under a day that has already begun. A planned assignment can be
  replaced or cancelled until its start date arrives; after that it is history and is never
  edited or deleted.
- **Attendance counts only inside a person's employment periods.** The first period opens
  with their first assignment; deactivating them closes it on the last working day HR gives;
  reactivating them opens a new one. Days outside every period are "not applicable". So
  adding someone who joined in 2019 does not produce years of absences, and someone who has
  left does not collect them for ever. `joinDate` is a fact about the person (used for leave
  eligibility), not the start of attendance.
- Editing a standard schedule changes nobody. HR is then asked whether to apply the new
  rules to the people on it **from a chosen date**, which creates new assignments.
- Each attendance day records the assignment it belongs to and is always read with it.
- If someone was on the wrong rules, the affected days are fixed one by one through
  corrections (section 8), which keep the original.

Together these mean an edit can only ever affect the future. What can still alter how a past
day reads is listed, with its safeguards, in 6.7.

### 6.3 Calculating a day that has a punch

Given the check-in, check-out, breaks, the rules for that date, and the leave units already
approved for it (0, ½ or 1):

0. **Whole minutes.** Each punch is stored exactly and cut to the minute before any
   arithmetic (09:10:59 is 09:10), so what the screen shows is what is calculated.
1. **Gross** = check-out − check-in.
2. **Break deducted**:
   - `none`: 0.
   - `fixed`: the part of the allowance that fits after `appliesAfter`: nothing up to
     `appliesAfter`, then minute for minute up to the allowance. (Taking the whole break the
     moment a line is crossed would mean staying one minute longer could turn a half-day
     into an absence. This way worked time never goes down by staying.)
   - `tracked`: the breaks actually taken (one still open at check-out ends then), or what
     `fixed` would deduct, whichever is more. So never pressing Break gains nothing. An
     allowance of 0 means exactly the breaks taken.
3. **Worked** = gross − break deducted, never below 0.
4. **Work units**, out of what is owed that day (1 − leave units):
   - a whole day owed: worked ≥ `fullDayMinutes` → 1; else ≥ `halfDayMinutes` → ½; else 0;
   - half a day owed (half-day leave): worked ≥ `halfDayMinutes` → ½; else 0;
   - nothing owed (full-day leave): 0.
5. **Status**: 1 → Present; ½ → Half-day; 0 → Absent (the hours worked are still shown).
6. **Flags** (any number, alongside the status):
   - `late`: fixed schedules, check-in later than start + grace (exactly at start + grace is
     on time). Late minutes are counted from the start time. Not judged when leave covers
     the first half of the day.
   - `early_departure`: when tracked, check-out earlier than end − grace. Not judged when
     leave covers the second half.
   - `short_hours`: worked less than `requiredMinutes`.
   - `worked_on_off_day`: the punch is on a weekly off or holiday.
   - `worked_on_leave`: the punch is on a day of approved full-day leave (for HR to resolve;
     the day still counts as leave).
   - `late_excused`, `corrected`, `pending_correction`: from the correction workflow.

So a day can be **Present and Late**, or **Half-day and Early departure**, and so on.

Worked examples (Employee A: 09:00 to 18:00; break 60 min fixed, taken from time beyond 5 h;
grace 10; required 8 h, full day 7 h 30, half day 4 h; early departure tracked; a day can be
closed up to 16 h after check-in):

| In | Out | Gross | Break | Worked | Result |
|---|---|---|---|---|---|
| 09:10 | 18:00 | 8 h 50 | 60 | 7 h 50 | Present, short hours (10 min under the required 8 h). Not late: 09:10 is inside the grace |
| 09:11 | 18:30 | 9 h 19 | 60 | 8 h 19 | Present, Late (11 min) |
| 09:00 | 16:00 | 7 h 00 | 60 | 6 h 00 | Half-day, Early departure, short hours |
| 09:00 | 14:20 | 5 h 20 | 20 | 5 h 00 | Half-day, Early departure, short hours |
| 09:00 | 13:30 | 4 h 30 | 0 | 4 h 30 | Half-day, Early departure, short hours |
| 09:00 | 11:00 | 2 h 00 | 0 | 2 h 00 | Absent (2 h shown), Early departure, short hours |
| 09:00 | none | | | | Working until 01:00 the next day, then Unresolved (missing check-out) |

Employee C (flexible, Monday needs 8 h, no allowance): in 11:20, out 20:05, breaks taken
45 min → worked 8 h 00 → Present. Never late: a flexible schedule has no start time.

### 6.4 Which day a punch belongs to

A punch belongs to a **shift**, not to whatever the calendar date happens to be.

- **Fixed schedules.** Every working date has a window. It opens `earlyCheckInMinutes`
  before that date's start time. It closes `closeAfterMinutes` after the start time, or when
  the next working date's window opens, whichever comes first. A check-in belongs to the
  date whose window it falls in.
- **Flexible schedules.** The window is the local calendar day.
- **A day off.** A check-in outside every window, on a date that is a weekly off or a
  holiday, belongs to that date as off-day work, when the rules allow it.
- **Anything else is refused**, saying when check-in opens.
- **One check-in per date** (D12). A second one for the same date is refused, including
  after a check-out.
- **Check-out closes the open day**, whatever the date has become, until `closeAfterMinutes`
  after the check-in or the opening of the next working day's window, whichever comes
  first. A flexible day ends at its local midnight (D25). After that the day is Unresolved,
  the next check-in is a new day, and the missing check-out is fixed by a correction.
- **While a day is open and can still be closed, no other day can be started** (D26).
- When the open day began on an earlier date, Home says so in words ("Still checked in since
  Monday 17:30") and offers two things, check out now or ask for a correction, instead of
  one unlabelled button.

Worked through (early check-in 3 h, close after 16 h):

| Shift | What happens | Belongs to |
|---|---|---|
| 09:00 to 18:00 | In Mon 09:00, out Tue 00:30 (worked late) | Monday; the day can be closed until Tue 01:00 |
| 09:00 to 18:00 | In Mon 17:30, forgotten; back at Tue 09:00 | Monday stopped being closable at Tue 06:00 and is Unresolved; Tuesday's check-in is Tuesday's |
| 09:00 to 18:00 | In Tue 05:30 | Refused: "Check-in for Tuesday opens at 06:00" |
| 22:00 to 06:00 | In Mon 21:50 | Monday (its window opened at 19:00). Not late |
| 22:00 to 06:00 | In Tue 00:30, nothing before | Monday, late by 2 h 30 |
| 22:00 to 06:00 | In Mon 22:00, out Tue 00:20, in again Tue 00:30 | Refused: Monday already has its check-in. Tuesday's window opens at Tue 19:00 |
| 00:00 to 08:00 | In Mon 23:55 | Tuesday (its window opened at Mon 21:00) |

### 6.5 Working out any calendar day

For an employee and a date, in this order:

1. Outside their employment periods, or before their first assignment → not applicable.
2. **Kind of day**: a special working day beats a holiday; a holiday (public or company) on
   the assignment's calendar beats the weekly pattern; otherwise the weekly pattern says
   working or weekly off. A special working day on a weekday that is normally off uses the
   `standard` hours. An **optional** holiday is shown but is a working day: someone who
   wants it takes leave.
3. **Leave units** (L) on a working day: an approved request covers every working day in its
   date range, 1 for a full day, ½ for a half-day request.
4. Then the status, and how the day is counted. Every working day that is over is one whole
   day to account for: **W** worked + **L** leave + **A** absent + **U** unresolved = 1.

| Situation | Shows as | W | L | A | U |
|---|---|:-:|:-:|:-:|:-:|
| Not applicable | blank | | | | |
| Holiday or weekly off, no punch | Holiday / Weekly off | not a working day | | | |
| Holiday or weekly off, with a punch | Holiday / Weekly off, the hours worked, `worked_on_off_day` | not a working day; the hours count in total time worked | | | |
| Full-day leave, no punch | Leave | 0 | 1 | 0 | 0 |
| Full-day leave, with a punch | Leave, the hours worked, `worked_on_leave` | 0 | 1 | 0 | 0 |
| Closed punch, no leave | Present / Half-day / Absent (6.3) | 1 / ½ / 0 | 0 | 0 / ½ / 1 | 0 |
| Closed punch, half-day leave | Half-day leave and Present for the other half / Absent for it | ½ / 0 | ½ | 0 / ½ | 0 |
| Punch open, still closable | Working (or On break) | not counted yet | | | |
| Punch open, no longer closable, `countsAs` unresolved | Unresolved: missing check-out | 0 | L | 0 | 1 − L |
| … `countsAs` half_day | Half-day, missing check-out | ½ | L | ½ − L | 0 |
| … `countsAs` absent | Absent, missing check-out | 0 | L | 1 − L | 0 |
| No punch, date in the future | Upcoming (approved leave shown) | not counted yet | | | |
| No punch, today, before start + grace | Not due yet | not counted yet | | | |
| No punch, today, after start + grace, shift not over | Not in | not counted yet | | | |
| No punch, day over, no leave | **Absent** | 0 | 0 | 1 | 0 |
| No punch, day over, half-day leave | Half-day leave, Absent for the other half | 0 | ½ | ½ | 0 |
| An approved correction set the status | That status, marked corrected | 1 or ½, never more than 1 − L | L | the rest | 0 |

The rows are read from the top: a full-day leave is always the Leave row, so in the three
"no longer closable" rows L is 0 or ½. Any row also carries `pending_correction` while a
correction request is open.

"Day over" is the shift's end for a fixed schedule (the next morning for an overnight one)
and local midnight for a flexible one. A flexible schedule has no start time, so its "today"
is Not due yet until midnight.

**The month's summary** is addition over those rows, and is the same wherever it appears:

- working days (those that are over), holidays, weekly offs;
- **present days**: days with W = 1; **half-days**: days with W = ½;
- **leave days**: the sum of L, paid and unpaid apart;
- **absent days**: the sum of A (so a half-day adds ½, as is usual);
- **unresolved days**: the sum of U, shown so that HR chases them, and so that checking in
  and never checking out is not a way to avoid an absence;
- late entries, early departures, corrected days, total time worked.

It always holds that present + ½ × half-days + leave + absent + unresolved = working days.
A test checks this on generated months.

**What the employee's Home shows for today** is one of: no schedule yet, day off (weekly off
or holiday), on leave, not due yet, not in, working, on break, checked out, still checked in
from an earlier day, each with "correction pending" when one is.

**HR dashboard today** uses the same statuses: "Absent today" is Not in plus Absent.

### 6.6 Time and time zones

- **The server's clock is the only clock.** Check-in and check-out requests carry no time.
  The API reads one clock module (`clock.now()`), which the tests can set; the option to set
  it exists only when `NODE_ENV=test`.
- The browser's timer shows elapsed time from the server's "now" plus time measured by the
  browser's monotonic timer, so a wrong device clock changes nothing, not even the display.
- Moments are stored in UTC. A day is a date in the schedule's time zone (company zone by
  default), so "today", "late" and "which day" are right for an employee in another country.
  The HR dashboard for a date reads each person's day in their own zone.
- Conversions use the platform's `Intl` time-zone data, with no library. Local time to a
  moment handles clock changes: a time that does not exist moves forward; a time that occurs
  twice takes the first.
- The server's own time zone must never matter: `shared` and `backend` do not use local-time
  `Date` methods. A unit test scans the source to keep it that way.

### 6.7 What can still change how a past day reads

Status is worked out from facts (D6), so it is only as fixed as the facts. These are all the
ways a past day can read differently tomorrow, and what guards each:

| Change | Guard |
|---|---|
| A correction to the day | Approval by someone else; the original is kept in the day's history; audit entry |
| Leave approved or cancelled for a past date | The request and its decision are the record; audit entry |
| A holiday added, edited or deleted in the past | `holidays.manage`; a confirmation that counts the days and people affected and lists the leave requests touching that date; audit entry |
| An employment period's end date | Set when deactivating; changing it later is an Admin action with the same kind of confirmation and an audit entry |

Nothing else can: schedule rules, weekly offs, grace, thresholds, time zone and the choice of
holiday calendar are frozen in the assignment; assignments are never back-dated; a change of
manager or department changes who can see a day, not what it says (D14).

### 6.8 What is deliberately not automatic

No salary deduction, no "three lates make a half-day", no loss of pay. Attendance decides a
status and flags. A payroll feature would be a separate, explicitly authorised piece of work.

---

## 7. Leave

### 7.1 Configuration

- **Leave types** (Casual, Sick, Earned, Unpaid, …): name, code, paid or unpaid, whether
  half-days are allowed.
- **Leave policies**: a named set with one entry per leave type: annual allowance in days;
  whether a joiner's first year is pro-rated; how many unused days are carried forward at
  most (0: none); eligible after N days of service; the longest run of working days;
  minimum notice in days, or how many days back it may start (D56); whether the balance
  may go negative. Plus who approves: the employee's manager (HR and Admin can always act),
  or HR only.
- Each employee is assigned one policy; new people are put on the company's default one
  (D62). The leave year starts in the month set for the company (January by default). That
  month cannot be changed once any leave has been granted (D66).
- A kind of leave is archived, not deleted, and its being paid or unpaid is fixed once it
  has been asked for (D63).
- Editing a policy or moving someone to another policy changes what is granted from then on.
  Days already granted or taken stay as they are; HR corrects a current balance with an
  adjustment, which carries a reason.

### 7.2 Balances

One account per employee per leave year (D8) holds two lists:

- **entries**: the year's `grant`, the `carry_forward` from last year, and HR's `adjustment`s
  (each with who, when and why);
- **bookings**: one per live request, `held` while it is pending and `taken` once approved.

**Balance** = entries − taken. **Available** = balance − held. Nothing is stored as a total.

- The year's grant is owed to the account from the start, for each kind of leave in the
  person's policy, and is made once: a policy edited later changes what is granted from then
  on. It is shown whenever the account is read and written with the first change to it; the
  current year's account is opened when someone is put on a policy (D54). A request made
  ahead for next year opens next year's account with its grant.
- The carry-forward is owed **from the first day of its year**, from what is available in
  the old year (what waiting requests hold is not carried), up to the policy's maximum. Not
  before: otherwise days carried forward in November could still be spent in December. It is
  made once, and only from a year for which leave was already kept (D55).
- A year that is over is closed: no request and no adjustment (D57).

### 7.3 Requests

- The employee picks a type, dates and (for a single date) full day, first half or second
  half, with a reason. The API counts the days: **only that employee's working days**, by
  their own schedule and holiday calendar as they stand at that moment. Weekly offs and
  holidays inside the range are not charged. The count and the dates behind it are stored
  with the request and do not change.
- Checking the dates against other requests, checking the balance and holding the days is
  **one write to the account** (5.3). Two requests sent at the same instant cannot both pass.
- Refused when: the dates overlap another pending or approved request (two different halves
  of one day are fine); the range crosses the leave year (D15); no working day is in the
  range; the type is not in their policy or not allowed as a half-day; they are not yet
  eligible; notice is too short, or it starts further back than the policy allows; the run
  is too long, counting leave of the same kind right next to it (D58); the leave year is
  over or more than one ahead (D57); not enough is available (unless the entry allows
  negative, or the type is unpaid).
- **Approve or reject**: the manager chain or HR, per the policy; requests from HR and Admin
  only by another HR or Admin (section 4). A rejection needs a comment. The days were held
  when the request was sent, so approving cannot overdraw. Never by the requester.
- **Cancel**: the employee, while pending, or after approval until the first day. From then
  on only HR can cancel it, with a reason; HR rejects, rather than cancels, a request that
  is still waiting (D60). Cancelling removes the booking; the days are simply available
  again.
- **In the calendar, an approved request covers every working day in its range**, whatever
  was counted when it was sent. If a holiday is later moved or a schedule changes inside the
  range, no day is left reading Absent in the middle of approved leave. The days charged
  stay as they were; whoever makes that change is shown the requests it touches so HR can
  adjust the balance by hand.

---

## 8. Attendance corrections (regularization)

Request types: missing check-in, missing check-out, incorrect check-in, incorrect check-out,
forgot attendance (both), late entry explanation, half-day correction, absent correction.

| Type | The employee gives | When approved |
|---|---|---|
| Missing / incorrect check-in or check-out, forgot attendance | The time(s) it should have been | Those times are set on the day; its status follows from them by the day's own rules |
| Late entry explanation | A reason | The day stays late and gains `late_excused`. Times do not change |
| Half-day correction, absent correction | The status it should be (present or half-day), and a reason | The status is overridden; the punches stay as they were |

- Limits come from the employee's rules: how far back, and how many per month. Requested
  times must fall inside that day's shift window, in order, and not in the future.
- The request stores a copy of the day as it was when sent. The approver sees the day as it
  is **now** next to what is asked. If the day has changed since they opened it, the approval
  is refused and they are shown the new state.
- **The original is never lost.** A correction is one write to the day that sets the new
  values and adds a history row with before, after, who, when, why and the request's id
  (5.3). The first row's "before" is the original punch, and no route edits or removes history.
- Approvers: the manager chain, HR, Admin; for HR's and Admin's own requests another HR or
  Admin. Never the requester. A rejection needs a comment.
- HR can also correct a day directly (`attendance.edit`), or leave a note on it, with a
  reason. Both go through the same write and the same history. Never on their own record.
- Every decision and every direct edit is also an audit entry.

---

## 9. Holidays, announcements, audit

**Holidays.** Holiday calendars hold dated holidays of four kinds: public, company, optional,
and special working day (a weekly off that is worked). A calendar can be copied into the next
year for review. One calendar is the company default, which only means it is preselected: an
assignment names the calendar it uses, so the choice is dated like the schedule, and a
calendar can be given to one person, to many, or to a whole department at once. *Employee-
specific holidays* are done that way (a calendar of their own); a one-off personal day off is
leave granted by HR. Changing the past is guarded as in 6.7.

**Announcements.** Title, plain-text body (shown as text, so nothing in it can run),
importance, pinned, start and expiry, audience (everyone, chosen departments or chosen roles).
Employees see what is live for them, pinned first, then important, then the newest, with an
unread mark that clears when opened and returns when the text changes (D70). Whether one is
live is the server's clock; whether it is for someone is their record as it is now, by list
and by id alike (D71). The two times are typed on the company's clock (D72).

**Audit log.** Every HR or admin action writes one row: who (a snapshot of name and role),
when, what, on whom, before and after. There is no route that edits or deletes it. Covered:
employees (create, edit, role, status, manager, password reset), schedules and assignments,
holidays, leave configuration, balance adjustments, every approval, rejection and
cancellation by HR, direct attendance edits and notes, announcements, company settings.

---

## 10. API plan

All under `/api`. Every route: Zod-checked input (unknown fields refused), a session unless
marked public, a permission and a scope check on the server, the own-record guard on HR
writes, the one JSON error shape `{ error, fields? }`. Lists are paged. "Scoped" means the
result is cut to who the caller may see.

| Area | Route | Who | Does |
|---|---|---|---|
| Public | `GET /health` | anyone | API and database up |
| | `GET /meta` | anyone | Whether first-run setup is needed |
| | `POST /setup` | anyone, once; in production only with the setup code from the server's settings | Creates the first Admin and the company. Refused for ever after |
| | `POST /auth/login`, `POST /auth/logout` | anyone | Session cookie; throttled |
| Me | `GET /me` | signed in | Own record with department and manager names, role, permissions, company settings, server time, counts (approvals waiting, unread announcements) |
| | `PATCH /me/profile`, `POST /me/password` | signed in | Own phone; change password (ends other sessions) |
| Employees | `GET /employees` | scoped | Search, filter by department, manager, status, role |
| | `POST /employees`, `PATCH /employees/:id` | `employees.manage` | Create (with a first schedule), edit; role changes need `roles.assign` or `roles.assignPrivileged` |
| | `GET /employees/:id` | scoped | Profile with current schedule, policy, calendar |
| | `POST /employees/:id/status`, `…/reset-password` | `employees.manage` | Activate or deactivate (with the last working day); new temporary password |
| | `GET /departments` | signed in | Names, for filters and forms |
| | `POST /departments`, `PATCH/DELETE /departments/:id` | `employees.manage` | Departments (delete only when empty) |
| Schedules | `GET/POST /schedules`, `GET/PATCH /schedules/:id`, `POST /schedules/:id/archive` | `schedules.manage` | Standard schedules |
| | `GET /employees/:id/schedule` | self or scoped | Current rules and full history |
| | `POST /schedule-assignments` | `schedules.manage` | One or many employees, standard or custom rules, calendar, start date |
| | `DELETE /schedule-assignments/:id` | `schedules.manage` | Only a planned one that has not started |
| Attendance | `GET /attendance/today` | signed in | Own state for today, with server time |
| | `POST /attendance/check-in`, `/check-out`, `/break/start`, `/break/end` | signed in | Nothing in the body: no time, no date, no person. Answers with today's state (D28) |
| | `GET /attendance/calendar?employeeId&month` | self or scoped | Every day of the month worked out, plus the month's summary. With no employee it is the caller's; with no month, the month today falls in |
| | `GET /attendance/days/:employeeId/:date` | self or scoped | One day in detail, with its history |
| | `GET /attendance/records?from&to&departmentId&managerId&employeeId&status&flag&page` | `reports.view`, scoped | Days that match, newest first, with how often each person was late (D80). `format=csv` needs `reports.export` and sends every matching row |
| | `POST /attendance/days/:employeeId/:date/correct` | `attendance.edit` | Direct correction with a reason |
| | `PUT /attendance/days/:employeeId/:date/note` | `attendance.edit` | HR's note on a day, shown to the employee and their managers |
| Holidays | `GET/POST /holiday-calendars`, `GET/PATCH/DELETE /holiday-calendars/:id` | `holidays.manage` | Calendars, each with a year's holidays and the people on it (delete only when nobody was ever on it, D40) |
| | `POST /holiday-calendars/:id/default`, `…/:id/copy-year` | `holidays.manage` | Make it the company default (D37); copy a year into the next (D39) |
| | `POST /holiday-calendars/assign` | `holidays.manage` | Put one or many people on a calendar, or on none, from a date (D36). Answers with who was moved and who was not, and why |
| | `POST /holidays`, `PATCH/DELETE /holidays/:id` | `holidays.manage` | A change to a day that has begun is refused with its effect until confirmed (D38) |
| | `GET /holidays/mine?year` | signed in | Own holidays in a year, each from the calendar in force that day, and the next one (D41) |
| Leave | `GET /leave-types` | signed in | The kinds of leave, archived ones included |
| | `POST /leave-types`, `PATCH /leave-types/:id` | `leave.configure` | Create, edit, archive and restore (D63) |
| | `GET /leave-policies` | `leave.configure` | Everything the setup page shows: kinds, policies with who is on them, how many people are on none |
| | `POST /leave-policies`, `PATCH/DELETE /leave-policies/:id`, `POST /leave-policies/:id/default` | `leave.configure` | Create, edit, delete one nobody is on, make it the one new people are put on (D62) |
| | `POST /leave-policies/assign` | `leave.configure` | Put one or many people on a policy, or on none. Answers with who was moved and who was not, and why. Never the caller themself (D13) |
| | `GET /leave/balances?employeeId&year` | self or scoped | One leave year's account: each kind added up, the entries behind it, the years that can be looked at. Writes nothing (D54) |
| | `POST /leave/adjustments` | `leave.configure` | Add or remove days, with a reason. Never on one's own account (D13, D68) |
| | `GET /leave/requests?view=mine\|person\|inbox\|decided` | mine: signed in; person: scoped; the others: approvers | Own requests; one person's; those waiting for the caller, each with its effect on the balance; those already decided (D67) |
| | `POST /leave/requests/preview`, `POST /leave/requests` | signed in (own) | Count the days before sending; send. Neither takes an employee |
| | `POST /leave/requests/:id/cancel` | owner, within the rules; or `requests.approveAll` with a reason, for approved leave | Cancel (D60) |
| | `POST /leave/requests/:id/approve`, `/reject` | approvers (section 4), and the request's own `approver` (D59) | Decide. A rejection needs its reason |
| Corrections | `GET /regularizations?view=mine\|inbox\|decided` | mine: signed in; the others: approvers | Own requests; those waiting for the caller, each with the day as it is and as it would read; those already decided for the people the caller decides for |
| | `POST /regularizations`, `POST /regularizations/:id/cancel` | signed in (own) | Send; cancel while pending |
| | `POST /regularizations/:id/approve`, `/reject` | approvers (section 4) | Decide; approve names the version of the day the approver saw |
| Announcements | `GET /announcements` | signed in | What is showing for me now, pinned and important first, with how many are unread. Takes nothing from the request |
| | `GET /announcements/:id`, `POST /announcements/:id/read` | signed in | One announcement, and marking it read: only while it is showing and only if it is for me. Otherwise "not found" (D71) |
| | `GET /announcements/manage?page` | `announcements.manage` | Every announcement, newest first, with its state, who it is for, and how many of them have read it (D74) |
| | `POST /announcements`, `PATCH/DELETE /announcements/:id`, `POST /announcements/:id/pin` | `announcements.manage` | Post, change, take down for good, pin or unpin |
| Dashboards | `GET /dashboard/me` | signed in | Everything the employee home needs in one call: today, this month so far, the last seven days. Takes no input; any query is refused |
| | `GET /dashboard/hr?date&departmentId&managerId&filter&search&page` | `reports.view`, scoped | One day: how many people are in each group, the people behind the number asked for, what waits for the caller, the next holidays (D76 to D79) |
| Reports | `GET /reports/monthly?month&departmentId&managerId` | `reports.view`, scoped | A row per employee and a total (D81); `format=csv` needs `reports.export` |
| | `GET /reports/people` | `reports.view`, scoped | The people the caller's reports cover, for the forms that choose one |
| | `GET /reports/employee/:id?from&to` | self; or `reports.view`, scoped | A row per day and the stretch added up; `format=csv` for oneself, or with `reports.export` (D82) |
| Admin | `GET/PATCH /settings/company` | `settings.manage` | Company settings |
| | `GET /audit` | `audit.view` | The log, filtered and paged |

---

## 11. UI and UX plan

The CRM's design system: the same tokens, type, spacing, buttons, tables, modals and toasts,
so the two products feel like one family. Calm surfaces, no gradients, colour used for
status only.

**Navigation** (a sidebar that collapses, a drawer on phones). Only sections that exist are
shown; a section appears in the phase that builds it. There are no dead links at any point.

| Group | Item | Who |
|---|---|---|
| Me | Home, Attendance, Leave, Holidays, Announcements | everyone |
| Team | My team, Approvals (with a count) | Manager, HR, Admin |
| Organisation | Overview, Employees, Attendance records, Schedules, Leave setup, Holiday calendars, Announcements (manage), Reports | HR, Admin |
| Admin | Settings, Audit log | Admin |

**Pages**

| Page | What is on it |
|---|---|
| Sign in; first-run setup | Email and password; on an empty installation, company name, time zone and the first Admin |
| Home (employee dashboard) | Today's date; who I am (name, code, department, manager, shift); today's status with check-in and check-out times; the action button (Check in → Check out, with Break when enabled), a live timer of time worked and the break time taken; late status; this month in six numbers (present, absent, half-days, late, leave, hours); leave balances; upcoming holidays; recent days; my pending correction and leave requests; announcements. Each block is small and links to its page |
| Attendance | Month calendar with previous/next/today and a month and year picker, today marked; each day shows a status label with an icon, never colour alone; click a day for times, hours worked, flags, HR's note if any, history and "Ask for a correction". A list view of the same month. My late entries |
| Leave | Balances per type; "Request leave" (type, dates, day part, reason, with the day count and the balance after shown before sending); my requests with status and cancel |
| Holidays | The year's holidays for my calendar, next one highlighted |
| Announcements | Pinned and important first; unread marked |
| My team | My reports; from Phase 5 a person's calendar and leave; from Phase 9 each person's status today |
| Approvals | Two tabs, leave and corrections. Each request shows who, what, the day as it is now, the requested change, the balance effect; approve or reject with a comment |
| Overview (HR dashboard) | Total employees; present, absent, late, half-day, working now, on leave today; pending corrections and leave approvals; upcoming holidays. Filters: date, department, manager, employee, status. Every number opens the list behind it |
| Employees | Table with search and filters; add and edit; activate and deactivate; role, department, manager; reset password. A person's page: profile, schedule and history, leave policy, holiday calendar, attendance calendar, leave history |
| Schedules | Standard schedules; create and edit with a weekly table and a plain-words summary of what the numbers mean; assign to one or many with a start date; who is on each |
| Attendance records | Everyone's days with filters for late, half-day, early departure, unresolved; late frequency per person |
| Leave setup | Types, policies, each person's balances and adjustments |
| Holiday calendars | Calendars and their holidays by year; copy to next year; give a calendar to people |
| Reports | Monthly summary and employee report, filters, CSV download |
| Settings; Audit log | Company settings; the log with filters |
| Profile | My details, change password, theme |

**States and behaviour**

- Every list and page has a loading state (a skeleton, not a spinner over nothing), an empty
  state that says what to do next, and an error state with "Try again".
- Anything that cannot be undone asks first, naming what will happen.
- Forms: labels on every field, errors beside the field in words, the server's message shown
  as is, the submit button disabled while sending so nothing is sent twice.
- Status is always text + icon + colour, from one list in `shared` (so the calendar, tables,
  badges and CSV all use the same words): Present, Late, Half-day, Absent, Leave, Holiday,
  Weekly off, Unresolved, Working, Not in, Correction pending.
- Phones first for the employee pages (people check in from their phone): a large action
  button, tables become stacked rows, the calendar stays a grid with short labels and a day
  list beneath. HR tables scroll sideways inside their card, never the page.
- Keyboard: everything reachable; the calendar moves with arrow keys; dialogs trap focus and
  return it; results of check-in and approvals are announced to screen readers.
- Motion: short fades only, off under "reduce motion".
- No sample numbers anywhere. A block with no data says so.

---

## 12. Implementation phases

Each phase ends with: unit and API tests passing, type-check and build clean, the screens
checked in a browser at desktop and phone width as each role, this file updated, a short report.

### Phase 1: Foundation

- [x] Workspace: root `package.json`, `tsconfig.base.json`, `.gitignore`, `README.md`, optional `docker-compose.yml`
- [x] `shared`: ids, dates in a time zone, roles and permissions, scope ("who may see whom"), the own-record guard, API contract types
- [x] `backend`: config (no secret has a default), database connection with collections and indexes, clock, health check, security headers, same-origin guard, error handling
- [x] Sign-in, sign-out, sessions, scrypt passwords, sign-in throttle, change password, forced change of a temporary password
- [x] First-run setup: company name, time zone, first Admin; needs the setup code in production; closed for ever after
- [x] `authenticate` on every route by default, `requirePermission`, scope helpers, the last-Admin guard, audit service
- [x] `npm run seed` (development only): a sample company with one person per role, and a new joiner on a temporary password
- [x] `frontend`: design tokens and base styles, app shell with role-aware navigation, sign-in, setup, Home (date, profile summary, honest empty state), Profile, Settings (Admin: company)
- Tests: time-zone date maths (India's half-hour offset, Dubai, a zone with clock changes,
  midnight edges); permission table; scope function including manager chains, loops and a
  deactivated manager; own-record guard, with the sole-Admin exception; setup works once and
  only once, also when two arrive together, and not without the code in production; sign-in
  right and wrong, throttle, deactivated account; cookie flags; sign-out; every route answers
  401 without a session; 403 on an Admin route as each lower role; cross-site change refused;
  password change ends other sessions; no answer contains a password digest.
- Done when: all four roles can sign in and see a shell that differs correctly, and the API
  refuses what the shell hides.
- **Stop here for review.** Reached on 23 Nov 2026: see the report in section 15.

### Phase 2: Employees and work schedules

- [x] Departments
- [x] Employees: list with search, filters and paging; create (with a first schedule); edit; role; manager; activate and deactivate with employment periods; reset password
- [x] Employee page: profile and schedule history. "My team" for Managers: the same list, cut to their reports
- [x] Standard schedules: create, edit, archive; weekly table editor; validation; the plain-words summary
- [x] Assignments: one or many employees; standard or custom; start date; history; cancel a planned change; "apply this edit to the people on it from a date"
- Tests: rules validation; "rules on date D" across a history; the first assignment cannot
  start before today and a later one not before tomorrow; editing a standard schedule changes
  no assignment; bulk assign skips the caller; employee A, B and C from the brief resolve to
  their own rules; HR cannot grant Admin or touch an Admin; nobody changes their own role,
  status, manager or schedule; two Admins demoting each other at once leave one; a manager
  must hold a managing role; manager loop refused; a Manager sees only their chain; an
  Employee asking for another id gets 404; deactivation signs out and closes the period.

### Phase 3: Attendance engine

- [x] `shared/attendance`: calculate a punched day; which shift a punch belongs to; work out any calendar day; month summary. Holidays and leave are inputs from the start (empty until phases 5 and 7)
- [x] API: today's state, check-in, check-out, break start and end; the day record with its history
- Tests (the largest set in the project): normal day; duplicate check-in, also two at the
  same instant, also on a day that already has a note; check-out without check-in; double
  check-out; check-in with no schedule; missing check-out becoming Unresolved and each
  `countsAs`; late exactly at, one minute inside and one minute past the grace; seconds are
  cut to the minute; half-day and full-day thresholds at the boundary; fixed break below, on
  and past `appliesAfter`, and that worked time never falls as gross rises; tracked break
  shorter and longer than the allowance; no break; break open at check-out; flexible
  schedule; A, B and C judged by their own rules on the same clock; different weekly offs;
  every row of the table in 6.4; early departure; work on an off day, allowed and blocked;
  absent only once the day is over; nothing before the first assignment or outside an
  employment period; a time in the request body is refused; the unit identity on generated
  months; **a schedule change tomorrow leaves every earlier day reading exactly the same**;
  the company zone differs from the server's zone; a day in a zone with a clock change.

### Phase 4: Employee dashboard

- [x] `GET /dashboard/me`; Home with today's status, the action button, the live timer on server time, late status, this month's numbers, recent days
- [x] Blocks for holidays, corrections, leave and announcements are added by phases 5 to 8, not shown empty before
- Tests: the summary equals the engine's for the same data; the timer ignores the device
  clock; the button cannot send twice; every "today" state in 6.5, including still checked
  in from an earlier day.

### Phase 5: Attendance calendar and holidays

- [x] Holiday calendars and holidays (four kinds), copy to next year, company default, give a calendar to one, many or a department
- [x] Engine reads holidays; upcoming holidays on Home; Holidays page
- [x] Month calendar and list for me; for a Manager's reports and for HR on any employee; day details
- Tests: a holiday is not absent; a special working day beats a weekly off and uses the
  standard hours; an optional holiday stays a working day; two calendars give two employees
  different days; adding, editing or deleting a past holiday is confirmed with its effect
  and audited; calendar months at year and month edges; a Manager cannot open a calendar
  outside their chain.

### Phase 6: Corrections and approvals

- [x] Request a correction (eight types) from a day; my requests; cancel
- [x] Approvals inbox for corrections; approve and reject with a comment
- [x] Applying an approval in one write with its history row; HR direct correction; HR's note on a day
- Tests: each type; window and monthly limit; one open request per day; approve, reject,
  cancel; the original is still readable after two corrections in a row; the same approval
  sent twice, or by two approvers at once, applies once; an approval against a day that
  changed since it was opened is refused; a check-out arriving during an approval loses
  nothing; a stop between deciding and settling is finished on restart; nobody approves
  their own; HR's request cannot be approved through a manager account; a Manager cannot
  decide outside their chain; the calendar shows pending and corrected.

### Phase 7: Leave

- [x] Leave types and policies; assign a policy; accounts, balances, adjustments
- [x] Request with a preview of the days; my requests; cancel
- [x] Approvals inbox for leave; approve, reject, cancel by HR
- [x] Engine reads leave; calendar, Home and summaries show it
- [x] Whoever changes a holiday, a schedule or a holiday calendar is shown the leave it touches (D64)
- Tests: days counted by the employee's own schedule and holidays; half-days; overlap
  refused; two halves of one day allowed; **twenty identical requests at the same instant
  hold the days once**; two requests that together exceed the balance, sent together, pass
  one; pending days held; negative only where the policy says; eligibility, notice and
  maximum run; a range across the leave year refused; pro-rated first year; the year's
  grant made once; carry-forward capped and not before the year starts; a cancel arriving
  in the middle of an approval ends with the days free; a stop at each step of sending and
  deciding is finished on restart; HR cannot adjust their own balance; leave shows as Leave
  and never as Absent, also after a holiday inside it is moved; a half-day leave with a
  worked half; a punch on a leave day. **All of them pass** (section 15).

### Phase 8: Announcements

- [x] Manage: create, edit, delete, pin, importance, dates, audience
- [x] Read: list, pinned first, unread marks, on Home
- Tests: start and expiry respected on the server's clock; audience (everyone, departments,
  roles) decides who can fetch it, also by id; unread counts; text is shown as text. **All of
  them pass** (section 15).

### Phase 9: HR dashboard, records and reports

- [x] Overview with today's numbers and filters; every number opens its list
- [x] My team shows each person's status today
- [x] Attendance records with filters; late frequency
- [x] Monthly summary and employee report; CSV export (cells that start like a formula are made safe)
- Tests: every dashboard number equals the engine's count over the same people; filters;
  a Manager's numbers cover only their chain; the report equals the calendar's summary for
  each person; CSV content and escaping; a month for 500 people answers quickly. **All of
  them pass** (section 15).

### Phase 10: Final testing and polish

- [x] Audit log page
- [x] QA suite (`backend/src/qa`, D87): every route as every role; attack-style checks (other people's ids, changed roles in the body, own-record attempts, repeated and simultaneous requests)
- [x] Full browser pass: every page, every role, phone and desktop, light and dark, keyboard only
- [x] Security review against section 13; performance check with large sample data
- [x] README finished; this file brought up to date
- Tests: 34 QA checks on top of the phase tests. **All of them pass** (section 15). What the
  browser pass could not cover is listed there under "Not done, or not verified".

---

## 13. Testing, security, risks

### 13.1 Testing strategy

| Layer | With | Covers |
|---|---|---|
| Unit | Vitest on `shared` | Dates and time zones, schedule rules, the attendance engine, leave counting and balances, permissions and scope |
| API | Vitest against a real MongoDB, a throwaway database per run, the clock set by the test | Every route's happy path, validation, permission and scope, concurrency (the same request sent many times at once), chains stopped halfway |
| Browser | Each phase's screens, by hand, in the app's browser | What a person actually sees, at phone and desktop width, as each role |
| QA suite | `backend/src/qa/*.test.ts`, part of `npm test` and on its own as `npm run qa` (Phase 10, D87) | Role sweep, attack checks and a scale check over the whole API |

If MongoDB is not reachable the API tests cannot run. That is reported as **not run**, never
as passed.

### 13.2 Security and data integrity

- Authorisation on the server for every route: permission, then scope, then the own-record
  guard. One function decides each and every route uses it.
- "Me" always comes from the session. No route takes the caller's id from the request.
- Inputs: Zod, unknown fields refused, sizes limited, ids matched to a pattern, search text escaped.
- Sessions: httpOnly, SameSite=Lax, Secure in production, stored as a hash, 12 hours or 30
  days with "remember me" (a setting), ended on deactivation, password change and reset.
- Sign-in: scrypt, a constant-time path for unknown emails, throttled per address and email.
  The address is the connection's own unless the server is told how many proxies to believe
  (D90). The same limit guards the current password on a password change (D91).
- Cross-site requests refused by origin; strict content policy; no HTML from users is rendered.
- Attendance: server clock; one document per person per day; conditional writes; every
  change keeps what was there before.
- Errors: the caller sees a safe message; details go to the server log only.
- The rules drawn from the older CRM's security findings are in 1.4.

### 13.3 Risks and dependencies

| Risk | Effect | What is done about it |
|---|---|---|
| There is no existing app in this folder; the brief assumed one | The plan could be building the wrong thing in the wrong place | D1, stated up front, to confirm before Phase 1 |
| A Delta HRMS already exists elsewhere and other systems call it | Two HRMSs; or this one is expected to answer the old one's API (meeting rooms, wallet) and does not | Out of scope and said so (D1). Nothing here uses the old API's addresses, so adding it later does not collide |
| A second sign-in next to the CRM's | People have two accounts | Email is the key in both; single sign-on and an import are listed as later work |
| People in India and the UAE; the company's default time zone, leave year and week start are assumed | Wrong "today", wrong weekend, wrong leave year | Zone, weekly offs and holiday calendar are per schedule and per employee. The company defaults are asked at first-run setup (suggested: Asia/Kolkata, January, Monday). Confirm |
| MongoDB without transactions | Two requests at once, or a stop between two writes | D7 and 5.3: one owning document per fact, single writes, settle steps that can be repeated; each has a test that sends requests together or stops halfway |
| One server is assumed (the sign-in throttle is in memory), as in the CRM | Several servers would throttle separately | Documented; nothing about attendance or leave correctness depends on it (the database enforces those) |
| Overnight shifts, midnight, forgotten check-outs | A punch on the wrong day | Shift windows (6.4) with a worked table that becomes the test list |
| Status is worked out when asked | A report must give the same answer tomorrow | The facts behind it are append-only or guarded (6.7) |
| Changes to holidays or schedules after leave was booked | The days charged no longer match the calendar | The calendar always shows the whole range as leave; the person making the change sees the affected requests; HR adjusts by hand |
| Very new versions (Node 25 here, TypeScript 7, Vite 8, Express 5, Zod 4) | An API is not what memory says | Use exactly the CRM's versions and patterns, which run on this machine; check the docs rather than assume |
| No email | Temporary passwords are passed on by hand | Forced change at first sign-in |
| The brief is broad for a "basic" HRMS | Scope grows | Section 2.2 "Out" and the list below; each phase has a fixed checklist |
| The folder is not a git repository | No history, no way back | Recommend `git init` and one commit per phase; your call |

**Left for later** (each is a clean addition, none blocks v1): importing people from a file
(the first thing to add if there are many to enter); file attachments; a separate library of
attendance policies; an editor for what each role may do; monthly leave accrual; multi-step
approvals; a per-person notification feed; `.xlsx` export; single sign-on with the CRM;
two-step sign-in (TOTP, as the LMS and the website have); several check-ins per day; comp-off
for working a holiday; refunding leave automatically when a holiday lands inside it; a dated
history of managers and departments; location limits on check-in; the existing HRMS's
integration API (meeting rooms, wallet); Malayalam.

### 13.4 Questions to confirm

Answered on 23 Nov 2026 by approving the plan as written: 1 (a new, separate product) and 2
(the newest CRM's stack). Still open at the end of Phase 10, each with a working default in
place: 3 and 5.

Question 4 was answered on 24 Nov 2026: a git repository was started here on `main`, with a
GitHub repository as `origin`. Its first commit holds `README.md` only, as instructed. The
second holds everything else, published the same day on the owner's decision, with the
repository public: that includes this file, whose sections 1.3 to 1.5 describe other Delta
projects, and the development-only sample password in `backend/src/seed/demo.ts`. There is
one commit for the whole build, not one per phase, because the repository was started after
Phase 10.

1. **The existing Delta HRMS** (the one the older CRM calls): is this a new, separate
   product (the plan's assumption), a future replacement for it, or was the work meant to
   happen inside its repository?
2. **Stack**: the newest CRM's (Express, MongoDB, React with Vite: the plan's choice) or the
   LMS's (NestJS, PostgreSQL, Next.js)?
3. Company defaults: time zone Asia/Kolkata, leave year from January, week from Monday?
4. Start a git repository here, with a commit per phase?
5. Attachments on requests, and importing people from a file, left for later: acceptable?

---

## 14. Review log

The brief's workflow step 2: check the plan for missing features, architecture conflicts,
database design problems, security concerns, incorrect attendance rules and unnecessary
complexity, and revise it.

### Pass 1: against the brief, module by module (23 Nov 2026)

Every item of modules A to N, the UI, security and testing sections was looked up in the
plan. Changes made:

| Found | Changed |
|---|---|
| With the full-day threshold equal to the required hours, arriving inside the grace and leaving on time gave a half-day | The two are separate fields, the examples use 7 h 30, and the form explains the numbers in words (6.1) |
| The fixed break was deducted whole once a line was crossed: staying one minute longer could turn a half-day into an absence | Deducted minute for minute beyond `appliesAfter` (6.3) |
| A same-day schedule change could alter a day already begun | Later assignments start tomorrow or later (6.2) |
| Missing from the plan: break time on Home, today marked on the calendar, HR's note on a day, "holiday summary" in reports, who decides HR's own requests | Added (10, 11, 4) |
| The "house stack" was assumed to be one stack | The survey showed three; 1.2 and D2 now say why this one, and give the alternative |
| An existing Delta HRMS is called by the older CRM | 1.1, D1, risks and questions |

### Pass 2: an independent read of sections 4 to 10 (23 Nov 2026)

A second reviewer, given only this file, was asked to find rule errors, ways history could
still change, races without transactions, access holes and needless complexity. It reported
fifteen findings. All were accepted in substance:

| # | Finding | Changed |
|---|---|---|
| 1 | HR could alter their own record by routes other than approval: add leave days to themselves, give themselves lenient rules, or approve from a second account made their manager | D13 widened to every HR power; HR's and Admin's requests are decided only by another HR or Admin; a manager must hold a managing role (4) |
| 2 | Balance checks were read-then-write: two requests or two approvals at once could overdraw | One leave account document per employee per year; overlap, balance and holding the days are one write (D8, 5.3, 7) |
| 3 | The first visitor to a fresh production address became Admin; a stop mid-setup left no Admin; two Admins could demote each other at once | Setup code in production; setup is one insert; `meta.admins` guards the last Admin (5.3) |
| 4 | A first assignment from the joining date produced years of absences; people who left kept collecting them | Nothing is back-dated; employment periods (6.2) |
| 5 | Leave stored as frozen dates left a working day Absent inside approved leave when a holiday moved | An approved request covers its whole range in the calendar; the charge stays; the change shows the requests it touches (7.3) |
| 6 | A status stored at check-out went stale when leave was approved or a holiday added later | Only facts are stored; status is always worked out (D6) |
| 7 | The unit accounting did not add up for leave with a punch, unresolved days, overrides and half-days; a special working day had no hours | A units column for every row, an unresolved bucket, the identity stated and tested, `standard` hours (6.1, 6.5) |
| 8 | Attribution by calendar date misplaced overnight punches, early arrivals and forgotten check-outs | Shift windows, with the reviewer's cases as the worked table (6.4) |
| 9 | Leave chains could strand rows, or charge and never reverse when a cancel met an approval | Request first as `submitting`; the request's status is the truth; settle is repeatable (5.3) |
| 10 | The ledger's unique key could not hold a request across two years; carry-forward could be spent twice | One leave year per request (D15); carry-forward only once the year has begun (7.2) |
| 11 | A check-out could overwrite a just-approved correction; approval did not check what the approver saw; repair could duplicate log rows | No stored result to overwrite; approval names the version seen; correction and its history row are one write (5.3, 8) |
| 12 | Check-in as a plain insert failed on a day that already had a note | Conditional insert-or-update (5.3) |
| 13 | Seconds, the meaning of `short_hours`, and tracked breaks never pressed were unspecified | Whole minutes; one definition; tracked deducts at least the allowance (6.3) |
| 14 | Manager scope was unspecified for a deactivated manager and for transfers | Stated (4, D14) |
| 15 | Smaller contradictions: no way to revoke leave, departments unreadable to Managers, "My team" later than the calendars that need it, features in no checklist, two meanings of "absent today", a calendar reference that was not frozen | Cancel by HR; `GET /departments` for everyone; "My team" from Phase 2; checklists completed; one definition (6.5); the assignment names its calendar (6.2) |

Simplifications taken from the same review: no stored status or its index; no separate
attendance log or `original` field (the day's own history holds both); no `leave_days` or
`leave_ledger` collections (the account holds both); no personal-holiday records; import
from a file moved to later. Seventeen collections instead of the first draft's nineteen.

Not changed, deliberately: overnight shifts stay in (the same rule is needed anyway for a
day shift that checks out after midnight); the four roles stay fixed in code (D10).

---

## 15. Phase reports

### Phase 1: Foundation (23 Nov 2026)

**Built**

- The workspace: `shared`, `backend`, `frontend`, at the Sales CRM's exact package versions.
- `shared`: days and moments in a time zone (`dates.ts`), the four roles and sixteen
  permissions (`roles.ts`), who may see whom and the own-record rule (`org.ts`), company
  settings and their checks (`company.ts`), the shapes that cross the API (`contract.ts`).
- API: configuration that refuses to start in production without its settings; MongoDB with
  the four collections this phase uses; the one clock; first-run setup; sign-in, sign-out and
  server-side sessions; the sign-in throttle; change password; the temporary-password door;
  every route behind a session by default; permission and scope guards; the last-Admin guard;
  the audit log; company settings.
- Web app: sign in, first-run setup, "choose your own password", the shell (sidebar that
  collapses, drawer on phones, account menu, light and dark), Home, My profile, Settings.
- `npm run seed` for a sample company (`--reset`, `--wipe`), development only.

**Tested**

| What | Result |
|---|---|
| Unit tests of `shared` | 49 passed |
| Backend tests | 43 passed: 33 against a real MongoDB in a throwaway database (dropped afterwards), 10 without a database |
| Type-check, all three packages | Clean |
| Production build of the web app | Clean |

The tests cover every item on this phase's list: time-zone arithmetic (India's half hour,
Dubai, clock changes forward and back, every hour of a year in five zones); the role table;
manager chains, loops and a deactivated manager; the own-record rule and its sole-Admin
exception; setup refused without or with the wrong code, two setups at once leaving one
winner, closed afterwards; sign-in right, wrong and throttled; cookie flags; sign-out; a
deactivated person shut out on their next click; every protected route answering 401 without
a session and with a forged one; company settings refused to Employee, Manager and HR;
cross-site changes refused; a password change ending other sessions; the temporary-password
door; two Admins released at the same instant leaving one (20 rounds); 25 employee codes
asked for at once all different; no API answer containing a password digest; no local-time
code in `shared` or the API.

**Checked by hand in the browser** (desktop 1024 px and phone 375 px, light and dark)

- First-run setup on an empty database: field messages, an invalid time zone refused, the
  Admin created and signed in, the audit log written.
- All four roles signed in. Employee, Manager and HR see Home only; the Admin also sees
  Settings. Opening `/settings` as an Employee shows "not available for your role", and the
  API answers 403 to Manager and HR from a real browser session.
- Settings saved (time zone and leave year), and Home's date and greeting followed the new zone.
- Profile: phone number saved, a bad one refused beside its field; theme choice.
- A new joiner on a temporary password is held on one screen, also when opening another
  address directly, until they choose their own.
- The server being unreachable: the app waited and carried on by itself when it came back.
- Production mode on a spare port with a throwaway database: refuses to start without its
  settings; setup switched off without a code; the built web app, deep links and a missing
  file served correctly; the session cookie marked `HttpOnly; Secure; SameSite=Lax`.

**Found and fixed along the way**

- The API and the web app's dev server landed on one port under a preview tool (D16).
- A server message was shown twice on a form, beside its field and again underneath.
- The closed phone drawer's shadow spilled onto the edge of the page.
- The collapsed sidebar's "current page" marker made the menu scroll sideways.

**Not done, or not verified**

- No keyboard-only or screen-reader pass beyond spot checks (labels, Escape closing the menu,
  messages announced). The full pass is in Phase 10.
- Scope, the own-record rule and the last-Admin guard are tested at the function and service
  level only. No Phase 1 route takes an employee id or changes a role, so there is nothing
  yet to test them through. Phase 2 adds those routes and their API tests.
- Pages show a "Loading…" line, not skeletons: no Phase 1 page loads a list. Skeletons arrive
  with the first lists in Phase 2.
- There are no automated tests of the web app itself. As in the CRM, the rules are tested in
  `shared`, the API by API tests, and the screens by hand.
- No git repository was started (question 4 in 13.4 is still open).

**For review**

`npm run dev`, then http://localhost:5174. The development database holds the sample
company; the sign-ins are listed in `README.md`. `npm run seed -- --wipe` empties it to see
first-run setup.

### Phase 2: Employees and work schedules (23 Nov 2026)

**Built**

- `shared`: what a set of schedule rules is and whether it is sound (`schedules.ts`); what it
  means in plain words, with a warning when arriving on time and leaving on time would not
  be a full day; the break deduction that never punishes staying longer; the rules on a
  date; when an assignment may start. Who may change whom, who may hold which role, who may
  be whose manager, and when attendance counts for a person (`people.ts`). The brief's three
  employees as rules (`exampleRules.ts`), used by the tests and the sample company.
- API: departments; employees (list with search, filters, paging and scope; add; change;
  deactivate and reactivate with employment periods; reset password); standard schedules
  (create, change, archive); giving a schedule to one or many people from a date, standard
  or made for one person; cancelling one that has not started. Every change is in the audit log.
- Web app: Employees, a person's page, My team, Schedules, the schedule editor with its
  live "In plain words" panel, and the dialogs for adding and changing people, departments,
  deactivating, resetting a password and giving a schedule. Each person sees their own
  schedule, in plain words, on My profile.
- The sample company grew to thirteen people in three departments on the three schedules,
  with someone whose schedule has not started, someone with none, and someone who has left.

**Tested**

| What | Result |
|---|---|
| Unit tests of `shared` | 99 passed (50 new) |
| Backend tests | 100 passed: 90 against a real MongoDB in throwaway databases (33 foundation, 40 people, 17 schedules), 10 without a database |
| Type-check, all three packages | Clean |
| Production build of the web app | Clean |

Every item on this phase's test list is covered: rules validation field by field; the rules
on a date across a history, unchanged for earlier dates when a later assignment is added; a
first schedule refused before today and a change refused before tomorrow; editing a standard
schedule leaving every assignment in the database byte for byte the same; an edited schedule
applied from tomorrow, with today's rules still exactly what they were once tomorrow came; a
bulk action skipping the caller and saying so; employees A, B and C each resolving to their
own rules; HR unable to grant HR or Admin or to touch an HR or Admin account; nobody able to
change their own role, status, manager or schedule; a lone Admin able to, and marked in the
log; two Admins demoting each other at once, and deactivating each other at once, leaving
one; a manager needing a managing role; loops refused; a Manager seeing only their chain,
also through a deactivated manager; an Employee asking for another id answered word for word
as for nobody; deactivation signing out and closing the period; someone removed before their
first day leaving no days behind; someone brought back without the time away counted; two
time zones giving two different "todays" at one moment.

**Checked by hand in the browser**

- As HR: the list with its filters; a person's page; giving a first schedule; the editor's
  warning appearing as the full-day threshold is raised; creating a schedule; changing one
  seven people are on, being offered to give them the new rules, and the result naming the
  six who got them and the one (HR themself) who did not and why; that person's page then
  showing today's rules unchanged and the new ones as planned; adding someone and the
  one-time password; deactivating someone before their first day; departments (add, a name
  already used, deleting one with people in it, deleting an empty one).
- As Admin, in the light theme: changing details (all four roles offered); resetting a
  password; rules for one person only; archive, show archived, copy.
- As Manager: My team (five reports, two of them through another manager), a report's page
  with no buttons, a person outside the team answered "does not exist", Schedules refused.
- As Employee, at phone width: own schedule in plain words on My profile, Employees refused.
- The schedule editor at phone width. No page scrolls sideways at 375 px.

**Found and fixed along the way**

- A wrong start or end time also set off the checks that depend on the day's length, so one
  mistake produced three messages.
- Table and row styles leaked into avatars and badges (initials off-centre, a badge stretched).
- A schedule worked every day but Friday read as a list of six days; it now reads "Saturday
  to Thursday".
- A test of mine tripped its own credential sweep on an error that echoed a field name.

**Changed from the plan**: decisions D19 to D24 in section 3.

**Not done, or not verified**

- Not exercised in the browser, though each is covered by API tests: reactivating someone,
  cancelling a planned schedule, restoring an archived one, renaming a department, and the
  "Give to people" picker opened from the Schedules list (the same dialog was used from the
  editor). The Employees table at phone width was seen once, scrolling inside its card.
- No keyboard-only or screen-reader pass (Phase 10).
- Nothing judges attendance yet. The rules are stored and described; check-in, check-out
  and the calculations are Phase 3.
- The schedule lists read every assignment to work out who is on what today. That is fine
  for hundreds of people and is the first thing to index or cache if the company grows.
- Still no git repository (question 4 in 13.4 is open).

### Phase 3: Attendance engine (23 Nov 2026)

**Built**

- `shared/attendance.ts`, the one place attendance is judged. From the facts of a day (the
  punches, the breaks) and the rules the person was on, it works out: the kind of day
  (working, weekly off, holiday); which day a check-in made now belongs to, or why it
  cannot be made; until when an open day can still be checked out; how the day reads
  (thirteen statuses, ten flags), its minutes (gross, break, worked, late, early) and its
  units (worked, leave, absent, unresolved); and a period's summary. Holidays, leave,
  corrections and excused lateness are inputs already, so phases 5 to 7 supply data and
  change no arithmetic.
- `attendance_days`: one document per person per day, holding facts and their history and
  no verdict (D6).
- API: `GET /attendance/today`; check-in, check-out, break start, break end; and
  `GET /attendance/days/:employeeId/:date`, which reads any date, with or without a record.
- Each write is one conditional write to that one document. Check-in is an insert-if-absent
  on the day's id, so the database, not the code, refuses a second one. Check-out and the
  breaks change the document only while it is in the state they expect.
- The plain-words description of a schedule now says exactly until when a forgotten
  check-out can still be made, since that is now a rule the API applies.

**Tested**

| What | Result |
|---|---|
| Unit tests of `shared` | 140 passed (41 new, all on the engine) |
| Backend tests | 125 passed: 115 against a real MongoDB in throwaway databases (33 foundation, 40 people, 17 schedules, 25 attendance), 10 without a database |
| Type-check, all three packages | Clean |
| Production build of the web app | Clean |

Every item on this phase's test list is covered, each checked against the list by name: a
normal day; a second check-in, five at the same instant leaving one, and a check-in on a
day that already has a note; a check-out with no check-in, a second check-out, three at the
same instant leaving one; no schedule; a missing check-out read each of the three ways;
late exactly at the grace, a minute inside and a minute past; seconds cut to the minute;
the full-day and half-day thresholds at the boundary; the fixed break below, on and past
its line, and time worked never falling as the day gets longer; recorded breaks shorter and
longer than the allowance; no break; a break still running at check-out; flexible hours; A,
B and C judged differently at one moment; different weekly offs; every row of the table in
6.4; early departure; work on a day off, allowed and refused; absent only once the day is
over; nothing before the first schedule or outside employment; a body with a time, a date
or another person refused; the unit identity on 300 generated months; a schedule change
from tomorrow leaving every earlier day reading the same, in the engine and through the
API; a Dubai schedule on a server in another zone; a day the clocks change.

**Checked live, on the real clock.** There is no screen for this yet, so the running API was
called from the signed-in web app as the sample Employee: not in → check-in (the server's
time, late by 326 minutes, which was true) → a second check-in refused → a break refused
(their schedule has a fixed break) → check-out → a second check-out refused → the day read
back with its two history entries and no address in them → another person's day answered
"not found". The sample data was reset afterwards.

**Found and fixed along the way**

- Five expectations in my own tests were wrong and the engine was right (among them: a night
  shift can be joined for sixteen hours from its start, not until the next one opens; 09:00
  to 17:00 on the 9-to-6 schedule is seven hours worked, a half-day, not a full one). Each
  was checked against 6.3 to 6.5 before the test, not the engine, was changed.
- A second check-out answered "You are not checked in". It now says the day is already
  checked out and that a correction can put a mistake right.
- "Check-in for today has closed" named the weekday even when the next opening was later
  the same day.

**Changed from the plan**: decisions D25 to D28 in section 3; 6.4 says the same.

**Not done, or not verified**

- **Nothing on screen yet.** Nobody can check in from the web app until Phase 4 puts the
  buttons on Home. This phase is the engine and the API only.
- Holidays and leave are understood and unit-tested by the engine, but the API has none to
  give it until phases 5 and 7. In the running app no day can read Holiday or Leave yet.
- The fields a correction will set (`override`, `lateExcused`, `note`) are read and tested;
  nothing sets them until Phase 6.
- The month summary is a tested function. No route returns a month yet: Home's numbers are
  Phase 4, the calendar is Phase 5.
- Someone on flexible hours cannot check out after midnight (D25). Say so if that will
  happen in practice.
- The live check was one person on one schedule. The other schedules, the breaks, the
  night shift and the forgotten check-out are covered by tests on a set clock, not by hand.
- The engine looks 21 days ahead for someone's next working day. A longer run of days off
  only means an open day is limited by its schedule's "close after" time alone.
- Still no git repository (question 4 in 13.4 is open).

### Phase 4: Employee dashboard (23 Nov 2026)

**Built**

- `shared/today.ts`. Today's state for one person, put together by one function the API
  answers with (`composeToday`); the state in words (`describeToday`: ten states, each with a
  headline and a sentence or two); the open day counted at any moment exactly as the engine
  counts it at check-out (`liveDay`), with what is still needed and why the count has stopped
  when it has; what a check-out would mean, said before it is made; a day's flags with their
  minutes ("Late by 26 min", "Left 2 h early").
- `shared/serverClock.ts`: the server's time kept against a timer that only counts forward.
  The web app's clock is now this, tested.
- API: `GET /dashboard/me`, one answer read at one moment: today, the calendar month so far
  added up by the engine, and the seven days before today. It takes no input at all. A run of
  days is read with one query (`daysIn`), which the calendar and the reports will reuse.
- Web app, Home: **Today** (the state in words, late and other marks, the buttons the server
  says are possible, a live timer with progress toward half a day and a full day, and a
  confirmation before checking out); **This month** (present, half-days, absent, late entries,
  time worked, and a warning for days with no check-out); **Recent days** (status, marks,
  times, time worked); who I am, with the schedule and today's hours.
- A status is always a word, an icon and a colour together (`components/attendance.tsx`),
  from the one list of words in `shared`.
- The sample company can be given three weeks of sample attendance (D35).

**Tested**

| What | Result |
|---|---|
| Unit tests of `shared` | 184 passed (44 new: 40 on today's states, the timer and its words, 4 on the clock) |
| Backend tests | 133 passed: 123 against a real MongoDB in throwaway databases (8 new, on the dashboard), 10 without a database |
| Type-check, all three packages | Clean |
| Production build of the web app | Clean |

This phase's test list, item by item:

- **The summary equals the engine's for the same data.** A week is walked through the API
  (a full day, a late one, a half-day, an absence, a forgotten check-out, a day off); the
  month in the dashboard is then compared, field for field, with the engine's sum over the
  same days read one at a time. Also: today counts only once it is checked out; a new month
  starts from nothing while recent days reach back into the old one.
- **The timer ignores the device clock.** By test: the clock keeps the server's time while
  the device's is moved years either way. By hand: with the page's device clock set 5 h 17 min
  ahead, the timer moved four seconds in four seconds and the date did not change.
- **The timer counts as the server does.** A payload from one moment, counted by the timer
  at later moments, equals what the server answers at those moments, through a whole day, on
  a fixed break and on recorded breaks, in the unit tests and through the API.
- **The button cannot send twice.** By hand: three clicks in the same instant sent one
  request. The server refuses a second punch in any case (Phase 3's tests).
- **Every "today" state in 6.5**: no schedule; not counted; weekly off, allowed and refused;
  holiday; on leave; not due (before check-in opens, before the start, inside the grace,
  flexible hours); not in; the day over with no check-in; working; late; on a break; checked
  out as a full day, a half-day, an absence, and on a day off; half-day leave; still checked
  in from an earlier day; a check-out forgotten yesterday not blocking today; a check-out
  missed the same day; a night shift named by its own day; a shift that opens the evening
  before; correction pending.

**Checked by hand in the browser**

- As the sample Employee, desktop, dark: not checked in with the late warning; check in;
  working, with the late mark, the timer and the progress bar; the check-out question (that
  the day would count as absent, and as an early departure), closed with Escape.
- The same at phone width (375 px) in the light theme: no sideways scroll, a full-width
  52 px button; check in; the question; check out; the checked-out state with its marks; the
  month's numbers moving with it (19 working days, 3.5 absent).
- As someone on flexible hours who records breaks: check in, start a break (the timer stops
  and says why, "End break" comes first), end it (the timer runs again).
- As someone with no schedule: one card that says so, and no numbers.
- As Admin: the same page, with the company card beside it.
- With the sample history: the month's numbers, the warning for unresolved days, and a week
  of rows (present, late, absent, unresolved, weekly off).
- The page asked the server again after each punch and once a minute, and not more often.

**Found and fixed along the way**

- "Time worked" wrapped over two lines in its tile. The numbers are now three across, with
  the length of time given the room of two.
- A row that read Unresolved also said "Missing check-out". It is said once now, and only
  where the day reads as something else.
- "8 h short of 8 h" on a day with nothing worked. It reads "Short by 8 h".

**Changed from the plan**: decisions D29 to D35 in section 3.

**Not done, or not verified**

- **No automated test drives the browser.** The page's own wiring (buttons, the dialog, the
  refresh) was checked by hand as above. Everything it calls to decide or to word something
  is unit-tested.
- Seen only in tests, not in the browser: the pause during a fixed break (it needs five
  hours on the real clock), still checked in from an earlier day, a night shift, a day off,
  a missed check-out, and the card's "could not load, try again" state.
- A holiday and leave cannot occur in the running app yet (phases 5 and 7). Their words are
  written and tested.
- **A wrong punch cannot be put right by anyone until Phase 6.** The check-out question is
  there because of that.
- The timer starts from the minute of the check-in: checking in at 15:03:58 shows 0:00:58
  at once. That is how the day is counted (6.3), and it is why the screen and the record agree.
- Home's blocks link nowhere yet (D34). Leave is not among the month's numbers yet (D33).
- No keyboard-only or screen-reader pass (Phase 10). The timer is marked as a timer, the
  progress bar carries its sentence, the state is announced when it changes, and the dialog
  takes and returns focus.
- While files are being edited in development, the page sometimes logs "useAuth must be used
  inside AuthProvider" and reloads itself. It is the development hot-reload, has been there
  since Phase 1, and does not happen in a built app.
- The development database now holds the sample history. `npm run seed -- --reset` gives the
  plain sample company again.
- Still no git repository (question 4 in 13.4 is open).

### Phase 5: Attendance calendar and holidays (23 Nov 2026)

**Built**

- `shared/holidays.ts`: what a sound holiday is; which holidays are one person's (each date
  from the calendar named by the assignment in force that day); when a change of calendar may
  start; copying a year; what a change to the past does, in sentences. Month arithmetic and
  the month laid out in weeks went into `dates.ts`.
- API: holiday calendars (list, one with a year's holidays and its people, create, rename,
  delete, make default, copy a year, give to people from a date); holidays (add, change,
  remove, each refused with its effect until confirmed when it would change a day that has
  begun); a person's own holidays; the month calendar. Every change is in the audit log.
- **The engine now reads holidays.** The attendance service fetches the holidays of the
  calendars a person's assignments name and hands the engine its lookup; nothing in the
  engine changed. A change of schedule keeps the person's calendar.
- Web app: **Attendance** (a month as a calendar and as a list, the month added up, previous,
  next, month and year pickers, "This month", arrow keys between days, a day in full with its
  times and history); **Holidays** (a year, the next one marked); **Holiday calendars** for
  HR (the calendars; one calendar with its holidays year by year and who is on it; the
  dialogs to add, change and remove a holiday, give the calendar to people, copy a year);
  upcoming holidays on Home, which now also links to the calendar; on a person's page their
  calendar, "Change calendar", and a link to their month.
- The people picker became one component, used for schedules and for calendars.

**Tested**

| What | Result |
|---|---|
| Unit tests of `shared` | 201 passed (17 new: holidays and months) |
| Backend tests | 158 passed: 148 against a real MongoDB in throwaway databases (25 new, on holidays and the calendar), 10 without a database |
| Type-check, all three packages | Clean |
| Production build of the web app | Clean |

This phase's test list, item by item:

- **A holiday is not absent.** A company holiday nobody works reads Holiday for the people on
  that calendar and Absent for those who are not.
- **A special working day beats a weekly off and uses the standard hours.** A Sunday marked
  so reads as a working day, 09:00 to 18:00, 8 h expected.
- **An optional holiday stays a working day**, shown with its name.
- **Two calendars give two employees different days**, in the unit tests and through the API.
- **Adding, changing or removing a past holiday is confirmed with its effect and audited.**
  Refused first, with the exact count ("2 days Absent to Holiday, 1 day Present to
  Holiday"); nothing written; done when confirmed; the hours worked that day kept; the audit
  row carrying the effect. A new name asks nothing; a new kind or date does; a date in the
  future asks nothing.
- **Calendar months at year and month edges**: 28, 29, 30 and 31 days, December to January,
  a month before the first schedule, months that are not months refused.
- **A Manager cannot open a calendar outside their chain**: answered word for word as for an
  id that does not exist. An Employee cannot open their manager's.

Also covered: who may manage calendars; names taken whatever the case or spacing; the first
calendar becoming the default; giving a calendar from tomorrow at the earliest, to several
people at once, with each refusal's reason (own record, no schedule, deactivated, already on
it); that it adds an assignment with the same rules and leaves the earlier one untouched;
someone whose schedule has not started; a holiday not reaching back before the person was on
the calendar; taking a calendar away; a calendar in someone's history refusing deletion;
copying a year, twice, and into a year partly gone; a person's own holidays and the next
one; a check-in on a holiday recorded as work on a day off.

**Checked by hand in the browser**

- As Employee, desktop, in the light theme (and the month again in the dark one): the month with every status, late and early marks,
  today outlined, days still to come left blank, the day before the first schedule marked as
  not counted; a day opened (status, marks, times, history); arrow keys from day to day and
  stopping at the month's edge; next month (Christmas shown by name) and back; the list, and
  late entries only; Holidays for three years; upcoming holidays on Home and its three links.
- As HR: the calendars; one calendar; **a holiday added on a past Monday**, the warning with
  its counts (8 Present, 1 Absent, 1 Half-day to Holiday for 10 people), confirmed; removed
  again, asked twice, the second time with the effect; copying a year that is already there
  (seven reasons); the people picker with each person's calendar; a person's page with their
  calendar, the history column and the dialog; that person's month.
- As Manager: a report's month; someone outside the chain ("That person does not exist");
  Holiday calendars refused.
- At phone width (375 px): the month bar on one row, the grid of numbers and icons, the list
  under it, Holidays. No page scrolls sideways.

**Found and fixed along the way**

- The list under the calendar showed days off that had not come yet as "so far". It stops at today.
- On Holidays, a later year marked its own first holiday as "next" while this year's was
  still to come. The API now says which holiday is next, whichever year is on screen.
- The month bar wrapped badly on a phone.
- Four expectations in my own tests were wrong and the code was right: audit rows written at
  the same instant on the tests' frozen clock were read back in no particular order, and
  Christmas 2026 is a Friday, the weekly off of the person I had expected to be working.
- One existing test changed: the people picker now also says which calendar each person is on.

**Changed from the plan**: decisions D36 to D44 in section 3; section 10 has the routes as built.

**Not done, or not verified**

- **People entered before their calendar existed have no holidays until they are given it,
  from tomorrow at the earliest** (D36). The page warns how many. Say so if holidays should
  instead apply to everyone from the start.
- Done through the API tests but not by hand in the browser: making, renaming and deleting a
  calendar, changing the default, a "Give to people" and a "Change calendar" that succeed, a
  copy that copies.
- Not seen in the browser: the Admin's view of these pages (the same pages as HR's), HR's
  own person page, a night shift on the calendar, the "could not load" states.
- A day's detail has no "Ask for a correction" and no note from HR yet (Phase 6).
- My team still lists people without their attendance; a manager reaches a report's month
  from the report's page. The team's day at a glance is Phase 9.
- The effect of a holiday change looks at everyone who was ever on the calendar, in memory.
  Fine for hundreds of people; it is the first thing to narrow if a calendar has thousands.
- No keyboard-only or screen-reader pass (Phase 10). The calendar is a grid whose cells say
  the day in a sentence, and the arrow keys work.
- The development database holds the sample calendar and the sample history.
- Still no git repository (question 4 in 13.4 is open).

### Phase 6: Corrections and approvals (23 Nov 2026)

**Built**

- `shared/corrections.ts`: the eight kinds and what each asks for; which kinds fit a day as
  it is; when a request may be sent (how far back, how many for a month, one open per day);
  whether its times make sense (the same bounds a real punch has); a change laid over a
  day's facts; how the day would read afterwards, worked out by the engine; who may decide
  whose request; the check HR's direct correction passes. The engine now honours a status
  set by hand on a day with no punch.
- API: send, cancel, approve, reject; three lists (mine, waiting for me, decided); HR's direct
  correction and note on a day; the day in full now also says what is waiting, what the
  person could ask for and whether the caller may edit it. `GET /me` carries how many
  requests wait for the caller.
- **One write changes a day after the fact** (D45): the corrected facts and the history row
  with what was there before, who, when, why and the request's id. Approvals that were
  decided but not yet applied are finished when the server starts and whenever requests are
  read.
- Web app: from a day, "Ask for a correction" with only the kinds that fit; a waiting request
  on the day with "Cancel"; the day's history in words; for HR "Correct this day" and a note.
  **Approvals** in the menu with the number waiting: each request with the day as it is now
  and as it would read, approve or reject with a comment. My requests on the Attendance
  page; the ones still waiting on Home. The calendar marks days as corrected and as waiting.

**Tested**

| What | Result |
|---|---|
| Unit tests of `shared` | 236 passed (35 new, on the correction rules) |
| Backend tests | 186 passed: 176 against a real MongoDB in throwaway databases (28 new, on corrections), 10 without a database |
| Type-check, all three packages | Clean |
| Production build of the web app | Clean |

This phase's test list, item by item:

- **Each kind**: all eight, each asked for, decided by someone entitled to, and read back from
  the day.
- **Window and monthly limit**: a schedule that allows one day back and one a month refuses
  the day before that and a second day of the month, in the words the person sees.
- **One open request per day**: a second is refused; of two sent in the same instant one is stored.
- **Approve, reject, cancel**: a rejection needs its reason and leaves the day alone; only the
  person cancels, only while it waits; a decided request stays decided.
- **The original is still readable after two corrections in a row**: three, in fact. The
  first two history rows are still what was punched, and each correction's row holds exactly
  what it replaced.
- **The same approval sent twice, or by two approvers at once, applies once**: one succeeds,
  the other is told who decided; the day holds one row for the request.
- **An approval against a day that changed since it was opened is refused**, with the day as
  it is now; a request that no longer fits can only be rejected.
- **A check-out arriving during an approval loses nothing**: with the decision written and
  the day not yet touched, the check-out lands, then the correction is applied. Both are on
  the day, and the correction's "before" includes the check-out. Also both sent at once.
- **A stop between deciding and settling is finished on restart**, once, and also when
  requests are next read.
- **Nobody approves their own**; **HR's request cannot be approved through a manager
  account** (answered as if it did not exist); **a Manager cannot decide outside their
  chain**; an Employee decides nothing.
- **The calendar shows pending and corrected**, as does Home.

Also covered: HR's direct correction (its history row, refusal over a changed day, taking a
punch away, never on one's own record, text that looks like a field name stored as text);
notes (shown to the person and their managers, changed, removed, not in the way of a
check-in); what each person is told they could ask for; nothing but the form's own fields
accepted.

**Checked by hand in the browser**

- As Employee: a day opened from a link; asking for a missing check-out; a refusal landing
  beside its field; the request on the day, on the calendar, in the list and on Home; a day
  outside the seven-day window saying why nothing can be asked; a time that is already the
  recorded one refused.
- As Manager: Approvals in the menu with its count; the card with the day now and as it would
  read; approving; the count clearing; the request under Decided; rejecting without and
  then with a reason, at phone width.
- As HR: "Correct this day" on someone's absent Saturday, and a note on it; both in the day's
  history with HR's name.
- As Employee again: the day approved earlier reading Present and Corrected, with who
  approved and the reason given.
- At phone width: the day with a waiting request, the form to ask, the Approvals card. No
  page scrolls sideways.

**Found and fixed along the way**

- Dialogs opened from the day's dialog were drawn inside it and came out squeezed on a phone.
  They now sit beside it, and a dialog's buttons wrap.
- A request's own "Correction pending" mark was shown to its approver as part of the day.
- In the day's history an approved request read as if the approver had given the reason.
- "Incorrect check-in" could be asked for with the time already recorded.
- The full API suite stopped starting once there were seven test files (D53); the failed
  starts left thirteen throwaway databases, now removed.
- Two expectations of mine were wrong: a 17:30 check-in is also a late entry, and two marks
  came back in the other order.

**Changed from the plan**: decisions D45 to D53 in section 3.

**Not done, or not verified**

- Through the API tests only, not clicked by hand: cancelling a request, an approval refused
  because the day changed, a request that no longer fits, the lists beyond one page, the
  link from Home for a day with a missing check-out, and all of it as Admin.
- **Nobody is told when something waits for them or is decided.** The number in the menu is
  right when a page loads. There are no notifications or emails in this version.
- The monthly limit can be passed by one when two requests for two days arrive in the same
  instant (D48).
- A correction of an overnight shift's times was not tried in the browser; the rules for it
  are the same ones tested for day shifts and for flexible hours.
- Leave does not exist yet, so a correction on a day of leave has not been met (Phase 7).
- No keyboard-only or screen-reader pass (Phase 10).
- Still no git repository (question 4 in 13.4 is open).

### Phase 7: Leave (23 Nov 2026)

**Built**

- `shared/leave.ts`: the leave year a date falls in; what an account is owed (the year's
  grant, pro-rated for a joiner; the carry-forward, capped and only once the year has
  begun); a balance added up from entries and bookings; the days a request uses, counted by
  the person's own working days; the one check that decides whether a request may be sent
  (kind, policy, half-days, leave year, notice or back-dating, eligibility, overlap, the
  longest run, the balance); who may decide a request and who may cancel it; what approved
  leave means for one calendar day. The engine's day now carries the leave on it.
- API: kinds of leave and policies (create, edit, archive, delete, default, put people on
  one); a person's account for a leave year; adjustments; preview, send, approve, reject,
  cancel; four lists of requests. `GET /me` counts leave among what waits for the caller,
  and the home page's answer carries balances, waiting requests and leave coming up.
- **One versioned write to the account decides a request** (D8, 5.3): the dates against
  every other booking, the balance, and holding the days, against the account as it is at
  that instant. A write that finds the account changed is worked out again from a fresh
  read. Adjustments go through the same write.
- **The request's status is the truth; the account is made to match it.** Sending stores
  the request as `submitting`, holds the days, then marks it `pending`. A decision is one
  conditional write to the request, then `settle`: approved, the booking is `taken`;
  rejected or cancelled, it is removed. Requests left half way are finished at start-up
  and whenever requests are read (D61).
- Approved leave is read by the engine on every working day in its range, so the calendar,
  the day in full, Home and the month's numbers all show it; a request still waiting marks
  its days. A change to a holiday, a schedule or a holiday calendar shows the requests it
  touches (D64).
- Web app: **Leave** (balances per kind with what each is made of, "Request leave" with the
  day count, the dates not counted and the balance after shown before sending, my requests
  with cancel, the account's entries); **Leave setup** for HR (policies with their rules,
  kinds of leave, one person's balances with "Adjust balance"); **Approvals** with a Leave
  tab beside Corrections, each request with its effect on the balance; a Leave section on a
  person's page; a Leave card and the waiting requests on Home; Leave among the month's
  numbers; leave by name on the calendar.
- `npm run seed` now gives the sample company four kinds of leave, one policy with everyone
  on it, joining dates, and three sample requests made through the same services.

**Tested**

| What | Result |
|---|---|
| Unit tests of `shared` | 283 passed (47 new, on the leave rules) |
| Backend tests | 227 passed: 217 against a real MongoDB in throwaway databases (41 new, on leave), 10 without a database |
| Type-check, all three packages | Clean |
| Production build of the web app | Clean |

This phase's test list, item by item:

- **Days counted by the employee's own schedule and holidays**: the same four dates are
  three days for someone with Sunday off and three other days for someone with Friday off;
  a holiday on the person's calendar costs nothing, and costs a day for someone not on it.
- **Half-days**; **overlap refused**; **two halves of one day allowed**, the same half twice
  refused.
- **Twenty identical requests at the same instant hold the days once**: one is accepted,
  nineteen refused; one request, one booking, one audit row; nothing left `submitting`.
- **Two requests that together exceed the balance, sent together, pass one.** **Pending
  days held**: a third request is refused for the days the first still holds.
- **Negative only where the policy says**, and for unpaid leave.
- **Eligibility, notice and maximum run**, the run also across two requests and a weekly
  off (D58), and back-dating (D56).
- **A range across the leave year refused**; next year asked for ahead.
- **Pro-rated first year**; **the year's grant made once**, also after the policy is made
  more generous.
- **Carry-forward capped and not before the year starts**: nothing on 31 December, ten of
  fifteen days on 2 January, written once.
- **A cancel arriving in the middle of an approval ends with the days free.**
- **A stop at each step of sending and deciding is finished on restart**: before the days
  were held (the request goes), after (it is sent), between an approval and the account
  (taken), between a rejection and the account (freed); and an abandoned request is cleared
  by the next read, while a fresh one is left alone.
- **HR cannot adjust their own balance**, cannot put themselves on a policy, cannot approve
  their own request; a manager cannot decide HR's request, their own manager's, or one
  whose policy says HR only.
- **Leave shows as Leave and never as Absent, also after a holiday inside it is moved**:
  the day that became a working day reads Leave, and what was charged stays two days.
- **A half-day leave with a worked half**; **a punch on a leave day**.

Also covered: who may read whose account and requests (anyone else's is "not found"); the
shapes the routes accept, with nothing but the form's own fields; the audit rows; the home
page's leave; HR cancelling leave that has started, with a reason; kinds of leave archived
and restored; a policy deleted only when nobody is on it; a new person put on the default
policy with a pro-rated account; the leave year's month refused once leave exists; and, at
the end, that every booking in every account belongs to a live request in the state that
request says.

**Checked by hand in the browser**

- As Employee: the Leave page with balances; "Request leave" counting Friday to Monday as
  three days with Sunday not counted and the balance after; a fourth day refused beside
  its field (three in a row at most); the request sent, its days shown as waiting on the
  balance, the request in the list with Cancel; Home showing it under "Waiting for a
  decision", the Leave card, Leave among the month's six numbers, and last week's sick
  leave among the recent days.
- As Manager: Approvals opening on the Leave tab with its count; the card with dates, days
  and balance; approving; the request under Decided and the count dropping.
- As HR: Leave setup (the policy with its rules, the policy editor, the kinds of leave, one
  person's balances); the person's calendar with the leave days by name; the Leave section
  on their page; "Adjust balance" adding a day; cancelling approved leave, refused without
  a reason and done with one, the days back on the balance.
- At phone width: Leave and Leave setup. No page scrolls sideways.

**Found and fixed along the way**

- "HR" came out as "hr" where the approver was put into a sentence.
- The row of tabs grew a scrollbar of its own.
- The leave-year chooser stretched across the page head.
- Four expectations of mine were wrong or depended on chance: a day before the sample
  company's first schedule has no schedule to take leave from; a flexible day is not over
  until midnight; requests sent in the same frozen test minute have no order to assert; and
  twenty sign-ins at once are throttled, so the test signs in first.

**Changed from the plan**: decisions D54 to D69 in section 3.

**Not done, or not verified**

- Through the API tests only, not clicked by hand: rejecting a leave request; an employee
  cancelling their own; a half-day request; next year's account; adding or changing a kind
  of leave or a policy and saving it; putting people on a policy from the picker; "Change
  policy" on a person's page; the holiday confirmation that lists leave requests; all of it
  as Admin; the light theme.
- **Nobody is told when something waits for them or is decided.** As for corrections: the
  number in the menu is right when a page loads. No notifications or emails in this version.
- **Nobody asks for leave on someone else's behalf.** HR adds or removes days with an
  adjustment; it cannot file a request for a person who is away.
- What a waiting request holds in the old year is not carried forward. If it is rejected or
  cancelled after the year has turned, those days are not brought over by themselves, and
  neither are days freed by cancelling last year's approved leave: HR adjusts the new year.
- A carry-forward is written with the first change to the new year's account. Until then
  it follows last year's account; after that it is fixed.
- A year in which a person had no account at all (they neither asked nor were adjusted) is
  worked out with their policy as it is now when the next year carries forward from it.
- The longest run looks at leave of the same kind only: casual leave followed by sick leave
  is two runs.
- Leave is counted in days and half-days. There is no leave by the hour, no monthly accrual
  and no encashment (section 13.3, left for later).
- People who were added before leave was set up are on no policy until HR puts them on
  one: Leave setup counts them and says so.
- No keyboard-only or screen-reader pass (Phase 10).
- Still no git repository (question 4 in 13.4 is open).

### Phase 8: Announcements (23 Nov 2026)

**Built**

- `shared/announcements.ts`: whether an announcement is scheduled, showing or over at a
  moment; who it is for; the order of a person's list; when it counts as unread; what HR may
  store, with the two times read on the company's clock; an audience in words.
- API: the signed-in person's list with its unread count; one announcement by id; marking it
  read; for those who manage them, the full list with state, audience and read counts, and
  posting, changing, pinning and deleting. `GET /me` carries how many are unread, and the
  home page's answer carries the first three.
- **Two checks stand in front of every read, list and single alike**: it is showing on the
  server's clock, and the reader is in its audience as their record stands now. Failing
  either, the announcement does not exist for them.
- **Text stays text.** A title and a body are stored and returned as the characters they
  are, travel as JSON, and are put on the page as text, with line breaks kept by CSS.
- Web app: **Announcements** for everyone (rows with New, Important and Pinned in words;
  a row opens the announcement in full and marks it read); **Post announcements** for HR
  and Admin (the table, the form with importance, pin, start, end and audience, pin and
  delete); the first three on Home; the unread number in the menu.
- `npm run seed` now gives the sample company six announcements: for everyone, for one
  department, for two roles, one still to start and one that is over.

**Tested**

| What | Result |
|---|---|
| Unit tests of `shared` | 296 passed (13 new, on the announcement rules) |
| Backend tests | 243 passed: 233 against a real MongoDB in throwaway databases (16 new, on announcements), 10 without a database |
| Type-check, all three packages | Clean |
| Production build of the web app | Clean |

This phase's test list, item by item:

- **Start and expiry respected on the server's clock**: an announcement for tomorrow 09:00
  is not in anyone's list, and is "not found" by id and for a read mark, at 08:59; it is
  there at 09:00; it is there at 17:59 on its last day and gone at 18:00, also for someone
  who had it open. Given more time, it shows again.
- **Audience (everyone, departments, roles) decides who can fetch it, also by id**: six
  people in different roles and departments each get exactly their own list, in order; the
  one for Sales is "not found" for HR, who posted it and may manage it; someone who moves
  out of the department stops being shown it, and is shown it again when the audience is
  widened.
- **Unread counts**: each person's own, in the list, on Home and in `/me`; down by one when
  one is opened and no further when it is opened again; back up when the text changes and
  not when it is pinned or made important; a refused read leaves no mark.
- **Text is shown as text**: a title and a body made of a script tag, an image with a
  handler, quotes, an ampersand, a query operator and template braces come back exactly as
  typed, as JSON. In the browser the same text appeared as characters, made no element,
  and ran nothing (below).

Also covered: who may manage (an Employee and a Manager are refused every managing call);
what the form refuses, field by field, and that nothing but its own fields is accepted; the
order of the list (pinned, then important, then newest); the manage list with its states,
audiences in words, sizes and read counts; the audit rows for posting, changing, pinning
and deleting; deleting with its read marks.

**Checked by hand in the browser**

- As Employee: Home with three announcements and "3 new for you"; the number in the menu;
  opening the pinned one in full with its line breaks; the count dropping to 2 in both
  places and the row losing "New".
- As HR: the manage page with states, audiences and "1 of 12" read; posting an
  announcement for Managers and HR whose title and text contain `<b>`, a `<script>` and an
  `<img onerror>`; reading it: the text shown literally, no element created from it, nothing
  run; pinning it; changing its text, after which it read "0 of 4" and was new again in the
  menu; deleting it.
- At phone width: Announcements and the manage page. No page scrolls sideways (after the
  fix below).

**Found and fixed along the way**

- **A table whose last column has a heading for screen readers only made the whole page
  scroll sideways on a phone.** The heading is absolutely placed, and the scrolling box
  around the table was not its container. This was also true of three earlier tables (a
  holiday calendar's holidays, the kinds of leave, decided leave), on views I had not
  measured at phone width. One rule on the table's wrapper fixes all four.
- The three buttons at the end of a row wrapped onto two lines.
- A long description pushed the page's button under the heading.
- A script of mine half-applied an edit to the seed; finished by hand and re-checked.

**Changed from the plan**: decisions D70 to D75 in section 3.

**Not done, or not verified**

- Through the API tests only, not clicked by hand: an announcement for chosen departments
  from the form; one scheduled for later and one with an end, from the form; unpinning;
  the form's refusals beside their fields; the list beyond one page; all of it as Admin
  and as a Manager; the light theme.
- **Nobody is told when an announcement is posted.** It is on Home and in the menu the
  next time a page loads. No notifications or emails in this version.
- Announcements are plain text: no formatting, no links, no attachments.
- The read counts on the manage page are worked out over everyone each time it loads: fine
  for hundreds of people.
- An announcement cannot be aimed at named people or at a manager's team, only at
  everyone, departments or roles, as the brief asks.
- No keyboard-only or screen-reader pass (Phase 10).
- Still no git repository (question 4 in 13.4 is open).

### Phase 9: HR dashboard, records and reports (23 Nov 2026)

**Built**

- `shared/reports.ts`: the overview's groups and what each number counts; which days belong
  in the records, with or without a filter; how often someone was late; summaries added up;
  a month, a person's days and the records written out as rows. `shared/csv.ts`: a CSV file
  a spreadsheet reads as UTF-8, with any cell that starts like a formula made plain text.
- API: `GET /dashboard/hr` (one day for everyone in reach), `GET /attendance/records`,
  `GET /reports/monthly`, `GET /reports/employee/:id`, `GET /reports/people`; the three
  lists also as CSV. The team list (`GET /employees?team=1`) carries each person's day today.
- **Who a caller reaches is worked out on every call** from their role and today's
  organisation, and a filter can only narrow it (D77). **Every day is read by the engine**,
  at that moment, from the stored facts: nothing keeps a count of its own.
- Many people are read with a fixed handful of queries (`contextsFor`), then the engine runs
  in memory (D85).
- Web app: **Overview** (the day's numbers as buttons, each opening the people behind it;
  day, department and manager filters; a search; what waits for the caller; the next
  holidays), **Attendance records** (filters by dates, people, status and mark; who was late
  how often), **Reports** (a month with one row per person and a total; one person's days);
  "Download CSV" on each, and on the attendance calendar for the month shown; "My team" with
  a Today column.

**Tested**

| What | Result |
|---|---|
| Unit tests of `shared` | 311 passed (15 new, on the report rules and CSV) |
| Backend tests | 265 passed: 255 against a real MongoDB in throwaway databases (22 new, on the overview, records and reports), 10 without a database |
| Type-check, all three packages | Clean |
| Production build of the web app | Clean |

This phase's test list, item by item:

- **Every dashboard number equals the engine's count over the same people**: for a Monday
  that is over and a Tuesday in progress, each person's day is fetched from their calendar
  and counted with the shared function; the overview's counts are those, and the groups add
  up to everyone.
- **Filters**: by day, department, manager, the number asked for, name or code; in the
  records also by person, status, mark and dates, alone and together; a range the wrong way
  round or longer than allowed is refused beside its field.
- **A Manager's numbers cover only their chain**: five people for one manager, two for the
  lead under her, one for another; she may narrow to the lead's team and not to another
  manager's; a search does not reach past the team; the same for records, the monthly
  report, one person's report and every file.
- **The report equals the calendar's summary for each person**: all eleven rows of a month
  against each person's calendar, field for field; one person's report over the month the
  same; the total is the rows added up.
- **CSV content and escaping**: the header, a row and the total checked cell by cell
  against the report; a name and a department typed as formulas come out as text, in one
  cell each, with their commas and quotes; the records file has every matching row, not one
  page; the content type, the file name, the byte-order mark and the line ends.
- **A month for 500 people answers quickly**: with 500 more people and their punches, the
  month in 0.95 s, one day in 0.2 s, a week of records narrowed to late entries in 0.2 s,
  the month as a file in 0.7 s (limits in the test: 5, 3, 3 and 5 seconds).

Also covered: an Employee is refused all of it but their own report and file; who may
download what, and the audit row for each download of other people's attendance; someone
on a night shift after midnight shown on the shift they are in; "My team" carrying the same
day the overview shows, and no other list carrying it.

**Checked by hand in the browser**

- As HR: Overview for today and for a day last week, the tiles, opening "Late" (the address
  carries the filter, the list is that one person); Attendance records for the month so
  far; Reports, the monthly table with its total; "One person" with a wrong id (refused in
  words) and with a person chosen (tiles and days).
- The monthly CSV fetched in the page: its type, its file name and its first rows.
- As Manager: "Team overview" with her five people and nobody else; Overview, Attendance
  records and Reports in her menu; "My team" with the Today column.
- At phone width, measured on each: Overview, Attendance records, Reports (both tabs), My
  team. No page scrolls sideways.

**Found and fixed along the way**

- The overview's list sat in two thirds of the page and its last two columns were cut off.
  It is full width now, with the two small cards beneath it; the records page likewise.
- Two tiles side by side were stacked by a rule meant for rows of three.
- A month for 500 people took 2 s. Two pure date functions now remember their answers:
  0.95 s, with every date test still passing.
- Two scripted edits of mine half-applied (an import line was not what the script
  expected; a layout edit removed an opening tag). Both were finished by hand and checked
  by the type-checker and in the browser.
- Five expectations of mine were wrong: a day of leave that is not over is not counted
  yet; a two-day report is not the month; a day of five hours exactly has no break taken
  off; the month's summary counts the weekly offs still to come; and the test client was
  dropping the byte-order mark it was meant to check.

**Changed from the plan**: decisions D76 to D86 in section 3.

**Not done, or not verified**

- **The "Download CSV" buttons were not clicked**: saving a file from the browser needs
  your say-so. The same addresses were fetched in the page and by the tests, and the
  button's code is a fetch of that address followed by a save.
- Through the API tests only, not clicked by hand: the department, manager, person,
  status and mark filters; the date steppers; the search box; paging; the late list's link;
  the overview's minute-by-minute refresh; the light theme; all of it as Admin.
- A file was not opened in Excel or another spreadsheet. The escaping follows the usual
  guidance and is tested as text.
- The overview counts the people who are not deactivated today, also for a past day:
  someone who has left since is not in it. They are in the records and the monthly report.
- Reports are worked out when asked for, not stored: a month for 500 people takes about a
  second here. Several thousand people would want a different approach.
- There is no .xlsx export, no charts, and no report on leave balances across people.
- The audit log has no page yet (Phase 10). Downloads are written to it.
- No keyboard-only or screen-reader pass (Phase 10).
- Still no git repository (question 4 in 13.4 is open).

### Phase 10: Final testing and polish (23 Nov 2026)

**Built**

- **The audit log**: `GET /audit` (Admins only; filters by part of the HRMS, who did it, whom
  it concerns, dates and words; fifty lines a page) and its page, where a line opens to show
  what was kept. Under Admin in the menu.
- **The QA suite**, three files in `backend/src/qa`:
  - `sweep.test.ts` reads the routes from the app (82 of them) and tries each as nobody, with
    a forged session and as each role. 49 declare a permission and let in exactly the roles
    that hold it (97 refusals, 99 admissions). 33 declare none; each is on a list with its
    reason, and the list must match exactly. Every route that takes an id or a date is sent
    eleven values that are neither.
  - `attacks.test.ts`: other people's ids, on eight addresses as six pairs of people, each
    answer compared word for word with the answer for an id nobody has; a role, an owner, a
    result or a time slipped into eleven bodies; HR against their own record on eleven routes;
    twelve identical requests at once for check-in, check-out, a leave request, its approval
    by three people, its cancellation, a calendar, a person and a read mark; twenty
    adjustments of minus one day against a balance of twelve; operators, patterns, paths,
    oversized and broken bodies, forms, another site's origin, methods no route offers;
    sessions after sign-out, deactivation and reset; guessing at a password at sign-in and
    from inside a session; the audit log's filters and what it must never hold.
  - `scale.test.ts`: 500 more people, 12,400 days of punches, 100 waiting requests of each
    kind sent by the people themselves, 300 announcements, 20,000 audit lines; over forty
    timed requests, each asked twice and held to a limit.
- `npm run qa`; a "Skip to the page" link; a shared tabs component.

**Tested**

| What | Result |
|---|---|
| Unit tests of `shared` | 311 passed |
| Backend tests | 299 passed, 34 of them the QA suite. The whole suite was run six times in this phase; the first two runs each showed an older test that depended on timing or on an unstated order (below), the last four were clean |
| Type-check, all three packages | Clean |
| Production build of the web app | Clean |
| Production mode on a spare port, throwaway database | 16 checks passed: starts, health, the built app and a deep link served, a missing file is 404, the content policy, setup refused without its code and working with it, the cookie marked `HttpOnly; Secure; SameSite=Lax`, answers not cached, twelve guesses from twelve claimed addresses stopped after ten, no claimed address in the audit log, another site's request refused, the sample seed refusing to run. The database was dropped afterwards; only `delta_hrms` exists |

With 500 people the slowest answers, over the runs, were 0.4 to 0.9 s: the month for
everyone (0.4 to 0.7 s), three weeks of everyone's records (0.5 s) and the first call to an
approvals inbox (0.2 to 0.9 s; 0.1 s after that). A person's own pages mostly answered in
under 0.05 s, a page of the audit log in 0.02 s. The limits in the test are 0.8 to 6 s; it
is a check that nothing grows badly with the company, not a benchmark.

**Security review against 13.2**, item by item

| Item | How it was checked | Result |
|---|---|---|
| Permission, scope and own-record on the server | The sweep and the attack checks | Holds on every route. No finding |
| "Me" comes from the session | Bodies naming another person are refused (400); the routes were read | Holds |
| Inputs | Strict schemas on every body and query; hostile ids on every route; operators and patterns | Holds. A pattern typed into a search matches nobody rather than everybody |
| Sessions | Read; the tests; the production run | Holds. Role and status are read again on every request |
| Sign-in | Read; guessing tests | **Two findings, fixed**: the forwarded address was believed from anyone (D90); the current password on a password change could be guessed without limit (D91) |
| Cross-site, content policy, no HTML from users | Read; a foreign origin refused; no place in the web app writes HTML | Holds |
| Attendance facts | The phase tests and the simultaneous-request checks | Holds |
| Errors | Read; no answer in any test contains a digest | Holds |
| The rules from 1.4 | Each read against the code | Hold. The seed refuses production; no secret has a default |

A deactivated person who signs in with the right password is told the account is
deactivated; with a wrong one, nothing about the account. That was looked at and left.

**Checked by hand in the browser**

- **A script run inside the signed-in app**, as each of the four roles, at desktop and at
  phone width (eight runs): every page and every tab on it, 26 or 27 screens for HR and
  Admin. For each: the main heading, whether the role is let in, an error on the page, the
  page wider than the screen, a button or link with no name, a field with no label, a table
  with no headings, an error in the console, and the contrast of every piece of text against
  its background, in the light and the dark theme. After the fixes below: nothing found.
  What each role is refused matches the permission table.
- **Thirty dialogs** opened and checked the same way, among them the stacked ones (a note,
  a correction, asking for a correction on top of a day): each has a name, takes the
  keyboard, and closes with Escape, one at a time.
- The sign-in screen and the "choose your own password" screen, which still holds a new
  joiner who opens another address directly.
- **With the keyboard alone**: signing in; the order of stops on a page; the skip link; the
  phone menu (opens, takes the keyboard, wraps, Escape gives it back); "Request leave"
  opened with Enter, 34 presses of Tab and Shift+Tab staying inside it, Escape returning to
  the button; the attendance calendar with the four arrow keys, Enter and Escape; tabs with
  the arrow keys, End and wrap-around; the account menu.
- The audit log as Admin: the list, a line opened, the filter choices; it showed my own
  test's action (below).
- Employees and Home looked at in the light theme after the colour changes.

**Found and fixed along the way**

- The faintest text (small labels, table headings, hints, "Nobody") was 2.9 to 4.0 against
  its backgrounds in both themes. Badges, avatar initials, the red "danger" button, error
  and warning words were 2.9 to 4.3 in the light theme (D92).
- A person's page and the "not available for your role" screen had no main heading.
- No way past the menu for a keyboard: sixteen links before every page for HR (D93).
- On a phone the closed menu was only moved off screen: the Tab key and a screen reader
  still went through it. Opened, it did not take the keyboard (D93).
- Tabs were announced as tabs but did not answer the arrow keys and were not linked to what
  they show; "Kinds of leave 4" was read as "Kinds of leave4" (D93).
- A page of the audit log read and sorted the whole log, and its filter list took 0.7 s with
  20,000 lines (D94). Five lists got an index in the order they are shown.
- The two security findings above (D90, D91).
- Three older tests were right about the app and wrong about themselves: thirteen reads of
  the audit log relied on an order they never asked for, and "two Admins demote each other
  at once" allowed only one of the two refusals that both leave one Admin.
- Mine, in this phase: counts I had guessed in the sweep; test data with the wrong weekday
  names and audience; my first browser script measured colours half way through a fade and
  pages before they had loaded, so it both raised false alarms and missed the badges, and
  was rewritten; for half a minute between two edits the shell used something it had not
  imported; and my dialog script pressed "Archive" on a sample schedule, which archives at
  once (it can be restored, changes nobody's schedule and is in the audit log). The sample
  data was created again afterwards.

**Changed from the plan**: decisions D87 to D94 in section 3.

**Not done, or not verified**

- **Not tested with a screen reader.** Names, labels, headings and roles were checked by
  script; how it sounds was not.
- **Only one browser**: the one built into the development tool (Chromium). Not Firefox,
  Safari or a real phone.
- **`npm audit` was not run**, because it sends the list of packages to the npm registry.
  It should be run before going live.
- The contrast check is a script's arithmetic on text over plain backgrounds. It does not
  cover placeholder text, icons, focus rings, disabled controls or how a control looks under
  the pointer. At phone width it was run as Admin only; the styles are the same for all.
- The keyboard pass went through one dialog stop by stop. The other twenty-nine use the same
  component and were checked by script for a name, where the keyboard is, and Escape.
- **The "Download CSV" buttons were still not clicked** (saving a file from the browser
  needs your say-so). The addresses are fetched by the tests.
- First-run setup was not looked at again in the browser in this phase (it needs an empty
  database). Its API was exercised by the tests and by the production run.
- Scale was checked at 500 people on this machine, one request at a time: not thousands of
  people, and not many people at once.
- Nothing in section 13.3's "Left for later" was added. The known limits are in the README.
- **Still no git repository**, and questions 3, 4 and 5 in 13.4 are still open.
