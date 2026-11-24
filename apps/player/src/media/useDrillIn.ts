import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A grid whose tiles open an item on a page of its own (an album, a film, a series). The page's Back button takes
 * focus when it opens (`autoFocus`); going back puts focus on the tile that opened it, so a keyboard user keeps
 * their place. Tiles carry `data-tile-id`.
 */
export function useDrillIn() {
  const [openId, setOpenId] = useState<string | null>(null);
  const returnTo = useRef<string | null>(null);
  const open = useCallback((id: string) => {
    returnTo.current = id;
    setOpenId(id);
  }, []);
  const close = useCallback(() => setOpenId(null), []);
  useEffect(() => {
    if (openId !== null || returnTo.current === null) return;
    const id = returnTo.current;
    returnTo.current = null;
    document.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(id)}"]`)?.focus();
  }, [openId]);
  return { openId, open, close };
}
