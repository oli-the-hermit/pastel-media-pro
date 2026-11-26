import { useCallback, useState } from 'react';

/**
 * A choice kept on this device between visits (a page's view, its sort): `localStorage` under `key`, like the
 * app's settings. `valid` refuses what an older version, or anyone, left there.
 */
export function useRemembered<T>(key: string, initial: T, valid: (value: unknown) => boolean = () => true): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return initial;
      const parsed: unknown = JSON.parse(raw);
      return valid(parsed) ? (parsed as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* storage is off or full: the choice lasts until the window closes */
      }
    },
    [key],
  );
  return [value, set];
}
