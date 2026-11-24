# Delta HRMS

A basic HRMS for Delta: attendance, a work schedule per employee, holidays, leave, attendance
corrections, announcements and reports.

**It was built in ten phases, and all ten are done.** What it does: first-run setup, sign-in
and sign-out, four roles with their permissions enforced by the API, employees and
departments, a work schedule per employee with its history, check-in, check-out and breaks
from the home page with a live timer, the attendance calendar month by month for yourself and
for the people you may see, holiday calendars and each person's holidays, attendance
corrections with approval, leave (kinds, policies, balances, requests and approval),
announcements, an overview of any day, attendance records, reports with CSV download, the
audit log, a profile page and company settings. `plan.md` has the full plan, the decisions
behind it, and for each phase what was built, how it was tested and what was left out.

## What it is built with

The same stack as the Delta Sales CRM, at the same versions.

| Part | Technology |
|---|---|
| Web app | React 19, TypeScript, Vite, React Router |
| API | Node.js, Express 5, TypeScript, Zod |
| Database | MongoDB (official driver) |
| Tests | Vitest |

## Layout

An npm workspace with three packages, one folder each.

```
frontend/            The browser app (React + Vite)
backend/             The API server (Express + MongoDB)
shared/              Types and rules used by BOTH of the above
docker-compose.yml   An optional local MongoDB
package.json         The workspace: one install, one set of commands
plan.md              The plan, the decisions, and the record of each phase
```

The frontend and the backend never import from each other. Each imports only from `shared`
(as `@delta-hrms/shared`). A rule (who may see whom, what a role may do, what time it is in a
time zone) is written once there, as a plain function with unit tests; the browser uses it to
explain and the API uses the very same code to decide.

## Running it

You need Node.js 22 or newer and MongoDB.

```bash
npm install
npm run dev
```

Then open http://localhost:5174.

- The API starts on http://localhost:4200 and connects to `mongodb://127.0.0.1:27017`,
  database `delta_hrms`. Nothing else in your MongoDB is touched.
- These ports, the database name and the session cookie's name are all different from the
  Sales CRM's, so both can run on one machine at once.
- No MongoDB installed? `docker compose up -d` starts one on the default port.
- To change a setting, copy `backend/.env.example` to `backend/.env`. In development every
  setting has a working default.

### The first time

An installation with nobody in it shows **Set up your HRMS**: name the company, choose its
time zone and create the first Admin. It works once; after that the page is closed for good.

To look around with people already in it instead, fill the database with the sample company:

```bash
npm run seed
```

That creates thirteen people in three departments, on the three schedules the brief describes,
a holiday calendar ("Delta holidays", the company default) that everyone is on, and leave:
four kinds, one policy ("Standard leave") with everyone on it, and a few sample requests.
HR has also posted six sample announcements.
These are the ones to sign in as:

| Role | Email |
|---|---|
| Admin | admin@delta.test |
| HR | hr@delta.test |
| Manager (five people under her, two of them through another manager) | manager@delta.test |
| Employee | employee@delta.test |
| Employee, not signed in yet, on a temporary password | newjoiner@delta.test |

The rest are in `DEMO_PEOPLE` in `backend/src/seed/demo.ts`: among them someone whose schedule
has not started yet, someone with no schedule, and someone who has left.

They all share one password, `DEMO_PASSWORD` in `backend/src/seed/demo.ts`. The sample
company is for development only: the seed refuses to run in production, and the server never
creates sample data by itself.

A company created today has no yesterday, so its home pages start empty. To look at a month
with something in it, ask for a past as well:

```bash
npm run seed -- --reset --history
```

Everyone's schedule then started three weeks ago, with sample check-ins and check-outs for
each day since: mostly full days, and for each person a late one, a half-day, an absence and
a forgotten check-out. It is written as plain punches (`backend/src/seed/history.ts`) and
read by the same engine as real ones. It is sample data, not anyone's record.

## Commands

Run these from the project root.

