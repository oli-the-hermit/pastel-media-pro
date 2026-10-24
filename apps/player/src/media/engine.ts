/**
 * The playback engine (libmpv in the Rust side) as the design system's MediaController. In a plain browser
 * there is no engine: the controller stays idle and its actions do nothing.
 */
import { useEffect, useMemo, useState } from 'react';
import { INITIAL_MEDIA_STATE, type MediaController, type MediaState } from '@pastel-studio/react';
import { isTauri } from '../desktop';

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (await import('@tauri-apps/api/core')).invoke<T>(cmd, args);
}

/** What `engine_status` returns; mpv's properties as strings, empty until something loads. */
export interface EngineStatus {
  ready: boolean;
  error?: string | null;
  path?: string;
  pos?: string;
  dur?: string;
  pause?: string;
  volume?: string;
  mute?: string;
  speed?: string;
  eof?: string;
  idle?: string;
  buffering?: string;
  video?: string;
}

export const engine = {
  load: (path: string) => invoke<void>('engine_load', { path }),
  command: (...args: string[]) => invoke<number>('engine_command', { args }),
  set: (name: string, value: string) => invoke<number>('engine_set', { name, value }),
  status: () => invoke<EngineStatus>('engine_status'),
};

export interface Engine extends MediaController {
  status: EngineStatus;
}

const POLL_MS = 250;

function toState(s: EngineStatus): MediaState {
  const loaded = !!s.path && s.idle !== 'yes';
  return {
    ...INITIAL_MEDIA_STATE,
    playing: loaded && s.pause === 'no' && s.eof !== 'yes',
    currentTime: Number(s.pos) || 0,
    duration: Number(s.dur) || 0,
    volume: (Number(s.volume) || 0) / 100,
    muted: s.mute === 'yes',
    rate: Number(s.speed) || 1,
    waiting: s.buffering === 'yes',
    ended: s.eof === 'yes',
  };
}

/** The engine's state, polled four times a second (the S7 pattern). */
export function useEngine(): Engine {
  const [status, setStatus] = useState<EngineStatus>({ ready: false });
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await engine.status();
        if (alive) setStatus(s);
      } catch {
        /* the window is closing */
      }
    };
    const id = setInterval(tick, POLL_MS);
    void tick();
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return useMemo(() => {
    const run = (p: Promise<unknown>) => void p.catch(() => {});
    return {
      ...toState(status),
      status,
      play: () => run(engine.set('pause', 'no')),
      pause: () => run(engine.set('pause', 'yes')),
      toggle: () => run(engine.command('cycle', 'pause')),
      seek: (t: number) => run(engine.command('seek', String(t), 'absolute')),
      skip: (d: number) => run(engine.command('seek', String(d), 'relative')),
      setVolume: (v: number) => run(engine.set('volume', String(Math.round(v * 100)))),
      toggleMute: () => run(engine.command('cycle', 'mute')),
      setRate: (r: number) => run(engine.set('speed', String(r))),
    };
  }, [status]);
}
