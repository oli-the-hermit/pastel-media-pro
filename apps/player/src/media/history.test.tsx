import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { reloadSettings } from '../settings';
import { strings } from '../strings';
import { loadHistory, playOf, progressOf, recordPlay, resetHistory, resumePoint, type Play } from './history';
import type { LibVideo, Library } from './library';

const HEAT = 'D:/Videos/Heat.mkv';

// A library with one film, in place of the one read from the desktop app.
vi.mock('./library', async (original) => {
  const real = await original<typeof import('./library')>();
  const heat: LibVideo = { id: 'm1', title: 'Heat', year: 1995, season: null, episode: null, episodeTitle: null, fileName: 'Heat.mkv', path: 'D:/Videos/Heat.mkv' };
  const library: Library = { ...real.EMPTY_LIBRARY, roots: ['D:/Videos'], movies: [heat] };
  return { ...real, useLibrary: () => library };
});

const stored = () => JSON.parse(window.localStorage.getItem('pastelmedia_history') ?? '[]') as Play[];

beforeEach(() => {
  reloadSettings();
  resetHistory();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
  HTMLMediaElement.prototype.load = () => {};
});

describe('The play history', () => {
  it('keeps where a file was left, counts its plays, and knows when it is finished', async () => {
    recordPlay(HEAT, 0, 6000, false, true);
    recordPlay(HEAT, 1500, 6000, false, false);
    let play = await playOf(HEAT);
    expect(play).toMatchObject({ position: 1500, duration: 6000, finished: false, count: 1 });
    expect(resumePoint(play)).toBe(1500);
    expect(progressOf(play)).toBe(0.25);

    // Nine tenths in is finished: it starts over next time
    recordPlay(HEAT, 5400, 6000, false, false);
    play = await playOf(HEAT);
    expect(play?.finished).toBe(true);
    expect(resumePoint(play)).toBe(0);
    expect(progressOf(play)).toBe(1);

    // A second play; a length of 0 from the engine doesn't erase the known one
    recordPlay(HEAT, 12, 0, false, true);
    play = await playOf(HEAT);
    expect(play).toMatchObject({ finished: false, count: 2, duration: 6000 });
    expect(resumePoint(play)).toBe(0); // less than half a minute in: from the start
  });

  it('stays on the device between visits (the web version)', async () => {
    recordPlay(HEAT, 300, 6000, false, true);
    expect(stored()).toHaveLength(1);
    resetHistory();
    await loadHistory();
    expect(await playOf(HEAT)).toMatchObject({ position: 300, count: 1 });
  });
});

describe('A film left part-way', () => {
  async function openHeat() {
    const user = userEvent.setup();
    render(<App />);
    await user.click(within(screen.getByRole('navigation', { name: strings.nav.label })).getByRole('button', { name: strings.pages.streaming.label }));
    await user.click(screen.getByRole('radio', { name: strings.streaming.views.movies.label }));
    await user.click(screen.getByText('Heat'));
    return user;
  }

  it('offers Play alone when it was never started', async () => {
    await openHeat();
    expect(screen.getByRole('button', { name: strings.videos.play })).toBeTruthy();
    expect(screen.queryByRole('button', { name: strings.videos.startOver })).toBeNull();
  });

  it('picks up where it was left, and can start over', async () => {
    window.localStorage.setItem('pastelmedia_history', JSON.stringify([{ path: HEAT, position: 2480, duration: 6000, finished: false, count: 1, lastPlayedAt: 1 }]));
    const user = await openHeat();
    const resume = await screen.findByRole('button', { name: strings.videos.resume('41:20') });
    expect(screen.getByRole('button', { name: strings.videos.startOver })).toBeTruthy();

    await user.click(resume);
    const video = document.querySelector('video')!;
    await vi.waitFor(() => expect(video.getAttribute('src')).toBe(HEAT));
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(2480);

    // Back, then Start over: the same file from its beginning
    await user.click(within(document.querySelector<HTMLElement>('.ps-video-player')!).getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: strings.videos.startOver }));
    await vi.waitFor(() => expect(video.getAttribute('src')).toBe(HEAT));
    video.currentTime = 0;
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(0);
  });
});