| Command | What it does |
|---|---|
| `npm run dev` | Starts the API and the web app together, reloading on changes |
| `npm run dev:backend` / `npm run dev:frontend` | Starts just one of them |
| `npm test` | Runs all tests. The API tests need MongoDB and use a throwaway database that is dropped afterwards. Without MongoDB they show as skipped, which means not run |
| `npm run qa` | Runs only the QA suite (it is part of `npm test` too): every route as every role, the attack checks, and the lists with 500 people behind them. Add `-- --reporter=verbose` to see the times it measured |
| `npm run typecheck` | Type-checks all three packages |
| `npm run build` | Builds the web app into `frontend/dist` |
| `npm start` | Starts the API without file watching |
| `npm run seed` | Fills an empty database with the sample company |
| `npm run seed -- --reset` | Wipes this app's database and fills it again |
| `npm run seed -- --history` | With either of the two above: also three weeks of sample attendance |
| `npm run seed -- --wipe` | Wipes this app's database and leaves it empty, to go through first-run setup again |

The sample holidays are in `DEMO_HOLIDAYS` in `backend/src/seed/demo.ts`: days that fall on the
same date every year, entered for last year, this year and next. The sample leave is in
`backend/src/seed/leave.ts`; its requests are made through the same services the API uses.

## Roles

| Role | In one line |
|---|---|
| Employee | Uses the HRMS for themselves |
| Manager | Also sees the people who report to them, directly or through their reports |
| HR | Runs people, schedules, holidays, leave and announcements |
| Admin | Everything HR can do, plus company settings, HR and Admin accounts and the audit log |

The table of what each role may do is in `shared/src/roles.ts`. Three rules go beyond it and
are enforced on the server:

- **Scope.** A request about someone you may not see is answered "not found", exactly as for
  someone who does not exist (`shared/src/org.ts`, `backend/src/services/access.ts`).
- **Your own record.** Nobody uses an HR power on their own record; another HR or Admin does
  it. The one exception is an Admin who is the only HR or Admin in the company, and the audit
  log marks it.
- **There is always an Admin.** The last one cannot be deactivated or demoted, even when two
  Admins try it on each other at the same instant (`backend/src/services/admins.ts`).

## People

- **Employees** (HR and Admin) lists everyone, with search and filters. **My team** shows a
  Manager the people under them. A person's page has their details, their schedule and its
  history, their holiday calendar, and a link to their attendance month by month.
- Adding someone makes their employee code (EMP-0014, …) and a temporary password, which is
  shown once for HR to pass on. They choose their own at first sign-in. Resetting a password
  does the same and signs them out everywhere.
- HR adds and changes Employees and Managers. Only an Admin gives the HR and Admin roles or
  changes an HR or Admin account. A manager must be a Manager, HR or Admin, and nobody can
  end up above their own manager.
- Deactivating someone asks for their last working day; reactivating asks from which day they
  are back. The time in between is not counted as absence. `joinDate` is a fact for the
  record: attendance counts from a person's first schedule, not from the day they joined.

## Work schedules

A schedule is a set of rules: fixed or flexible hours, the hours of a normal day, which days
are worked and which is the weekly off (any day can have hours of its own), how breaks are
taken off, the late grace, the full-day and half-day thresholds, early departures, what a
missing check-out counts as, and how far back corrections can be asked for. None of these is
a constant in the code: each is a field of the rules, defined and checked in
`shared/src/schedules.ts`.

- **Standard schedules** (Schedules, for HR and Admin) are named sets of rules to give to many
  people. While one is being edited, "In plain words" says what the numbers mean and warns
  when arriving on time and leaving on time would not add up to a full day.
- **Each person works under their own copy**, given to them from a date. Rules can also be
  made for one person only.
- **History cannot change.** A first schedule starts today at the earliest and a change
  starts tomorrow at the earliest, in that person's time zone. Changing a standard schedule
  changes nobody: the people on it keep their copy until they are given the new rules from a
  date. A planned change can be cancelled until it starts; after that it is history.
- Giving a schedule to many people says who got it and, for anyone who did not, why.

## Attendance

**Home** is where people check in and out. It shows today's state in words, the buttons the
server says are possible right now, a live timer of the time worked, this month's numbers and
the last seven days.

- **The page decides nothing.** Which buttons exist, what the day reads as, every number: the
  API answers all of it in one request (`GET /api/dashboard/me`), read at one moment, and the
  page asks again every minute. The sentences come from `describeToday` in
  `shared/src/today.ts`, where every state is tested.
- **The timer runs on the server's clock** and counts the way the day will be counted at
  check-out: in whole minutes from the minute of the check-in, with the break taken off as
  the schedule says. So it stands still on a recorded break, and while a fixed break is being
  taken off, and says why. Changing the device's clock changes nothing on the page.
