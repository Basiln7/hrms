import { useState } from 'react';
import { changeInWords, CORRECTION_INFO, dayInWords, REQUEST_STATUS, type CorrectionListPayload, type CorrectionRow, type LocalDate } from '@delta-hrms/shared';
import { LoadError, SkeletonLines } from '../../components/states';
import { Badge, Confirm, Pager } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { api, messageOf } from '../../lib/api';
import { shortDate } from '../../lib/format';
import { queryOf, useLoad } from '../../lib/useLoad';

/**
 * The signed-in person's own correction requests, newest first: what they asked for, where
 * each stands, who decided and what they said. A waiting one can be taken back.
 */
export function MyRequests({ timeZone, onOpen, onChanged }: { timeZone: string; onOpen: (date: LocalDate) => void; onChanged: () => void }) {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const { data, error, reload } = useLoad<CorrectionListPayload>(`/regularizations${queryOf({ view: 'mine', page })}`);
  const [cancelling, setCancelling] = useState<CorrectionRow | null>(null);

  const cancel = async (request: CorrectionRow) => {
    try {
      await api.post(`/regularizations/${request.id}/cancel`);
      toast('The request is cancelled.');
    } catch (failure) {
      toast(messageOf(failure), 'error');
    }
    reload();
    onChanged();
  };

  // Someone who has never asked for anything is not shown an empty box about it.
  if (data && data.total === 0) return null;

  return (
    <section className="card" aria-labelledby="my-requests" style={{ marginTop: 18 }}>
      <div className="card-head">
        <div>
          <h2 className="card-title" id="my-requests">
            Correction requests
          </h2>
          <p className="card-sub">What you have asked for, newest first. Open a day in the calendar to ask for another.</p>
        </div>
      </div>
      {error && !data ? (
        <LoadError message={error} onRetry={reload} />
      ) : !data ? (
        <SkeletonLines lines={3} />
      ) : (
        <>
          <ul className="request-list">
            {data.items.map((request) => {
              const status = REQUEST_STATUS[request.status];
              const asked = changeInWords(request.requested, request.date, request.timeZone ?? timeZone).join(' · ');
              return (
                <li key={request.id}>
                  <div>
                    <button type="button" className="link" onClick={() => onOpen(request.date)}>
                      {dayInWords(request.date)} {request.date.slice(0, 4)}
                    </button>
                    <span>
                      {CORRECTION_INFO[request.type].label}
                      {asked ? `: ${asked.toLowerCase()}` : ''}
                    </span>
                    {request.status !== 'pending' && request.status !== 'cancelled' && (
                      <span>
                        {status.label} by {request.decidedByName ?? 'someone'}
                        {request.decidedAt ? ` on ${shortDate(request.decidedAt, timeZone)}` : ''}
                        {request.decisionNote ? `: “${request.decisionNote}”` : ''}
                      </span>
                    )}
                  </div>
                  <Badge color={status.tone}>{status.label}</Badge>
                  {request.status === 'pending' && (
                    <button type="button" className="btn ghost sm" onClick={() => setCancelling(request)}>
                      Cancel
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {data.total > data.pageSize && <Pager page={data.page} pages={Math.ceil(data.total / data.pageSize)} total={data.total} pageSize={data.pageSize} onPage={setPage} noun="requests" />}
        </>
      )}
      {cancelling && <Confirm title="Cancel this request?" body={`Your request for ${dayInWords(cancelling.date)} is taken back and nobody decides it. You can ask again afterwards.`} confirmLabel="Cancel the request" onConfirm={() => void cancel(cancelling)} onClose={() => setCancelling(null)} />}
    </section>
  );
}
