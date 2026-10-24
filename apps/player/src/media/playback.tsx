/**
 * What is playing: a queue of songs, or one video. Songs move on to the next when one ends; songs whose
 * file has no readable audio are skipped.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { engine, useEngine, type Engine } from './engine';
import type { LibTrack, LibVideo } from './library';

export interface Playback {
  engine: Engine;
  queue: LibTrack[];
  index: number;
  current: LibTrack | null;
  video: LibVideo | null;
  /** The last thing that could not be played, for a toast. */
  error: string | null;
  playTracks: (tracks: LibTrack[], index: number) => void;
  playVideo: (video: LibVideo) => void;
  next: () => void;
  previous: () => void;
  /** Stops and leaves the video, if one is playing. */
  stop: () => void;
  clearError: () => void;
}

const Ctx = createContext<Playback | null>(null);

const playableFrom = (tracks: LibTrack[], start: number, step: 1 | -1) => {
  for (let i = start; i >= 0 && i < tracks.length; i += step) if (!tracks[i].unplayable) return i;
  return -1;
};

export function PlaybackProvider({ children }: { children: React.ReactNode }) {
  const media = useEngine();
  const [queue, setQueue] = useState<LibTrack[]>([]);
  const [index, setIndex] = useState(-1);
  const [video, setVideo] = useState<LibVideo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((path: string) => {
    engine.load(path).catch((e) => setError(String(e)));
  }, []);

  const playTracks = useCallback(
    (tracks: LibTrack[], start: number) => {
      const i = playableFrom(tracks, start, 1);
      if (i < 0) {
        setError('unplayable');
        return;
      }
      setVideo(null);
      setQueue(tracks);
      setIndex(i);
      load(tracks[i].path);
    },
    [load],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      const i = playableFrom(queue, index + dir, dir);
      if (i < 0) return;
      setIndex(i);
      load(queue[i].path);
    },
    [queue, index, load],
  );

  const playVideo = useCallback(
    (v: LibVideo) => {
      setQueue([]);
      setIndex(-1);
      setVideo(v);
      load(v.path);
    },
    [load],
  );

  const stop = useCallback(() => {
    void engine.command('stop').catch(() => {});
    setVideo(null);
    setQueue([]);
    setIndex(-1);
  }, []);

  // When a song ends, the next one starts; once per song.
  const advancedFor = useRef('');
  const ended = media.status.eof === 'yes' ? media.status.path ?? '' : '';
  useEffect(() => {
    if (!ended || video || advancedFor.current === ended) return;
    advancedFor.current = ended;
    step(1);
  }, [ended, video, step]);

  const value = useMemo<Playback>(
    () => ({
      engine: media,
      queue,
      index,
      current: index >= 0 ? queue[index] ?? null : null,
      video,
      error,
      playTracks,
      playVideo,
      next: () => step(1),
      previous: () => step(-1),
      stop,
      clearError: () => setError(null),
    }),
    [media, queue, index, video, error, playTracks, playVideo, step, stop],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlayback(): Playback {
  const p = useContext(Ctx);
  if (!p) throw new Error('usePlayback needs a PlaybackProvider');
  return p;
}
