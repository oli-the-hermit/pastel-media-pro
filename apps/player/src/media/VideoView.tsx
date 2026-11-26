import { useEffect, useMemo, useRef, useState } from 'react';
import { isBlockingOverlayOpen, VideoPlayer } from '@pastel-studio/react';
import { isDesktop } from '@pastel-studio/desktop';
import { engine } from './engine';
import { usePlayback } from './playback';

/** A CSS color as #rrggbb, for mpv's background (the bars beside the picture). */
function hex(cssColor: string): string {
  const c = document.createElement('canvas').getContext('2d');
  if (!c) return '#000000';
  c.fillStyle = cssColor;
  c.fillRect(0, 0, 1, 1);
  const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** How long the controls stay after the last move or key, as the design system's players. */
const IDLE_MS = 2600;

/**
 * True once nothing has moved for a while, while a video plays: the player hides its controls and the pointer.
 * It listens on the window and only counts a pointer that really moved: the picture is drawn by the engine behind
 * the page, where the design system's own timer (VideoPlayer `autoHide`) kept being woken with nothing moving.
 * A pause, a move, a press or a key brings the controls back; an open menu or dialog keeps them.
 */
function useWatchingIdle(playing: boolean): boolean {
  const [idle, setIdle] = useState(false);
  const isPlaying = useRef(playing);
  isPlaying.current = playing;
  const wake = useRef<() => void>(() => {});
  useEffect(() => {
    let timer = 0;
    const arm = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (isPlaying.current && !isBlockingOverlayOpen()) setIdle(true);
        else arm(500);
      }, ms);
    };
    wake.current = () => {
      setIdle(false);
      arm(IDLE_MS);
    };
    let at = { x: NaN, y: NaN };
    const moved = (e: PointerEvent) => {
      if (e.screenX === at.x && e.screenY === at.y) return;
      at = { x: e.screenX, y: e.screenY };
      wake.current();
    };
    const acted = () => wake.current();
    window.addEventListener('pointermove', moved);
    window.addEventListener('pointerdown', acted);
    window.addEventListener('keydown', acted);
    window.addEventListener('wheel', acted, { passive: true });
    arm(IDLE_MS);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', moved);
      window.removeEventListener('pointerdown', acted);
      window.removeEventListener('keydown', acted);
      window.removeEventListener('wheel', acted);
    };
  }, []);
  // Paused or ended: the controls come back, and the wait starts again when it plays.
  useEffect(() => {
    if (!playing) wake.current();
  }, [playing]);
  return idle;
}

interface VideoViewProps {
  /** The player's Back button: leaves the video. Stops it when not given. */
  onBack?: () => void;
}

/**
 * The playing video, filling the page. The picture is drawn behind the page: the player's middle is a hole, and
 * the page turns see-through there once the picture is up. Until then the player is solid, with the design
 * system's spinner. In the desktop app mpv is told where the hole is as margins of the window (spike S7); in the
 * browser the playback's video element is moved into the hole's box.
 */
export function VideoView({ onBack }: VideoViewProps) {
  const playback = usePlayback();
  const hole = useRef<HTMLDivElement>(null);
  const video = playback.video;
  const ready = playback.pictureReady;
  const { setVideoBox } = playback;
  const idle = useWatchingIdle(ready && playback.engine.playing);

  useEffect(() => {
    const native = isDesktop();
    const apply = () => {
      const r = hole.current?.getBoundingClientRect();
      if (!native) {
        setVideoBox(r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null);
        return;
      }
      const w = window.innerWidth;
      const h = window.innerHeight;
      const m = r ? [r.left / w, 1 - r.right / w, r.top / h, 1 - r.bottom / h] : [0, 0, 0, 0];
      ['left', 'right', 'top', 'bottom'].forEach((side, i) => void engine.set(`video-margin-ratio-${side}`, String(Math.max(0, m[i]))).catch(() => {}));
      // The bars beside the picture are the player's own backdrop: the same solid colour as while it loads.
      void engine.set('background-color', hex(getComputedStyle(document.documentElement).getPropertyValue('--ps-media-backdrop').trim() || '#000')).catch(() => {});
    };
    apply();
    const ro = new ResizeObserver(apply);
    if (hole.current) ro.observe(hole.current);
    window.addEventListener('resize', apply);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', apply);
      if (!native) setVideoBox(null);
    };
  }, [setVideoBox]);

  // The page is see-through only while there is a picture behind it.
  useEffect(() => {
    if (!ready) return;
    document.documentElement.classList.add('mp-video-on');
    return () => document.documentElement.classList.remove('mp-video-on');
  }, [ready]);

  // Loading: the surface shows its spinner (it does while a playing video waits), not the big Play button.
  const engineState = playback.engine;
  const media = useMemo(() => (ready ? engineState : { ...engineState, playing: true, waiting: true }), [ready, engineState]);

  if (!video) return null;
  return (
    <div className={ready ? 'mp-video has-picture' : 'mp-video'} aria-busy={!ready}>
      <VideoPlayer
        media={media}
        variant="movie"
        controls="overlay"
        fill
        autoHide={false}
        className={idle ? 'mp-video-player is-idle' : 'mp-video-player'}
        title={video.title || video.fileName}
        onBack={onBack ?? playback.stop}
      >
        <div className="mp-video-hole" ref={hole} />
      </VideoPlayer>
    </div>
  );
}
