/**
 * What is playing: a queue of songs, or one video. Songs move on to the next when one ends; songs whose
 * file has no readable audio are skipped. The desktop app plays through libmpv (engine.ts); the browser plays
 * the dev server's files through one HTML video element behind the page, placed where the player's picture goes.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useMediaElement, type MediaController } from '@pastel-studio/react';
import { isDesktop } from '@pastel-studio/desktop';
import { engine, hasPicture, useEngine, type Engine } from './engine';
import { playOf, recordPlay, resumePoint } from './history';
import type { LibTrack, LibVideo } from './library';
import type { Opened } from './opened';
import { readLastSession, saveLastPosition, saveLastQueue } from './session';

/** A file that could not be played: the player says so, with the engine's reason under Details. */
export interface PlayFailure {
  path: string;
  reason: string;
}

/** Where the picture goes on the page, in CSS pixels; `null` when no video shows. */
export type VideoBox = { left: number; top: number; width: number; height: number } | null;

export interface Playback {
  engine: MediaController;
  queue: LibTrack[];
  index: number;
  current: LibTrack | null;
  video: LibVideo | null;
  /**
   * The video's picture is on screen. Until then the player stays solid and shows it is loading; the page only
   * turns see-through, for the picture behind it, once there is a picture to see.
   */
  pictureReady: boolean;
  /** The last thing that could not be played, for a toast: 'unplayable', 'browser', or the engine's reason. */
  error: string | null;
  /** A song that could not be opened and was skipped, for a toast (its path). */
  skipped: string | null;
  /** The file that could not be opened, when nothing else plays: the player shows it. */
  failure: PlayFailure | null;
  playTracks: (tracks: LibTrack[], index: number) => void;
  /** Plays a video where it was left, when it was left part-way; `fromStart` plays it from its start. */
  playVideo: (video: LibVideo, opts?: { fromStart?: boolean }) => void;
  /**
   * Files the system handed the app play at once (D16): a video when the first file is one, otherwise the songs
   * among them as the queue. (A queue of videos comes with the player's queue.)
   */
  playOpened: (items: Opened[]) => void;
  next: () => void;
  previous: () => void;
  // The queue, edited while it plays. The song that is playing keeps playing and keeps its place; a song is in the
  // queue once, so one that is already there moves instead of being added again.
  /** Moves a song to where another one is (the queue's drag and Alt+arrows). */
  moveInQueue: (sourceId: string, targetId: string) => void;
  /** Takes a song out of the queue; not the one that is playing. */
  removeFromQueue: (id: string) => void;
  /** Takes out everything after the song that is playing. */
  clearUpNext: () => void;
  /** Puts songs right after the one that is playing; with nothing playing, plays them. How many went in. */
  playNext: (tracks: LibTrack[]) => number;
  /** Puts songs at the end of the queue; with nothing playing, plays them. How many went in. */
  addToQueue: (tracks: LibTrack[]) => number;
  /** Stops and leaves the video, if one is playing. */
  stop: () => void;
  clearError: () => void;
  clearSkipped: () => void;
  clearFailure: () => void;
  /** The browser engine's picture box (the desktop engine is placed with margins instead, VideoView). */
  setVideoBox: (box: VideoBox) => void;
}

/** One way to play files: the media controller, the file it is on, the file that just ended, and how to load and stop. */
interface Backend {
  media: MediaController;
  /** The file the controller's time and length belong to; empty with nothing loaded. */
  path: string;
  endedPath: string;
  load: (path: string, start?: number) => Promise<void>;
  stop: () => void;
}

