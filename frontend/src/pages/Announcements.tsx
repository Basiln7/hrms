import { Link } from 'react-router-dom';
import { Megaphone, Settings2 } from 'lucide-react';
import type { AnnouncementFeedPayload } from '@delta-hrms/shared';
import { AnnouncementList } from '../components/announcements';
import { LoadError, SkeletonLines } from '../components/states';
import { Empty } from '../components/ui';
import { useAuth, useMe } from '../context/AuthContext';
import { useLoad } from '../lib/useLoad';

/**
 * The announcements that are showing for the signed-in person now. Which those are is the
 * server's decision on every request: the page takes no filter and no employee.
 */
export default function Announcements() {
  const { can } = useAuth();
  const { company } = useMe();
  const { data, error, reload } = useLoad<AnnouncementFeedPayload>('/announcements');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Announcements</h1>
          <p>{data ? (data.items.length === 0 ? 'What the company wants you to know.' : data.unread === 0 ? 'You have read them all.' : `${data.unread} ${data.unread === 1 ? 'is' : 'are'} new for you. Open one to read it.`) : 'What the company wants you to know.'}</p>
        </div>
        {can('announcements.manage') && (
          <div className="head-actions">
            <Link className="btn ghost" to="/announcements/manage">
              <Settings2 size={17} aria-hidden="true" /> Manage announcements
            </Link>
          </div>
        )}
      </div>

      <section className="card" aria-label="Announcements">
        {error && !data ? (
          <LoadError message={error} onRetry={reload} />
        ) : !data ? (
          <SkeletonLines lines={6} />
        ) : data.items.length === 0 ? (
          <Empty icon={<Megaphone size={30} />} title="No announcements right now" body="When HR posts something for you, your department or your role, it appears here and on your home page." />
        ) : (
          <AnnouncementList items={data.items} timeZone={company.timeZone} onRead={reload} />
        )}
      </section>
    </>
  );
}
