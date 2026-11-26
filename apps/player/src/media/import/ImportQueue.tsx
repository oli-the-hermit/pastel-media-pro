import { useEffect, useState } from 'react';
import { TransferCard, TransferIndicator, TransferRow } from '@pastel-studio/react';
import { strings } from '../../strings';
import { clearFinished, dismissJob, isOver, retryJob, stopJob, useJobs, type Job } from './api';

const folderName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

/** A job's row title: "Adding Films", "Adding 3 files", "Checking Music". */
export function jobTitle(job: Job): string {
  if (job.kind === 'rescan') return strings.queue.checking(job.place ? folderName(job.place) : strings.queue.allFolders);
  return strings.queue.adding(job.place ? folderName(job.place) : strings.queue.files(job.total));
}

/** How a finished job went. */
export function jobResult(job: Job): string {
  if (job.state === 'cancelled') return strings.queue.stopped(job.done, job.total);
  if (job.state === 'failed') return strings.queue.failed;
  return strings.queue.result(job.added, job.updated, job.missing, job.errors.length);
}

const LABELS = { transfers: strings.queue.title, transferCounting: strings.queue.finding };

interface QueueView {
  open: boolean;
  setOpen: (open: boolean) => void;
}

let shared: QueueView = { open: true, setOpen: () => {} };
const followers = new Set<(v: QueueView) => void>();

/** Whether the card shows (the indicator brings it back), shared by the card and the top bar. */
function useQueueOpen(): QueueView {
  const [open, setOpenState] = useState(shared.open);
  useEffect(() => {
    const follow = (v: QueueView) => setOpenState(v.open);
    followers.add(follow);
    return () => {
      followers.delete(follow);
    };
  }, []);
  const setOpen = (o: boolean) => {
    shared = { ...shared, open: o };
    followers.forEach((f) => f(shared));
  };
  return { open, setOpen };
}

/**
 * The import queue (ux.md §2b): a card over the window's corner with a live row per job, its progress, Stop, and
 * Retry for what failed. Hiding or folding it never stops a job; the top bar's indicator brings it back.
 */
export function ImportQueue() {
  const jobs = useJobs();
  const { open, setOpen } = useQueueOpen();
  const [collapsed, setCollapsed] = useState(false);
  const active = jobs.filter((j) => !isOver(j)).length;
  // A new job shows the card again.
  const newest = jobs.at(-1)?.id;
  useEffect(() => {
    if (newest != null) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newest]);
  if (jobs.length === 0 || !open) return null;
  return (
    <TransferCard
      className="mp-queue"
      activeCount={active}
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
      onHide={() => setOpen(false)}
      onClearFinished={jobs.some(isOver) ? () => void clearFinished() : undefined}
      labels={LABELS}
    >
      {jobs.map((job) => (
        <TransferRow
          key={job.id}
          title={jobTitle(job)}
          state={job.state}
          current={job.current ?? undefined}
          doneBytes={job.doneBytes}
          totalBytes={job.totalBytes}
          result={isOver(job) ? jobResult(job) : undefined}
          errors={job.errors}
          onStop={() => void stopJob(job.id)}
          onRetry={() => void retryJob(job.id)}
          onDismiss={() => void dismissJob(job.id)}
        />
      ))}
    </TransferCard>
  );
}

/** The top bar's button for the queue: a ring of overall progress around the number of jobs going. */
export function ImportIndicator() {
  const jobs = useJobs();
  const { open, setOpen } = useQueueOpen();
  const going = jobs.filter((j) => !isOver(j));
  if (jobs.length === 0 || (open && going.length === 0)) return null;
  const total = going.reduce((n, j) => n + j.totalBytes, 0);
  const done = going.reduce((n, j) => n + j.doneBytes, 0);
  return (
    <TransferIndicator
      label={strings.queue.indicator(going.length)}
      count={going.length}
      progress={total > 0 ? done / total : undefined}
      attention={jobs.some((j) => j.state === 'failed' || (isOver(j) && j.errors.length > 0))}
      aria-pressed={open}
      onClick={() => setOpen(!open)}
    />
  );
}