- **Checking out asks first**, and says what the day will count as, because it cannot be
  taken back. A second tap while a punch is on its way sends nothing.

The rules behind it:

- **A punch carries nothing.** `POST /api/attendance/check-in`, `/check-out`, `/break/start`
  and `/break/end` act on the signed-in person at the server's time. A request with anything
  in its body (a time, a date, another person) is refused.
- **One day, one document.** A person's day is stored once (`attendance_days`, keyed by
  person and date), so a second check-in for the same day is refused by the database itself,
  also when two arrive at the same instant.
- **Only facts are stored**: the punches, the breaks and the history of every change. Present,
  late, half-day, absent and the rest are worked out from those facts each time they are
  asked for, by one function (`evaluateDay` in `shared/src/attendance.ts`), using the rules
  the person was on that day. Nothing can go stale, and changing someone's schedule from
  tomorrow leaves every earlier day reading exactly as it did.
- **A punch belongs to a shift, not to a calendar date.** At 00:30 it may still be
  yesterday's night shift. A forgotten check-out can be made until the schedule's "close
  after" time has passed or check-in opens for the next working day, whichever comes first;
  after that the day reads Unresolved (or what the schedule says) and needs a correction.
- **Every working day is accounted for exactly once**: worked + leave + absent + unresolved
  = 1. A day is called absent only once it is over, never while there is still time to
  arrive.
- `GET /api/attendance/today` is the signed-in person's state now.
  `GET /api/dashboard/me` is that plus their month and recent days; it takes no input, so it
  cannot be asked for anyone else.
  `GET /api/attendance/days/:employeeId/:date` is one day in full, for the person, their
  managers and HR; for anyone else it answers "not found".

### The month, day by day

**Attendance** shows any month as a calendar and as a list, with the month added up. Each day
carries its status as a word, an icon and a colour, its times, and marks such as Late. Opening
a day shows what was recorded and everything that happened to it, in order. The arrow keys
move between days. On a phone the calendar keeps its grid, with the list underneath.

- Your own month is under **Attendance**. A manager opens a report's month, and HR anyone's,
  from that person's page. The API (`GET /api/attendance/calendar`) applies the same rule as
  everywhere else: someone you may not see is "not found".
- Nothing on the page is stored as a verdict. Every day is worked out by the engine at the
  moment it is asked for, so a month always agrees with the home page and, later, the reports.

### Corrections

A punch that is wrong or missing is put right by a correction, never by editing it away.

- **Asking.** From a day on the calendar, "Ask for a correction" offers the kinds that fit the
  day as it is: a missing or incorrect check-in or check-out, forgotten attendance, an
  explanation of a late entry, or that a half-day or an absence should count for more. Each
  asks only for what it needs, and a reason. How far back, and how many for a month, are
  rules of the person's own schedule.
- **Deciding.** The request goes to the person's manager chain, HR and Admin; requests from
  HR and Admin go to another HR or Admin. Nobody decides their own. **Approvals** shows each
  one with the day as it reads now and as it would read, so nothing is approved blind; if the
  day has changed since it was opened, the approval is refused and the day shown again.
- **What an approval does.** One write to the day: it sets the corrected facts and adds a row
  to the day's history with what was there before, who, when and why. The original punches
  stay in that history for good. The day then reads by the same rules as any other day.
- **HR can correct a day directly**, with a reason, and leave a note on it that the person and
  their managers see. Never on their own record.
- The rules are in `shared/src/corrections.ts`. How two things arriving at once, or a server
  stopping halfway, are kept from applying a correction twice or losing a punch is described
  at the top of `backend/src/services/corrections.ts`.

## Holidays

A **holiday calendar** is a named set of dated holidays: "India", "Dubai office". Each holiday
is one of four kinds, defined in `shared/src/holidays.ts`:

| Kind | What it does to the day |
|---|---|
| Public holiday, Company holiday | A day off. Nobody is absent; hours worked anyway are recorded as work on a day off |
| Optional holiday | Shown by name, but still a working day. Someone who wants it off takes leave |
| Special working day | A day that is normally off (a weekly off) and is worked this once, on the normal hours |

- **A person is on a calendar from a date**, through their schedule. Giving someone a calendar
  (one person, several, or a whole department at once) starts tomorrow at the earliest, and
  every day before it keeps the calendar they were on then. So two people in two countries
  have different holidays, and nobody's past changes when they move.
