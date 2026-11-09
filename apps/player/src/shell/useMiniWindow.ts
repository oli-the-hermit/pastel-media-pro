import { useCallback, useEffect, useState } from 'react';
import { closeMini, findMini, isTauri, openMini } from '../desktop';
import { strings } from '../strings';

/** The mini player window: desktop only, opened and closed from the top bar. */
export function useMiniWindow() {
  const supported = isTauri();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    findMini(() => setOpen(false))
      .then((isOpen) => !cancelled && setOpen(isOpen))
      .catch(() => {
        // Unknown: the button starts as "open the mini player", which still works.
      });
    return () => {
      cancelled = true;
    };
  }, [supported]);

  const toggle = useCallback(() => {
    if (open) {
      void closeMini().catch(() => {});
      return;
    }
    setOpen(true);
    openMini(strings.mini.windowTitle, () => setOpen(false)).catch(() => setOpen(false));
  }, [open]);

  return { supported, open, toggle };
}
