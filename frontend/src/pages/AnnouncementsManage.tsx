import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Megaphone, Pencil, Pin, PinOff, Plus, Trash2 } from 'lucide-react';
import { ANNOUNCEMENT_STATE, type AnnouncementManagePayload, type AnnouncementRow } from '@delta-hrms/shared';
import { AnnouncementMarks } from '../components/announcements';
import { LoadError, SkeletonLines } from '../components/states';
import { Badge, Confirm, Empty, Pager } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { api, messageOf } from '../lib/api';
import { dateTime } from '../lib/format';
import { queryOf, useLoad } from '../lib/useLoad';
import { AnnouncementForm } from './announcements/AnnouncementForm';

/**
 * Every announcement, for HR and Admin: write one, change it, pin it, take it down, and see
 * who it is for and how many of them have read it. The API checks the permission again on
 * every call.
 */
export default function AnnouncementsManage() {
  const toast = useToast();
  const { refresh } = useAuth();
  const [page, setPage] = useState(1);
  const { data, error, reload } = useLoad<AnnouncementManagePayload>(`/announcements/manage${queryOf({ page })}`);
  const [form, setForm] = useState<{ announcement?: AnnouncementRow } | null>(null);
  const [deleting, setDeleting] = useState<AnnouncementRow | null>(null);

  // The list, and the reader's own unread number in the menu, both come from the server.
  const changed = () => {
    reload();
    void refresh();
  };
  const act = async (run: () => Promise<unknown>, done: string) => {
    try {
      await run();
      toast(done);
    } catch (failure) {
      toast(messageOf(failure), 'error');
    }
    changed();
  };

  return (
    <>
      <Link className="back" to="/announcements">
        <ArrowLeft size={16} /> Announcements
      </Link>
      <div className="page-head">
        <div>
          <h1>Manage announcements</h1>
          <p>Everything that has been posted, newest first, with who it is for and how many of them have read it.</p>
        </div>
        <div className="head-actions">
          <button type="button" className="btn" disabled={!data} onClick={() => setForm({})}>
            <Plus size={17} aria-hidden="true" /> New announcement
          </button>
        </div>
      </div>

      <section className="card" aria-label="All announcements">
        {error && !data ? (
          <LoadError message={error} onRetry={reload} />
        ) : !data ? (
          <SkeletonLines lines={6} />
        ) : data.total === 0 ? (
          <Empty
            icon={<Megaphone size={30} />}
            title="Nothing has been posted yet"
            body="An announcement can be for everyone, for chosen departments or for chosen roles, from now or from a time you set."
            action={
              <button type="button" className="btn" onClick={() => setForm({})}>
                <Plus size={17} aria-hidden="true" /> New announcement
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Announcement</th>
                  <th scope="col">For</th>
                  <th scope="col">When</th>
                  <th scope="col">Read by</th>
                  <th scope="col" className="cell-end">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((row) => {
                  const state = ANNOUNCEMENT_STATE[row.state];
                  return (
                    <tr key={row.id}>
                      <td className="announcement-cell">
                        <b>{row.title}</b>
                        <span className="badges">
                          <AnnouncementMarks item={row} />
                        </span>
                        <span className="cell-sub announcement-preview">{row.body}</span>
                      </td>
                      <td>
                        {row.audienceWords}
                        <span className="cell-sub">
                          {row.audienceSize} {row.audienceSize === 1 ? 'person' : 'people'}
                        </span>
                      </td>
                      <td>
                        <Badge color={state.tone} dot>
                          {state.label}
                        </Badge>
                        <span className="cell-sub">
                          From {dateTime(row.startsAt, data.timeZone)}
                          {row.expiresAt ? ` until ${dateTime(row.expiresAt, data.timeZone)}` : ''}
                        </span>
                        <span className="cell-sub">Posted by {row.createdByName}</span>
                      </td>
                      <td className="nowrap">{row.state === 'scheduled' ? <span className="cell-none">Not showing yet</span> : `${row.readCount} of ${row.audienceSize}`}</td>
                      <td className="cell-end">
                        <span className="actions row-actions">
                          <button type="button" className="icon-btn sm" aria-label={row.pinned ? `Unpin “${row.title}”` : `Pin “${row.title}” to the top`} title={row.pinned ? 'Unpin' : 'Pin to the top'} onClick={() => void act(() => api.post(`/announcements/${row.id}/pin`, { pinned: !row.pinned }), row.pinned ? 'Unpinned.' : 'Pinned to the top of everyone’s list.')}>
                            {row.pinned ? <PinOff size={16} /> : <Pin size={16} />}
                          </button>
                          <button type="button" className="icon-btn sm" aria-label={`Change “${row.title}”`} title="Change" onClick={() => setForm({ announcement: row })}>
                            <Pencil size={16} />
                          </button>
                          <button type="button" className="icon-btn sm" aria-label={`Delete “${row.title}”`} title="Delete" onClick={() => setDeleting(row)}>
                            <Trash2 size={16} />
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data && data.total > data.pageSize && <Pager page={data.page} pages={Math.ceil(data.total / data.pageSize)} total={data.total} pageSize={data.pageSize} onPage={setPage} noun="announcements" />}

      {form && data && (
        <AnnouncementForm
          announcement={form.announcement}
          timeZone={data.timeZone}
          onClose={() => setForm(null)}
          onSaved={(saved) => {
            toast(form.announcement ? 'The announcement is saved.' : Date.parse(saved.startsAt) > Date.parse(saved.createdAt) ? 'Scheduled. It shows from the time you set.' : 'Posted. It is showing now.');
            changed();
          }}
        />
      )}
      {deleting && (
        <Confirm
          title="Delete this announcement?"
          body={`“${deleting.title}” is taken down for everyone, for good. To stop showing it and keep it here, set a time for it to end instead.`}
          onConfirm={() => void act(() => api.delete(`/announcements/${deleting.id}`), 'The announcement is deleted.')}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