- One calendar is the **default**: people getting their first schedule are put on it. A change
  of schedule keeps the calendar the person already has. Someone with no schedule has no
  calendar; **people added before a calendar existed have no holidays until HR gives it to
  them**, and the Holiday calendars page says how many that is.
- **Changing a day that has already begun asks first.** Adding, changing or removing a holiday
  on a date that has begun for people on the calendar is refused with what it would do, for
  example "3 days that read Absent will read Holiday". It happens only when confirmed, keeps
  the hours that were worked, and is written to the audit log with that effect. The same
  goes, on any date, when someone's leave request includes it: the requests are listed first,
  because their days were counted with the calendar as it was. A holiday in the future that
  touches nobody's leave, or a new name for a past one, asks nothing.
- A year can be copied into the next, date for date, to review. Dates that already have a
  holiday, or that have already begun, are left out and listed. Holidays whose date moves from
  year to year have to be corrected by hand.
- A calendar that anyone was ever on cannot be deleted: their past days read from it.
- Everyone sees their own holidays for any year under **Holidays**, and the next few on Home.

## Leave

HR sets leave up under **Leave setup**; everyone uses it under **Leave**; requests are decided
under **Approvals**.

- **Kinds of leave** (casual, sick, earned, unpaid, whatever the company gives): a name, a
  short code, paid or unpaid, whether a half-day can be taken. A kind is archived, not
  deleted.
- **A policy** is a named set of rules, one entry per kind of leave: days a year; whether a
  joiner's first year is pro-rated; how many unused days are carried forward; days of
  service before it can be taken; the longest run; how many days ahead it must be asked for,
  or how many days back it may start; whether the balance may go below zero. It also says
  who approves: the person's manager chain, or HR only. None of these numbers is fixed in
  the code. Each person is on one policy; new people are put on the default one.
- **A balance is never stored.** A person has one account per leave year, holding what was
  added (the year's allowance, what was carried forward, HR's adjustments with their
  reasons) and what live requests hold or have taken. Every number on screen is added up
  from those two lists when it is asked for (`balanceOf` in `shared/src/leave.ts`).
- **A request counts only the person's own working days**, by their own schedule and holiday
  calendar: a weekly off or a holiday inside the range costs nothing. The form shows the
  count, the dates not counted and the balance afterwards before anything is sent. The count
  is stored with the request and does not change afterwards.
- **The days are held from the moment a request is sent.** Checking the dates against every
  other request, checking the balance and holding the days is one write to the account, so
  two requests sent at the same instant cannot both pass, and approving can never overdraw.
- **Deciding** follows the rule of every approval: the manager chain or HR as the policy
  says, requests from HR and Admin only by another HR or Admin, never by the requester. A
  rejection needs its reason.
- **Cancelling**: the person themself while it waits, or after approval until its first
  day. After that only HR, with a reason. The days are simply available again.
- **Approved leave reads as Leave** on every working day in its range, on the calendar, on
  Home and in the month's numbers (paid and unpaid apart). If a holiday or a schedule
  changes inside it afterwards, no day is left reading Absent; what was charged stays as it
  was counted, and whoever makes the change is shown the requests it touches so that HR can
  adjust the balance.
- **The leave year** starts in the month set for the company and cannot be moved once leave
  exists. A request stays inside one leave year. Unused days come across on the first day of
  the new year, up to the policy's limit; a year that is over is closed.
- HR adds or removes days with an **adjustment**, which carries a reason and is added to the
  account beside everything else. Never on their own account.
- The rules are in `shared/src/leave.ts`. How a request and its account are kept in step
  without transactions (also when the server stops between two writes) is described at the
  top of `backend/src/services/leave.ts` and `backend/src/services/leaveAccounts.ts`.

## Announcements

HR and Admin post them under **Post announcements**; everyone reads the ones that are for
them under **Announcements** and on Home.

- An announcement has a title, a text, an importance, a start and optionally an end, and an
  audience: everyone, chosen departments, or chosen roles. It can be pinned to the top.
- **Two checks stand in front of every read**, for the list and for a single announcement
  by its id: it is showing at this moment on the server's clock, and the reader is in its
  audience by their role and department as they are now. Otherwise it does not exist for
  them. Someone who may manage announcements is still only shown, in their own list, what
  is for them.
