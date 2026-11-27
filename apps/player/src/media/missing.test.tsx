import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@pastel-studio/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotifyContext } from '../shell/notify';
import { strings } from '../strings';
import { resetHistory } from './history';
import type { LibSeries, LibTrack, LibVideo } from './library';
import { MissingDialogs } from './missing';
import { PlaybackProvider, usePlayback } from './playback';
import { buildHome, nextEpisode, shelve } from './streaming';

const song = (n: number, more: Partial<LibTrack> = {}): LibTrack => ({
  id: `t${n}`,
  title: `Song ${n}`,
  artist: 'Marta Vey',
  album: 'Low Tide',
  number: n,
  disc: null,
  year: null,
  duration: 200,
  path: `D:/Music/Low Tide/${n}.mp3`,
  unplayable: false,
  ...more,
});
const video = (title: string, more: Partial<LibVideo> = {}): LibVideo => ({
  id: `v-${title}`,
  title,
  year: 2001,
  season: null,
  episode: null,
  episodeTitle: null,
  fileName: `${title}.mkv`,
  path: `D:/Films/${title}.mkv`,
  duration: 6000,
  addedAt: 100,
  ...more,
});

beforeEach(() => {
  window.localStorage.clear();
  resetHistory();
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
  HTMLMediaElement.prototype.load = () => {};
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <PlaybackProvider greet={false}>
    <NotifyContext.Provider value={vi.fn()}>
      <MissingDialogs>{children}</MissingDialogs>
    </NotifyContext.Provider>
  </PlaybackProvider>
);

describe('A file the library can’t find', () => {
  it('is not played: the window says so, and a queue goes past it', () => {
    const { result } = renderHook(() => usePlayback(), { wrapper });
    // Asked for by name: nothing plays, the dialog opens
    act(() => result.current.playTracks([song(1, { missing: true }), song(2)], 0));
    expect(result.current.current).toBeNull();
    expect(screen.getByRole('dialog', { name: strings.missing.title })).toBeTruthy();
    expect(screen.getByText('D:/Music/Low Tide/1.mp3')).toBeTruthy();

    // In a queue behind the song asked for: it is passed over
    act(() => result.current.playTracks([song(1), song(2, { missing: true }), song(3)], 0));
    act(() => result.current.next());
    expect(result.current.current?.id).toBe('t3');
    // And it can't be queued
    act(() => {
      expect(result.current.addToQueue([song(8, { missing: true })])).toBe(0);
    });
  });

  it('opens the same dialog for a video', () => {
    const { result } = renderHook(() => usePlayback(), { wrapper });
    act(() => result.current.playVideo(video('Night Train', { missing: true })));
    expect(result.current.video).toBeNull();
    expect(screen.getByRole('dialog', { name: strings.missing.title })).toBeTruthy();
    expect(screen.getByRole('button', { name: strings.missing.find })).toBeTruthy();
    expect(screen.getByRole('button', { name: strings.missing.remove })).toBeTruthy();
  });

  it('closes with Cancel and leaves everything as it was', async () => {
    const user = userEvent.setup();
    function Open() {
      const { playVideo } = usePlayback();
      return <Button onClick={() => playVideo(video('Night Train', { missing: true }))}>open</Button>;
    }
    render(<Open />, { wrapper });
    await user.click(screen.getByRole('button', { name: 'open' }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is left out of Home, and is never the episode a series goes on with', () => {
    const episodes = [1, 2, 3].map((n) => video(`Show ${n}`, { season: 1, episode: n, missing: n === 1 }));
    const series: LibSeries = { id: 's1', title: 'Show', episodes };
    expect(nextEpisode(series, new Map())?.episode).toBe(2);
    const home = buildHome(shelve({ movies: [video('Here'), video('Gone', { missing: true })], series: [series] }), new Map());
    expect(home.unwatched.map((p) => p.video.title)).not.toContain('Gone');
    expect(home.newFilms.map((v) => v.title)).toEqual(['Here']);
    const all = { ...series, episodes: episodes.map((e) => ({ ...e, missing: true })) };
    expect(buildHome(shelve({ movies: [], series: [all] }), new Map()).newSeries).toHaveLength(0);
  });
});
