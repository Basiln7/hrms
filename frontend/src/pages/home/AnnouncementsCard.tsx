import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { MyDashboardPayload } from '@delta-hrms/shared';
import { AnnouncementList } from '../../components/announcements';

/**
 * The first few announcements showing for the person. Shown only when there are some: an
 * empty box about announcements would be noise on a page people open to check in.
 */
export function AnnouncementsCard({ announcements, timeZone, onRead }: { announcements: MyDashboardPayload['announcements']; timeZone: string; onRead: () => void }) {
  if (announcements.total === 0) return null;
  const more = announcements.total - announcements.items.length;
  return (
    <section className="card" aria-labelledby="home-announcements">
      <div className="card-head">
        <div>
          <h2 className="card-title" id="home-announcements">
            Announcements
          </h2>
          <p className="card-sub">{announcements.unread === 0 ? 'You have read them all' : `${announcements.unread} new for you`}</p>
        </div>
        <Link className="link" to="/announcements">
          {more > 0 ? `All ${announcements.total}` : 'All announcements'} <ArrowRight size={15} />
        </Link>
      </div>
      <AnnouncementList items={announcements.items} timeZone={timeZone} onRead={onRead} />
    </section>
  );
}
