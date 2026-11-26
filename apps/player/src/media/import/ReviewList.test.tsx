import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { strings } from '../../strings';
import type { Job } from './api';
import { PRESETS } from './filters';
import { jobResult, jobTitle } from './ImportQueue';
import { ReviewList, toRow, withFacts, type Row } from './ReviewList';

function rows(): Row[] {
  const list = [
    { rel: 'Heat (1995)/Heat.mkv', kind: 'video', size: 4e9 },
    { rel: 'Heat (1995)/Sample/heat-sample.mkv', kind: 'video', size: 5e7 },
    { rel: 'Recording 2026-05-18 141121.mp4', kind: 'video', size: 3e7 },
    { rel: 'Album/01 Song.mp3', kind: 'audio', size: 5e6 },
    { rel: 'Old (1970).mkv', kind: 'video', size: 2e9, inLibrary: true },
  ].map((f, i) =>
    toRow({
      i,
      path: `D:\\Media\\${f.rel.split('/').join('\\')}`,
      rel: f.rel,
      name: f.rel.split('/').pop()!,
      ext: f.rel.split('.').pop()!,
      kind: f.kind as 'audio' | 'video',
      size: f.size,
      inLibrary: !!f.inLibrary,
      skipped: false,
    }),
  );
  withFacts(list, [
    { i: 0, duration: 6000, width: 1920, height: 800 },
    { i: 1, duration: 60, width: 1920, height: 1080 },
    { i: 2, duration: 30, width: 1674, height: 1012 },
    { i: 3, duration: 240, width: null, height: null },
    { i: 4, duration: 5400, width: 1280, height: 720 },
  ]);
  return list;
}

function show(onImport = vi.fn()) {
  render(
    <ReviewList
      rows={rows()}
      version={1}
      status={{ listing: false, probed: 5, done: true }}
      initialFilters={PRESETS.movies}
      inside={null}
      showList
      onShowListChange={() => {}}
      onImport={onImport}
      onCancel={() => {}}
    />,
  );
  return onImport;
}

describe('the review list', () => {
  it('shows what passes the preset: the film, not its sample, the recording, the song or what is in the library', () => {
    show();
    expect(screen.getByText('Heat.mkv')).toBeTruthy();
    expect(screen.queryByText('heat-sample.mkv')).toBeNull();
    expect(screen.queryByText('Recording 2026-05-18 141121.mp4')).toBeNull();
    expect(screen.queryByText('01 Song.mp3')).toBeNull();
    expect(screen.queryByText('Old (1970).mkv')).toBeNull();
    // A scope film's 1920×800 reads 1080p.
    expect(screen.getByText('1080p')).toBeTruthy();
    expect(screen.getByRole('button', { name: strings.review.import(1) })).toBeTruthy();
  });

  it('changes preset live, and adds what is checked; what was unchecked is remembered', async () => {
    const user = userEvent.setup();
    const onImport = show();
    await user.click(screen.getByRole('radio', { name: strings.library.presets.everything }));
    expect(screen.getByText('01 Song.mp3')).toBeTruthy();
    expect(screen.getByText('heat-sample.mkv')).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: strings.review.check('heat-sample.mkv') }));
    await user.click(screen.getByRole('button', { name: strings.review.import(3) }));
    const choice = onImport.mock.calls[0][0];
    expect(choice.files).toHaveLength(3);
    expect(choice.skipped).toEqual(['D:\\Media\\Heat (1995)\\Sample\\heat-sample.mkv']);
    expect(choice.filters.preset).toBe('everything');
  });

  it('shows what is in the library when asked, without adding it again', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('checkbox', { name: strings.review.hideInLibrary }));
    expect(screen.getByText('Old (1970).mkv')).toBeTruthy();
    expect(screen.getByRole('button', { name: strings.review.import(1) })).toBeTruthy();
  });
});

describe('the queue rows', () => {
  const job = (more: Partial<Job>): Job => ({
    id: 1, kind: 'import', place: 'D:\\Media\\Films', state: 'done', total: 10, done: 10, totalBytes: 1, doneBytes: 1, current: null,
    added: 0, updated: 0, missing: 0, errors: [], quiet: false, ...more,
  });

  it('say what they do and how it went', () => {
    expect(jobTitle(job({}))).toBe(strings.queue.adding('Films'));
    expect(jobTitle(job({ place: null, total: 3 }))).toBe(strings.queue.adding(strings.queue.files(3)));
    expect(jobTitle(job({ kind: 'rescan', place: null }))).toBe(strings.queue.checking(strings.queue.allFolders));
    expect(jobResult(job({ added: 8, missing: 1 }))).toBe('8 added · 1 can\'t be found');
    expect(jobResult(job({}))).toBe('Nothing new');
    expect(jobResult(job({ state: 'cancelled', done: 4 }))).toBe(strings.queue.stopped(4, 10));
  });
});