function useMpvBackend(): Backend & { media: Engine } {
  const media = useEngine();
  const path = media.status.idle === 'yes' ? '' : (media.status.path ?? '');
  const endedPath = media.status.eof === 'yes' ? path : '';
  return useMemo(() => ({ media, path, endedPath, load: engine.load, stop: () => void engine.command('stop').catch(() => {}) }), [media, path, endedPath]);
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
    async (path: string, start?: number) => {
      const v = el.current;
      if (!v) return;
      setSrc(path);
      v.src = path;
      // From where it was left: the element takes a position once it knows the file.
      if (start && start > 0) v.addEventListener('loadedmetadata', () => (v.currentTime = start), { once: true });
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
  return useMemo(() => ({ media, path: src, endedPath, load, stop }), [media, src, endedPath, load, stop]);
}

const Ctx = createContext<Playback | null>(null);

const playableFrom = (tracks: LibTrack[], start: number, step: 1 | -1) => {
  for (let i = start; i >= 0 && i < tracks.length; i += step) if (!tracks[i].unplayable) return i;
  return -1;
};

/**
 * `greet`: start with the last session's song (session.ts), paused where it was left, its queue around it. Off when
 * the app was started with files, which play at once.
 */
export function PlaybackProvider({ children, greet = true }: { children: React.ReactNode; greet?: boolean }) {
  const native = isDesktop();
  const videoEl = useRef<HTMLVideoElement>(null);
  const [greeting] = useState(() => (greet ? readLastSession() : null));
  const [queue, setQueue] = useState<LibTrack[]>(() => greeting?.queue ?? []);
  const [index, setIndex] = useState(() => greeting?.index ?? -1);
  // Where the song the player greets with waits; nothing once a file was loaded. The engine has no file until Play.
  const [greetAt, setGreetAt] = useState<{ position: number; duration: number } | null>(() =>
    greeting ? { position: greeting.position, duration: greeting.duration } : null,
  );
  const [video, setVideo] = useState<LibVideo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string | null>(null);
  const [failure, setFailure] = useState<PlayFailure | null>(null);
  const [box, setVideoBox] = useState<VideoBox>(null);
  // The path of the video whose picture is up, and when its file was asked for.
  const [pictureFor, setPictureFor] = useState<string | null>(null);
  const askedAt = useRef(0);
  const stopTimer = useRef<number>();

  const mpv = useMpvBackend();
  const web = useWebBackend(videoEl, setError);
  const backend = native ? mpv : web;
  const { load: loadFile, stop: stopFile, media, endedPath } = backend;

  // ── History: where each file is, written down as it plays (history.ts) ──
  // What plays now, and the engine's time and length for it. While the engine is still on the file before, these
  // stay that file's: what is saved always belongs to the path it is saved under.
  const nowPath = video?.path ?? (index >= 0 ? queue[index]?.path : undefined) ?? '';
  const at = useRef({ path: '', position: 0, duration: 0 });
  // Where the file was asked to start, until the engine gets there: leaving before it does must not write a
  // position of zero over the place the film was left.
  const startAt = useRef(0);
  if (nowPath && backend.path === nowPath) {
    at.current = { path: nowPath, position: media.currentTime, duration: media.duration };
    if (startAt.current > 0 && media.currentTime >= startAt.current - 5) startAt.current = 0;
  }
  const counted = useRef('');
  // The song of a queue made on a page (not files the system handed over, which may not be in the library): it
  // and its queue are what the player greets with next time.
  const fromSystem = useRef(false);
  const songPath = useRef('');
  songPath.current = !video && index >= 0 && !fromSystem.current ? (queue[index]?.path ?? '') : '';
  const save = useCallback((ended = false) => {
    const a = at.current;
    if (!a.path || (!ended && startAt.current > 0)) return;
    recordPlay(a.path, a.position, a.duration, ended, counted.current !== a.path);
    counted.current = a.path;
    if (a.path === songPath.current) saveLastPosition(a.path, a.position, a.duration);
  }, []);
  useEffect(() => {
    if (index >= 0 && queue.length > 0 && !fromSystem.current) saveLastQueue(queue, index);
  }, [queue, index]);

  const load = useCallback(
    (path: string, start?: number) => {
      window.clearTimeout(stopTimer.current);
      setFailure(null);
      setGreetAt(null);
      // Playing the same file again is one more play.
      if (counted.current === path) counted.current = '';
      startAt.current = start && start > 0 ? start : 0;
      void loadFile(path, start).catch((e) => setError(String(e)));
    },
    [loadFile],
  );

  const playTracks = useCallback(
    (tracks: LibTrack[], start: number) => {
      const i = playableFrom(tracks, start, 1);
      if (i < 0) {
        setError('unplayable');
        return;
      }
      fromSystem.current = false;
      // The song asked for has no audio the player can read: say so rather than start another one silently.
      if (i > start) setSkipped(tracks[start].path);
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

  // ── The queue, edited while it plays ──
  // Every change keeps the playing song where the index says it is.
  const requeue = useCallback(
    (change: (songs: LibTrack[], now: LibTrack) => LibTrack[]) => {
      const now = index >= 0 ? queue[index] : undefined;
      if (!now || video) return false;
      const songs = change(queue, now);
      setQueue(songs);
      setIndex(songs.findIndex((t) => t.id === now.id));
      return true;
    },
    [queue, index, video],
  );
  const moveInQueue = useCallback(
    (sourceId: string, targetId: string) => {
      requeue((songs) => {
        const from = songs.findIndex((t) => t.id === sourceId);
        const to = songs.findIndex((t) => t.id === targetId);
        if (from < 0 || to < 0 || from === to) return songs;
        const out = [...songs];
        out.splice(to, 0, ...out.splice(from, 1));
        return out;
      });
    },
    [requeue],
  );
  const removeFromQueue = useCallback((id: string) => void requeue((songs, now) => (id === now.id ? songs : songs.filter((t) => t.id !== id))), [requeue]);
  const clearUpNext = useCallback(() => void requeue((songs, now) => songs.slice(0, songs.findIndex((t) => t.id === now.id) + 1)), [requeue]);
  /** Songs go in after the playing one (`next`) or at the end. The ones that can't be played stay out. */
  const enqueue = useCallback(
    (tracks: LibTrack[], next: boolean) => {
      const wanted = tracks.filter((t, i) => !t.unplayable && tracks.findIndex((x) => x.id === t.id) === i);
      if (wanted.length === 0) return 0;
      let added = 0;
      const queued = requeue((songs, now) => {
        const at = songs.findIndex((t) => t.id === now.id);
        // At the end, a song that already waits keeps its turn; played ones come back. Next, the asked songs come first.
        const waiting = new Set(next ? [] : songs.slice(at + 1).map((t) => t.id));
        const add = wanted.filter((t) => t.id !== now.id && !waiting.has(t.id));
        added = add.length;
        const ids = new Set(add.map((t) => t.id));
        const rest = songs.filter((t) => !ids.has(t.id));
        const place = next ? rest.findIndex((t) => t.id === now.id) + 1 : rest.length;
        return [...rest.slice(0, place), ...add, ...rest.slice(place)];
      });
      if (queued) return added;
      // Nothing plays (or a video does): the songs are the queue.
      playTracks(wanted, 0);
      return wanted.length;
    },
    [requeue, playTracks],
  );
  const playNext = useCallback((tracks: LibTrack[]) => enqueue(tracks, true), [enqueue]);
  const addToQueue = useCallback((tracks: LibTrack[]) => enqueue(tracks, false), [enqueue]);

  // A video left part-way picks up there by itself; its page offers "Start over".
  const asked = useRef(0);
  const playVideo = useCallback(
    (v: LibVideo, opts?: { fromStart?: boolean }) => {
      setQueue([]);
      setIndex(-1);
      setVideo(v);
      setPictureFor(null);
      askedAt.current = Date.now();
      const mine = ++asked.current;
      if (opts?.fromStart) {
        load(v.path);
        return;
      }
      void playOf(v.path).then(
        (play) => mine === asked.current && load(v.path, resumePoint(play)),
        () => mine === asked.current && load(v.path),
      );
    },
    [load],
  );

  const playOpened = useCallback(
    (items: Opened[]) => {
      const first = items[0];
      if (!first) return;
      if (first.kind === 'video') playVideo(first);
      else {
        playTracks(items.filter((i): i is Opened & { kind: 'audio' } => i.kind === 'audio'), 0);
        fromSystem.current = true;
      }
    },
    [playVideo, playTracks],
  );

  // The video leaves the page first, which turns it solid; the engine lets go of its picture a moment later,
  // so nothing behind the window shows in between.
  const stop = useCallback(() => {
    const wasVideo = video != null;
    asked.current += 1;
    setVideo(null);
    setPictureFor(null);
    setQueue([]);
    setIndex(-1);
    setGreetAt(null);
    window.clearTimeout(stopTimer.current);
    if (wasVideo) stopTimer.current = window.setTimeout(stopFile, 80);
    else stopFile();
  }, [stopFile, video]);

  // The picture is up: the engine says so (the desktop app), or the element knows its size (the browser).
  const status = native ? mpv.media.status : null;
  const webSized = !native && web.media.width > 0 && web.media.duration > 0;
  useEffect(() => {
    if (!video || pictureFor === video.path) return;
    if (status ? hasPicture(status, video.path, Date.now() - askedAt.current) : webSized) setPictureFor(video.path);
  }, [video, pictureFor, status, webSized]);

  // A file the engine could not open (mpv's end-file error): a song is skipped for the next one; otherwise the
  // player says so. Each failure once: failures from before this page loaded are not shown.
  const loadError = native ? mpv.media.status.loadError ?? null : null;
  const seenFailure = useRef<number | null>(null);
  useEffect(() => {
    const seq = loadError?.seq ?? 0;
    if (seenFailure.current === null) {
      seenFailure.current = seq;
      return;
    }
    if (!loadError || seq <= seenFailure.current) return;
    seenFailure.current = seq;
    const song = index >= 0 ? queue[index] : undefined;
    if (song && song.path === loadError.path) {
      const i = playableFrom(queue, index + 1, 1);
      if (i >= 0) {
        setSkipped(loadError.path);
        setIndex(i);
        load(queue[i].path);
        return;
      }
    }
    if (!song && !(video && video.path === loadError.path)) return;
    setVideo(null);
    setQueue([]);
    setIndex(-1);
    setFailure({ path: loadError.path, reason: loadError.reason });
  }, [loadError, index, queue, video, load]);

  // When a song ends, the next one starts; once per song.
  const advancedFor = useRef('');
  useEffect(() => {
    if (!endedPath || video || advancedFor.current === endedPath) return;
    advancedFor.current = endedPath;
    step(1);
  }, [endedPath, video, step]);

  // Saved: when a file ends, when it is paused, every ten seconds while it plays, when another file takes its
  // place (or nothing does), and when the window closes.
  useEffect(() => {
    if (endedPath && endedPath === at.current.path) save(true);
  }, [endedPath, save]);
  const playing = media.playing;
  useEffect(() => {
    if (!nowPath) return;
    if (!playing) {
      // Paused part-way (not: still loading)
      if (at.current.path === nowPath && at.current.position > 0) save();
      return;
    }
    const id = window.setInterval(save, 10_000);
    return () => window.clearInterval(id);
  }, [nowPath, playing, save]);
  useEffect(() => {
    if (!nowPath) return;
    return () => save();
  }, [nowPath, save]);
  useEffect(() => {
    const leave = () => save();
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, [save]);

  // The song the player greets with: the pages see it paused where it was left, though the engine holds no file.
  // Play loads it there; moving along its bar before that only moves where it will start.
  const greeted = greetAt && !video && index >= 0 ? queue[index] : undefined;
  const shownMedia = useMemo<MediaController>(() => {
    if (!greeted || !greetAt) return media;
    const start = () => load(greeted.path, greetAt.position);
    const length = greetAt.duration || greeted.duration;
    const moveTo = (time: number) => setGreetAt({ ...greetAt, position: Math.max(0, Math.min(time, length || time)) });
    return {
      ...media,
      playing: false,
      waiting: false,
      ended: false,
      currentTime: greetAt.position,
      duration: length,
      play: start,
      toggle: start,
      seek: moveTo,
      skip: (delta) => moveTo(greetAt.position + delta),
    };
  }, [media, greeted, greetAt, load]);

  const value = useMemo<Playback>(
    () => ({
      engine: shownMedia,
      queue,
      index,
      current: index >= 0 ? queue[index] ?? null : null,
      video,
      pictureReady: !!video && pictureFor === video.path,
      error,
      skipped,
      failure,
      playTracks,
      playVideo,
      playOpened,
      next: () => step(1),
      previous: () => step(-1),
      moveInQueue,
      removeFromQueue,
      clearUpNext,
      playNext,
      addToQueue,
      stop,
      clearError: () => setError(null),
      clearSkipped: () => setSkipped(null),
      clearFailure: () => setFailure(null),
      setVideoBox,
    }),
    [
      shownMedia, queue, index, video, pictureFor, error, skipped, failure, playTracks, playVideo, playOpened, step, stop,
      moveInQueue, removeFromQueue, clearUpNext, playNext, addToQueue,
    ],
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
