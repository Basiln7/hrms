import { useState } from 'react';
import { Megaphone, Pin } from 'lucide-react';
import type { AnnouncementView } from '@delta-hrms/shared';
import { useAuth } from '../context/AuthContext';
import { api } from '../lib/api';
import { dateTime, shortDate } from '../lib/format';
import { Badge, Modal } from './ui';

/*
 * An announcement as its readers see it. Its title and body are text: they are put on the
 * page as text nodes and never as markup, so nothing written in one can run or restyle the
 * page. Line breaks in the body are kept by CSS (`white-space: pre-wrap`), not by turning
 * them into elements.
 */

/** The marks an announcement carries beside its title. Words, never colour alone. */
export function AnnouncementMarks({ item }: { item: Pick<AnnouncementView, 'pinned' | 'importance'> & { unread?: boolean } }) {
  return (
    <>
      {item.unread && <Badge color="var(--accent-text)">New</Badge>}
      {item.importance === 'important' && <Badge color="var(--amber)">Important</Badge>}
      {item.pinned && (
        <Badge color="var(--text-2)">
          <Pin size={12} aria-hidden="true" /> Pinned
        </Badge>
      )}
    </>
  );
}

/** One announcement in full. */
function ReadDialog({ item, timeZone, onClose }: { item: AnnouncementView; timeZone: string; onClose: () => void }) {
  return (
    <Modal
      title={item.title}
      onClose={onClose}
      width={600}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="badges" style={{ marginBottom: 12 }}>
        <AnnouncementMarks item={{ pinned: item.pinned, importance: item.importance }} />
      </div>
      <p className="announcement-body">{item.body}</p>
      <p className="announcement-meta" style={{ marginTop: 16 }}>
        Posted by {item.postedByName} on {dateTime(item.startsAt, timeZone)}
        {item.expiresAt ? ` · shown until ${dateTime(item.expiresAt, timeZone)}` : ''}
      </p>
    </Modal>
  );
}

/**
 * Announcements as a list: pinned and important first, as the server sorted them. Opening
 * one shows it in full and tells the server it has been read; the unread mark and the number
 * in the menu follow from the server's answer, not from a guess on this side.
 */
export function AnnouncementList({ items, timeZone, onRead }: { items: AnnouncementView[]; timeZone: string; onRead: () => void }) {
  const { refresh } = useAuth();
  const [open, setOpen] = useState<AnnouncementView | null>(null);

  const show = (item: AnnouncementView) => {
    setOpen(item);
    if (!item.unread) return;
    // If it could not be recorded (it has just ended, say) the list is read again and says so by itself.
    void api
      .post(`/announcements/${item.id}/read`)
      .catch(() => undefined)
      .then(() => {
        onRead();
        void refresh();
      });
  };

  return (
    <>
      <ul className="announcements">
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" className="announcement" data-unread={item.unread || undefined} onClick={() => show(item)} aria-label={`${item.unread ? 'New. ' : ''}${item.title}. Open`}>
              <span className="announcement-icon" aria-hidden="true">
                <Megaphone size={17} />
              </span>
              <span className="announcement-main">
                <span className="announcement-title">
                  <b>{item.title}</b>
                  <AnnouncementMarks item={item} />
                </span>
                <span className="announcement-preview">{item.body}</span>
                <span className="announcement-meta">
                  {item.postedByName} · {shortDate(item.startsAt, timeZone)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {open && <ReadDialog item={open} timeZone={timeZone} onClose={() => setOpen(null)} />}
    </>
  );
}
