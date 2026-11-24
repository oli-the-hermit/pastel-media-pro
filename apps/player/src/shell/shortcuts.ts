/**
 * The player's keyboard shortcuts, listed in Help. They act only while something plays, never while typing or
 * inside a dialog, and the arrows only when no control has focus (elsewhere they move through lists and grids, D14).
 */
import { useEffect } from 'react';
import type { Playback } from '../media/playback';

export type ShortcutAction = 'toggle' | 'back' | 'forward' | 'louder' | 'quieter' | 'mute' | 'next' | 'previous';

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** The element the key went to. */
  target: EventTarget | null;
}

const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
/** Space and Enter already press these: the shortcut would do it twice. */
const PRESSABLE = 'button, a[href], [role="button"], [role="slider"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"]';
const ARROWS: Record<string, ShortcutAction> = { ArrowLeft: 'back', ArrowRight: 'forward', ArrowUp: 'louder', ArrowDown: 'quieter' };
const LETTERS: Record<string, ShortcutAction> = { ' ': 'toggle', k: 'toggle', m: 'mute', n: 'next', p: 'previous' };

/** What a key does, or `null` when it is not a shortcut here. */
export function shortcutFor(e: KeyLike): ShortcutAction | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  const el = e.target instanceof Element ? e.target : null;
  if (el?.closest(TYPING) || el?.closest('[role="dialog"]')) return null;
  const onControl = !!el && el !== document.body && !!el.closest(`${PRESSABLE}, [tabindex]`);
  if (e.key in ARROWS) return onControl ? null : ARROWS[e.key];
  const letter = LETTERS[e.key.length === 1 ? e.key.toLowerCase() : ''];
  if (!letter) return null;
  if (letter === 'toggle' && e.key === ' ' && el?.closest(PRESSABLE)) return null;
  return letter;
}

const SEEK_S = 5;
const VOLUME_STEP = 0.05;

/** Runs the shortcuts on the window while something plays. */
export function usePlayerShortcuts(playback: Playback): void {
  const active = !!playback.current || !!playback.video;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutFor(e);
      if (!action) return;
      const m = playback.engine;
      e.preventDefault();
      if (action === 'toggle') m.toggle();
      else if (action === 'back') m.skip(-SEEK_S);
      else if (action === 'forward') m.skip(SEEK_S);
      else if (action === 'louder') m.setVolume(Math.min(1, m.volume + VOLUME_STEP));
      else if (action === 'quieter') m.setVolume(Math.max(0, m.volume - VOLUME_STEP));
      else if (action === 'mute') m.toggleMute();
      else if (action === 'next') playback.next();
      else playback.previous();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, playback]);
}
