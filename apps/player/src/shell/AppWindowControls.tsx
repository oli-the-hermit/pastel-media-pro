import { useEffect, useState } from 'react';
import { WindowControls } from '@pastel-studio/react';
import { closeWindow, minimizeWindow, toggleMaximizeWindow, watchMaximized } from '../desktop';

// A window call that fails (the window is already going away) has nothing to tell the user.
const run = (call: () => Promise<void>) => () => void call().catch(() => {});

/** The frameless main window's buttons, wired to Tauri. Rendered only on the desktop. */
export function AppWindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    watchMaximized(setMaximized)
      .then((fn) => (cancelled ? fn() : (off = fn)))
      .catch(() => {
        // Without the state the middle button still toggles; it only keeps the "maximize" look.
      });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  return (
    <WindowControls
      maximized={maximized}
      onMinimize={run(minimizeWindow)}
      onToggleMaximize={run(toggleMaximizeWindow)}
      onClose={run(closeWindow)}
    />
  );
}
