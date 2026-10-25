/**
 * What is playing: a queue of songs, or one video. Songs move on to the next when one ends; songs whose
 * file has no readable audio are skipped. The desktop app plays through libmpv (engine.ts); the browser plays
 * the dev server's files through one HTML video element behind the page, placed where the player's picture goes.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useMediaElement, type MediaController } from '@pastel-studio/react';
import { isTauri } from '../desktop';
import { engine, useEngine } from './engine';
import type { LibTrack, LibVideo } from './library';

/** Where the picture goes on the page, in CSS pixels; `null` when no video shows. */
export type VideoBox = { left: number; top: number; width: number; height: number } | null;

export interface Playback {
  engine: MediaController;
  queue: LibTrack[];
  index: number;
  current: LibTrack | null;
  video: LibVideo | null;
  /** The last thing that could not be played, for a toast: 'unplayable', 'browser', or the engine's reason. */
  error: string | null;
  playTracks: (tracks: LibTrack[], index: number) => void;
  playVideo: (video: LibVideo) => void;
  next: () => void;
  previous: () => void;
  /** Stops and leaves the video, if one is playing. */
  stop: () => void;
  clearError: () => void;
  /** The browser engine's picture box (the desktop engine is placed with margins instead, VideoView). */
  setVideoBox: (box: VideoBox) => void;
}

/** One way to play files: the media controller, the file that just ended, and how to load and stop. */
interface Backend {
  media: MediaController;
  endedPath: string;
  load: (path: string) => Promise<void>;
  stop: () => void;
}

function useMpvBackend(): Backend {
  const media = useEngine();
  const endedPath = media.status.eof === 'yes' ? media.status.path ?? '' : '';
  return useMemo(() => ({ media, endedPath, load: engine.load, stop: () => void engine.command('stop').catch(() => {}) }), [media, endedPath]);
}

function useWebBackend(el: React.RefObject<HTMLVideoElement>, onError: (e: string) => void): Backend {
  const media = useMediaElement(el);
  const [src, setSrc] = useState('');
  useEffect(() => {
    const v = el.current;
    if (!v) return;
    // A file the browser cannot decode (MKV, AC-3, WMA…): the desktop app can.
    const fail = () => {
      if (v.getAttribute('src')) onError('browser');
    };
    v.addEventListener('error', fail);
    return () => v.removeEventListener('error', fail);
  }, [el, onError]);
  const load = useCallback(
    async (path: string) => {
      const v = el.current;
      if (!v) return;
      setSrc(path);
      v.src = path;
      await v.play().catch((e: Error) => {
        // A newer load interrupted this one, or the browser wants a click before sound: not a file the browser cannot play
        // (that one fires the element's error event). In the second case the player waits paused for Play.
        if (e.name !== 'AbortError' && e.name !== 'NotAllowedError') onError('browser');
      });
    },
    [el, onError],
  );
  const stop = useCallback(() => {
    const v = el.current;
    if (!v) return;
    v.pause();
    v.removeAttribute('src');
    v.load();
    setSrc('');
  }, [el]);
  const endedPath = media.ended ? src : '';
  return useMemo(() => ({ media, endedPath, load, stop }), [media, endedPath, load, stop]);
}

const Ctx = createContext<Playback | null>(null);

const playableFrom = (tracks: LibTrack[], start: number, step: 1 | -1) => {
  for (let i = start; i >= 0 && i < tracks.length; i += step) if (!tracks[i].unplayable) return i;
  return -1;
};

export function PlaybackProvider({ children }: { children: React.ReactNode }) {
  const native = isTauri();
  const videoEl = useRef<HTMLVideoElement>(null);
  const [queue, setQueue] = useState<LibTrack[]>([]);
  const [index, setIndex] = useState(-1);
  const [video, setVideo] = useState<LibVideo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [box, setVideoBox] = useState<VideoBox>(null);

  const mpv = useMpvBackend();
  const web = useWebBackend(videoEl, setError);
  const backend = native ? mpv : web;
  const { load: loadFile, stop: stopFile, media, endedPath } = backend;

  const load = useCallback((path: string) => void loadFile(path).catch((e) => setError(String(e))), [loadFile]);

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
    stopFile();
    setVideo(null);
    setQueue([]);
    setIndex(-1);
  }, [stopFile]);

  // When a song ends, the next one starts; once per song.
  const advancedFor = useRef('');
  useEffect(() => {
    if (!endedPath || video || advancedFor.current === endedPath) return;
    advancedFor.current = endedPath;
    step(1);
  }, [endedPath, video, step]);

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
      setVideoBox,
    }),
    [media, queue, index, video, error, playTracks, playVideo, step, stop],
  );
  const shown = !!video && !!box;
  return (
    <Ctx.Provider value={value}>
      {/* First in the page, so the app's layer after it paints above it (no z-index needed). */}
      {!native && (
        <video
          ref={videoEl}
          className={shown ? 'mp-web-video is-shown' : 'mp-web-video'}
          style={box ? { left: box.left, top: box.top, width: box.width, height: box.height } : undefined}
          playsInline
        />
      )}
      <div className="mp-app-layer">{children}</div>
    </Ctx.Provider>
  );
}

export function usePlayback(): Playback {
  const p = useContext(Ctx);
  if (!p) throw new Error('usePlayback needs a PlaybackProvider');
  return p;
}
