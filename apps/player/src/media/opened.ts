/**
 * Files the system hands the app ("Open with", a double-click, a second launch, a drop on the window, the Open
 * dialog). The Rust side (`open.rs`) collects a burst into one batch, allows exactly those files for the engine
 * and tells the page; they play at once (D16). Only the desktop app receives files.
 */
import { useEffect, useRef } from 'react';
import { isDesktop } from '@pastel-studio/desktop';
import { strings } from '../strings';
import type { LibTrack, LibVideo } from './library';

export type Opened = ({ kind: 'audio' } & LibTrack) | ({ kind: 'video' } & LibVideo);

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (await import('@tauri-apps/api/core')).invoke<T>(cmd, args);
}

/** Whether the app was started with files: they arrive a moment later, and the page opens on the player. */
export async function launchedWithFiles(): Promise<boolean> {
  if (!isDesktop()) return false;
  return invoke<boolean>('open_launched').catch(() => false);
}

/** The Open dialog; resolves to the files picked (none when cancelled). */
export async function pickFiles(): Promise<Opened[]> {
  return invoke<Opened[]>('open_pick', { title: strings.player.dialogTitle, audioLabel: strings.player.audioFiles, videoLabel: strings.player.videoFiles });
}

/** Calls `onFiles` with every batch the system hands the app, including one that came before the page was ready. */
export function useOpenedFiles(onFiles: (items: Opened[]) => void): void {
  const latest = useRef(onFiles);
  latest.current = onFiles;
  useEffect(() => {
    if (!isDesktop()) return;
    let alive = true;
    let off: (() => void) | undefined;
    const take = () =>
      void invoke<Opened[]>('open_take').then(
        (items) => alive && items.length > 0 && latest.current(items),
        () => {},
      );
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen('open-files', take))
      .then((unlisten) => {
        if (alive) off = unlisten;
        else unlisten();
        // Anything that arrived before the listener was ready is waiting.
        take();
      });
    return () => {
      alive = false;
      off?.();
    };
  }, []);
}
