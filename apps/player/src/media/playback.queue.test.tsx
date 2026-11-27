import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetHistory } from './history';
import type { LibTrack } from './library';
import { PlaybackProvider, usePlayback } from './playback';
import { readLastSession } from './session';

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
  resetHistory();
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
  HTMLMediaElement.prototype.load = () => {};
});

/** The player with five songs queued and the second one playing. */
function playing() {
  const wrapper = ({ children }: { children: ReactNode }) => <PlaybackProvider greet={false}>{children}</PlaybackProvider>;
  const { result } = renderHook(() => usePlayback(), { wrapper });
  act(() => result.current.playTracks(songs(5), 1));
  return result;
}
const ids = (queue: LibTrack[]) => queue.map((t) => t.id).join(' ');

describe('The queue, edited while it plays', () => {
  it('moves a song to another one’s place and keeps the playing song playing', () => {
    const p = playing();
    act(() => p.current.moveInQueue('t5', 't3'));
    expect(ids(p.current.queue)).toBe('t1 t2 t5 t3 t4');
    expect(p.current.current?.id).toBe('t2');
    // A song from before the playing one, moved after it: the playing song is now the first
    act(() => p.current.moveInQueue('t1', 't4'));
    expect(ids(p.current.queue)).toBe('t2 t5 t3 t4 t1');
    expect(p.current.index).toBe(0);
    expect(p.current.current?.id).toBe('t2');
  });

  it('takes a song out, but never the one that is playing', () => {
    const p = playing();
    act(() => p.current.removeFromQueue('t4'));
    expect(ids(p.current.queue)).toBe('t1 t2 t3 t5');
    act(() => p.current.removeFromQueue('t2'));
    expect(ids(p.current.queue)).toBe('t1 t2 t3 t5');
    act(() => p.current.removeFromQueue('t1'));
    expect(p.current.index).toBe(0);
    expect(p.current.current?.id).toBe('t2');
  });

  it('clears what comes after the playing song', () => {
    const p = playing();
    act(() => p.current.clearUpNext());
    expect(ids(p.current.queue)).toBe('t1 t2');
    expect(p.current.current?.id).toBe('t2');
  });

  it('puts songs right after the playing one, each once', () => {
    const p = playing();
    let added = 0;
    act(() => {
      added = p.current.playNext([song(5), song(1), song(9), song(9), song(7, { unplayable: true })]);
    });
    expect(added).toBe(3);
    expect(ids(p.current.queue)).toBe('t2 t5 t1 t9 t3 t4');
    expect(p.current.current?.id).toBe('t2');
    // The playing song itself: nothing to do
    act(() => {
      added = p.current.playNext([song(2)]);
    });
    expect(added).toBe(0);
    expect(ids(p.current.queue)).toBe('t2 t5 t1 t9 t3 t4');
  });

  it('adds songs at the end; one that already waits keeps its turn', () => {
    const p = playing();
    let added = 0;
    act(() => {
      added = p.current.addToQueue([song(3), song(1), song(8)]);
    });
    expect(added).toBe(2);
    expect(ids(p.current.queue)).toBe('t2 t3 t4 t5 t1 t8');
    expect(p.current.current?.id).toBe('t2');
  });

  it('plays the songs when nothing is playing', () => {
    const wrapper = ({ children }: { children: ReactNode }) => <PlaybackProvider greet={false}>{children}</PlaybackProvider>;
    const { result } = renderHook(() => usePlayback(), { wrapper });
    act(() => {
      expect(result.current.addToQueue(songs(2))).toBe(2);
    });
    expect(ids(result.current.queue)).toBe('t1 t2');
    expect(result.current.current?.id).toBe('t1');
  });

  it('is what the player greets with next time', () => {
    const p = playing();
    act(() => p.current.moveInQueue('t5', 't3'));
    const kept = readLastSession();
    expect(ids(kept?.queue ?? [])).toBe('t1 t2 t5 t3 t4');
    expect(kept?.index).toBe(1);
  });
});
