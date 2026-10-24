import { useEffect, useRef } from 'react';
import { VideoPlayer } from '@pastel-studio/react';
import { engine } from './engine';
import { usePlayback } from './playback';

/** A CSS color as #rrggbb, for mpv's background (the letterbox bars). */
function hex(cssColor: string): string {
  const c = document.createElement('canvas').getContext('2d');
  if (!c) return '#000000';
  c.fillStyle = cssColor;
  c.fillRect(0, 0, 1, 1);
  const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/**
 * The playing video. mpv draws the picture behind the transparent page; the player's empty middle is a
 * hole, and mpv is told where it is as margins of the window (spike S7).
 */
export function VideoView() {
  const playback = usePlayback();
  const hole = useRef<HTMLDivElement>(null);
  const video = playback.video;

  useEffect(() => {
    document.documentElement.classList.add('mp-video-on');
    const apply = () => {
      const r = hole.current?.getBoundingClientRect();
      const w = window.innerWidth;
      const h = window.innerHeight;
      const m = r ? [r.left / w, 1 - r.right / w, r.top / h, 1 - r.bottom / h] : [0, 0, 0, 0];
      ['left', 'right', 'top', 'bottom'].forEach((side, i) => void engine.set(`video-margin-ratio-${side}`, String(Math.max(0, m[i]))).catch(() => {}));
      void engine.set('background-color', hex(getComputedStyle(document.documentElement).getPropertyValue('--ps-bg').trim() || '#000')).catch(() => {});
    };
    apply();
    const ro = new ResizeObserver(apply);
    if (hole.current) ro.observe(hole.current);
    window.addEventListener('resize', apply);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', apply);
      document.documentElement.classList.remove('mp-video-on');
    };
  }, []);

  if (!video) return null;
  return (
    <div className="mp-video">
      <VideoPlayer media={playback.engine} variant="movie" controls="overlay" title={video.title || video.fileName} onBack={playback.stop}>
        <div className="mp-video-hole" ref={hole} />
      </VideoPlayer>
    </div>
  );
}