- **Text is only ever text.** A title and a text are stored and sent as the characters they
  are and put on the page as text, so nothing written in one can run or change the page.
  Line breaks are kept; nothing is turned into formatting or links.
- **Unread** means not opened yet, or opened before the text last changed. The number in the
  menu is the server's count. Pinning an announcement, or changing its times or its
  audience, makes nobody read it again.
- The start and the end are typed on the company's clock, whatever zone the device is in.
- The manage page shows how many people each announcement is for today and how many of them
  have read it. Deleting one is for good; to stop showing it and keep it, give it an end.
- The rules are in `shared/src/announcements.ts`.

## Overview, records and reports

For HR and Admin these cover everyone; for a Manager, the people who report to them,
directly or through their reports. Who that is, is worked out by the API on every request;
a filter can only narrow it.

- **Overview** is one day: how many people are working now, present, on a half-day, absent,
  late, on leave, on a day off and so on. Each person is in exactly one group, the groups
  add up to everyone, and each number opens the list of the people behind it. "Absent" is
  everyone the day counts as absent and everyone who should be in by now and is not. For
  today the page asks again every minute.
- **Attendance records** are everyone's days between two dates, narrowed by department,
  manager, person, how the day reads and what is marked on it, with who was late how often
  in the same stretch.
- **Reports**: a month with one row per person and a total, and one person's days between
  two dates. Everyone can also download their own month from the attendance calendar.
- **Every number is the engine's**, read at that moment from the stored facts by the same
  function as the calendar (`shared/src/reports.ts` only groups and adds). A report cannot
  disagree with a person's calendar; the tests compare them field for field.
- **Download CSV** gives the same rows as a file. Text that starts like a formula (=, +, -,
  @) is written as plain text, because a spreadsheet would otherwise run it
  (`shared/src/csv.ts`). Downloading other people's attendance is written to the audit log.
- Many people are read with a fixed handful of queries, whatever their number: a month for
  500 people takes about a second.

## Audit log

For Admins. Every HR and admin action is one line: when, who did it, what, and about whom.
Requests and decisions on leave and corrections are in it, and so is every download of other
people's attendance.

- It can be narrowed by the part of the HRMS, by who did it, by whom it concerns, by date
  (on the company's clock) and by words from the line. A line opens to show what was kept:
  the values before and after, and the address the request came from.
- **It can only be read.** The API has one route for it, and that route reads. Nothing in the
  app changes or removes a line, and a test fails if a second route ever appears.
- No line holds a password, a password digest or a temporary password. A test reads every
  line to check.
- An action someone took on their own record, as the only HR or Admin in the company at the
  time, is marked.

## Time

- **The server's clock is the only clock.** The web app shows the server's time and never
  the device's. `backend/src/clock.ts` is the one place the API reads the time.
- A day is a date **in a time zone**. The company has a default zone, and each work schedule
  carries its own, for people in another country. `shared/src/dates.ts` does the arithmetic
  and never looks at the time zone of the machine it runs on; a test scans the source of
  `shared` and `backend` to keep it that way.

## Security, in short

- Every route needs a signed-in session unless it is on a short public list (health check,
  first-run setup, sign in, sign out). New routes are protected by default, and a test walks
  every route and expects 401 without a session.
- The session is an httpOnly cookie holding a random token; the database stores only its
  hash. Signing out, a password change or deactivation ends sessions on the server.
- Passwords are stored as salted scrypt digests and never sent to the browser. A test scans
  every answer the API gives for one.
- Sign-in attempts are counted as they arrive: ten per address and email, then a wait. The
  same limit guards the "current password" asked for when changing it, so an open session
  cannot be used to find the password by trying.
- The visitor's address is taken from the connection. A forwarded address is believed only
  from the proxies the server is told about (`TRUST_PROXY`), so nobody can name their own.
- Requests that change anything are accepted only from the web app's own address.
- Every request body is checked, and a field the route does not expect is refused.
- Someone with a temporary password can do nothing but choose their own.
- HR and admin actions are written to an audit log that nothing can edit or delete.
- Nothing is sent to any outside service.

### The QA suite

`backend/src/qa` holds three test files that look at the API as a whole rather than at one
feature. They run with `npm test`, and on their own with `npm run qa`.

- **`sweep.test.ts`** finds every route the app mounts and knocks on each one as nobody, with
  a forged session, and as each of the four roles. A route that declares a permission must let
  in exactly the roles that hold it. A route that declares none must be on a short list in
  that file, with the reason it is open to anyone signed in. **A new route without a guard and
  without a line there fails the suite.** It also sends every route that takes an id or a date
  a set of values that are neither.
- **`attacks.test.ts`** uses the API the way someone would who wants what is not theirs:
  other people's ids (the answer must be word for word the answer for an id that does not
  exist), a role or an owner slipped into a body, HR acting on their own record, the same
  request sent a dozen times at once, input that tries to be a query or a path, sessions that
  should have ended, guessing at passwords, and the audit log itself.
