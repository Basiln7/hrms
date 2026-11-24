import { Fragment, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, ScrollText, Search } from 'lucide-react';
import { AUDIT_AREA_INFO, AUDIT_AREAS, auditAreaOf, isLocalDate, type AuditArea, type AuditListPayload, type AuditRow } from '@delta-hrms/shared';
import { LoadError, SkeletonLines } from '../components/states';
import { Badge, Empty, Pager } from '../components/ui';
import { dateTime } from '../lib/format';
import { queryOf, useLoad } from '../lib/useLoad';

/** What was there before, or what is there after, as text. It is shown as text and nothing else. */
const asText = (value: unknown) => JSON.stringify(value, null, 2);

/** Everything the log kept about one action. */
function Details({ row }: { row: AuditRow }) {
  const nothing = row.before === undefined && row.after === undefined;
  return (
    <div className="audit-details">
      <dl className="facts">
        <div>
          <dt>Action</dt>
          <dd>{row.action}</dd>
        </div>
        <div>
          <dt>From</dt>
          <dd className={row.ip ? undefined : 'none'}>{row.ip ?? 'Not recorded'}</dd>
        </div>
      </dl>
      {row.selfAdministered && <p className="note">Done on their own record, as the only HR or Admin in the company at the time.</p>}
      {nothing ? (
        <p className="muted">Nothing more was kept for this action than the line above.</p>
      ) : (
        <div className="audit-change">
          {row.before !== undefined && (
            <div>
              <h4>Before</h4>
              <pre>{asText(row.before)}</pre>
            </div>
          )}
          {row.after !== undefined && (
            <div>
              <h4>{row.before !== undefined ? 'After' : 'Recorded'}</h4>
              <pre>{asText(row.after)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The audit log: every HR and admin action, who did it, when, about whom, and what changed.
 * It can only be read. Nothing here, and no route in the API, changes or removes a row.
 */
export default function AuditLog() {
  const [params, setParams] = useSearchParams();
  const date = (name: string) => (isLocalDate(params.get(name)) ? params.get(name)! : '');
  const asked = {
    area: AUDIT_AREAS.includes(params.get('area') as AuditArea) ? params.get('area')! : '',
    actorId: params.get('actorId') ?? '',
    employeeId: params.get('employeeId') ?? '',
    from: date('from'),
    to: date('to'),
    search: params.get('search') ?? '',
  };
  const page = Number(params.get('page') ?? '1') || 1;
  const set = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    if (name !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };
  const filtered = Object.values(asked).some(Boolean);

  // Typing does not ask the server on every letter.
  const [typed, setTyped] = useState(asked.search);
  useEffect(() => {
    if (typed === asked.search) return;
    const timer = window.setTimeout(() => set('search', typed.trim()), 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);

  const { data, error, reload } = useLoad<AuditListPayload>(`/audit${queryOf({ ...asked, page: page > 1 ? page : undefined })}`);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p>{data ? `${data.total} ${data.total === 1 ? 'action' : 'actions'}${filtered ? ' match' : ' recorded'}, newest first. The log can only be read.` : 'Every HR and admin action: who, when, about whom, and what changed.'}</p>
        </div>
      </div>

      <div className="toolbar" role="group" aria-label="Filters">
        <span className="input-icon">
          <Search size={17} />
          <input className="input" type="search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Words from the line" aria-label="Search the log" />
        </span>
        <select className="select" aria-label="Part of the HRMS" value={asked.area} onChange={(e) => set('area', e.target.value)}>
          <option value="">Every part</option>
          {AUDIT_AREAS.map((area) => (
            <option key={area} value={area}>
              {AUDIT_AREA_INFO[area].label}
            </option>
          ))}
        </select>
        <select className="select" aria-label="Who did it" value={asked.actorId} onChange={(e) => set('actorId', e.target.value)}>
          <option value="">Done by anyone</option>
          {(data?.actors ?? []).map((actor) => (
            <option key={actor.id} value={actor.id}>
              {actor.name}
            </option>
          ))}
        </select>
        <label className="dated">
          <span>From</span>
          <input className="input" type="date" value={asked.from} max={asked.to || undefined} onChange={(e) => set('from', e.target.value)} />
        </label>
        <label className="dated">
          <span>To</span>
          <input className="input" type="date" value={asked.to} min={asked.from || undefined} onChange={(e) => set('to', e.target.value)} />
        </label>
        {filtered && (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              setTyped('');
              setParams(new URLSearchParams(), { replace: true });
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      <section className="card" aria-label="Actions">
        {asked.employeeId && (
          <p className="note" style={{ marginBottom: 14 }}>
            Showing what concerns one person.{' '}
            <button type="button" className="link" onClick={() => set('employeeId', '')}>
              Show everyone
            </button>
          </p>
        )}
        {error && !data ? (
          <LoadError message={error} onRetry={reload} />
        ) : !data ? (
          <SkeletonLines lines={8} />
        ) : data.items.length === 0 ? (
          <Empty icon={<ScrollText size={30} />} title={filtered ? 'Nothing matches' : 'Nothing has been recorded yet'} body={filtered ? 'Try other dates or fewer filters.' : 'Every HR and admin action is written here as it happens.'} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">What</th>
                  <th scope="col">About</th>
                  <th scope="col" className="cell-end">
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((row) => {
                  const area = auditAreaOf(row.action);
                  const shown = open === row.id;
                  return (
                    <Fragment key={row.id}>
                      <tr>
                        <td className="nowrap">{dateTime(row.at, data.timeZone)}</td>
                        <td>
                          {row.actor ? (
                            <>
                              {row.actor.name}
                              <span className="cell-sub">{row.actor.role}</span>
                            </>
                          ) : (
                            <span className="cell-none">The system</span>
                          )}
                        </td>
                        <td className="audit-what">
                          {row.summary}
                          <span className="cell-sub badges">
                            {area && <Badge color="var(--text-2)">{AUDIT_AREA_INFO[area].label}</Badge>}
                            {row.selfAdministered && <Badge color="var(--amber)">On their own record</Badge>}
                          </span>
                        </td>
                        <td className={row.employeeId ? undefined : 'cell-none'}>
                          {row.employeeId ? (
                            <>
                              <Link to={`/employees/${row.employeeId}`}>{row.employeeName ?? 'Someone'}</Link>
                              {asked.employeeId !== row.employeeId && (
                                <button type="button" className="link cell-sub" onClick={() => set('employeeId', row.employeeId!)}>
                                  Only theirs
                                </button>
                              )}
                            </>
                          ) : (
                            'Nobody in particular'
                          )}
                        </td>
                        <td className="cell-end">
                          <button type="button" className="icon-btn sm" aria-expanded={shown} aria-label={shown ? 'Hide the details' : 'Show the details'} onClick={() => setOpen(shown ? null : row.id)}>
                            {shown ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                          </button>
                        </td>
                      </tr>
                      {shown && (
                        <tr className="audit-more">
                          <td colSpan={5}>
                            <Details row={row} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pager page={data.page} pages={Math.max(1, Math.ceil(data.total / data.pageSize))} total={data.total} pageSize={data.pageSize} onPage={(next) => set('page', String(next))} noun="actions" />}
      </section>
    </>
  );
}
