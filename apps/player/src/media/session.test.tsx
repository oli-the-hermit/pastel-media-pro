import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { reloadSettings } from '../settings';
import { strings } from '../strings';
import { resetHistory } from './history';
import type { LibTrack } from './library';
import { lastCover, readLastSession, saveLastCover, saveLastPosition, saveLastQueue } from './session';

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
const songs = (count: number) => Array.from({ length: count }, (_, i) => song(i + 1));

beforeEach(() => {
  window.localStorage.clear();
  reloadSettings();
  resetHistory();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
  HTMLMediaElement.prototype.load = () => {};
});

describe('The last session', () => {
  it('keeps the queue, the song it was on and where that song was', () => {
    expect(readLastSession()).toBeNull();
    const queue = songs(3);
    saveLastQueue(queue, 1);
    saveLastPosition(queue[1].path, 75, 210);
    expect(readLastSession()).toEqual({ queue, index: 1, position: 75, duration: 210 });
    // On to the next song: the place kept was the other song's
    saveLastQueue(queue, 2);
    expect(readLastSession()).toMatchObject({ index: 2, position: 0, duration: 200 });
    // Left at its very end: it starts over
    saveLastPosition(queue[2].path, 199.5, 200);
    expect(readLastSession()?.position).toBe(0);
  });

  it('keeps a long queue around the song it was on', () => {
    saveLastQueue(songs(2000), 1200);
    const kept = readLastSession();
    expect(kept?.queue).toHaveLength(500);
    expect(kept?.queue[kept.index].id).toBe('t1201');
    expect(kept?.index).toBe(50);
  });

  it('greets with nothing when what is stored cannot be read', () => {
    window.localStorage.setItem('pastelmedia_last_queue', '{"queue":[{"id":1}],"index":0}');
    expect(readLastSession()).toBeNull();
    window.localStorage.setItem('pastelmedia_last_queue', 'not json');
    expect(readLastSession()).toBeNull();
  });

  it('keeps the cover of the song it was on, for that song only', () => {
    saveLastCover('D:/a.mp3', 'data:image/jpeg;base64,AAAA');
    expect(lastCover('D:/a.mp3')).toBe('data:image/jpeg;base64,AAAA');
    expect(lastCover('D:/b.mp3')).toBeUndefined();
  });
});

describe('The player’s greeting', () => {
  const media = () => document.querySelector('video') as HTMLVideoElement;

  it('shows the last song paused where it was left, with its queue, and loads it only on Play', async () => {
    const queue = songs(3);
    saveLastQueue(queue, 1);
    saveLastPosition(queue[1].path, 75, 200);
    const user = userEvent.setup();
    render(<App />);
    const player = document.querySelector('.mp-player') as HTMLElement;
    expect(within(player).getAllByText('Song 2').length).toBeGreaterThan(0);
    expect(within(player).getByText('1:15')).toBeTruthy();
    // Its queue is beside it: the song after it is up next
    expect(within(player).getByText('Song 3')).toBeTruthy();
    // Nothing was loaded: the engine has no file
    expect(media().getAttribute('src')).toBeNull();

    const play = within(player).getAllByRole('button', { name: 'Play' })[0];
    await user.click(play);
    await waitFor(() => expect(media().getAttribute('src')).toBe(queue[1].path));
  });

  it('greets with nothing when the app was started with files', () => {
    saveLastQueue(songs(2), 0);
    render(<App launchedWithFiles />);
    expect(screen.getByText(strings.pages.player.empty)).toBeTruthy();
    expect(screen.queryByText('Song 1')).toBeNull();
  });
});