- **`scale.test.ts`** adds 500 people, five weeks of punches, a hundred waiting requests of
  each kind and 20,000 audit lines, then holds every list and report to a time and a size.

## Accessibility

- Everything works from the keyboard. The first stop of the Tab key is "Skip to the page".
  Dialogs keep the keyboard inside them, close with Escape and put it back where it was; so
  does the menu on a phone. The attendance calendar moves with the arrow keys, and so do tabs.
- Every control has a name, every field a label, every page one main heading, and messages
  are announced.
- Text meets 4.5:1 against its background in the light and the dark theme. Status colours are
  never the only signal: each comes with words or an icon.
- It was checked page by page and dialog by dialog with a script and by keyboard, as each
  role, at phone and desktop width. It was **not** tested with a screen reader.

## Production

`NODE_ENV=production npm start` after `npm run build` runs the API and serves the built web
app from the same address: one thing to deploy, behind HTTPS (the session cookie is marked
Secure there, so browsers send it only over HTTPS).

- `MONGODB_URI` and `WEB_ORIGIN` must be set. The server refuses to start without them.
- First-run setup asks for `SETUP_CODE` (at least 16 characters), so a fresh address cannot
  be claimed by whoever finds it first. Without one, setup is switched off. Remove it once
  setup is done.
- A `PORT` set by the hosting platform is used when `API_PORT` is not set.
- Behind a load balancer or a proxy, set `TRUST_PROXY` to how many of them there are
  (usually 1). Without it the server still works and is safe, but everyone appears to come
  from the proxy's address: in the audit log, and to the sign-in limit, which then counts per
  email alone.
- Before going live, run `npm audit` and read what it says about the packages. It was not
  run while building this, because it sends the list of packages to the npm registry.

## Known limits

- One server is assumed: the sign-in throttle is kept in memory.
- No emails are sent. A temporary password has to be passed on by HR.
- People are added one at a time; there is no import from a file yet.
- Who may see whom, and every report later, follows today's organisation: a manager sees the
  whole history of the people who report to them now.
- The schedule lists read every assignment to work out who is on what today: fine for
  hundreds of people, and the first thing to index if the company grows much beyond that.
- One check-in and one check-out per day; breaks cover the gaps. A mistaken punch is put
  right with a correction, which keeps the original.
- Nobody is notified when a request waits for them or is decided: the number beside Approvals
  is right when a page loads.
- Reports are worked out when they are asked for, not stored: about a second for a month of
  500 people. Several thousand people would want another approach.
- Exports are CSV only: no .xlsx, no charts.
- The overview counts the people who are not deactivated today, also when a past day is
  looked at. Someone who has left since is in the records and the monthly report.
- The audit log cannot be downloaded, and its lines are kept for good: there is no archive
  or clean-up. Searching it by words reads every line the other filters leave.
- It has not been tested with a screen reader, nor in browsers other than the one built into
  the development tool (Chromium).
- The effect of a holiday change is worked out over everyone who was ever on the calendar,
  in memory: fine for hundreds of people.
- Someone on flexible hours cannot check out after midnight: their day ends there.
- Nobody asks for leave on someone else's behalf: HR adjusts a balance, it does not file a
  request for a person who is away.
- Leave is counted in days and half-days: no leave by the hour, no monthly accrual, no
  encashment.
- Days that a waiting request held in last year's account, or that are freed there after the
  year has turned, are not carried forward by themselves: HR adjusts the new year.
- The longest run of leave looks at one kind at a time: casual leave followed by sick leave
  is two runs.
- People added before leave was set up are on no leave policy until HR puts them on one;
  Leave setup says how many that is.
- Announcements are plain text, for everyone, departments or roles: no formatting, links or
  attachments, and none for named people. Nobody is notified when one is posted.
