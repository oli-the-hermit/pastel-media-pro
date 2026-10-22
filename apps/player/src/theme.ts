import { useState } from 'react';
import { applyTheme, createThemeStore, useThemeSync, type AccentId, type ThemeMode } from '@pastel-studio/react';

/**
 * The device's memory of the look, so every window paints in it on its first frame. The app sets
 * the default accent (Solar Lime, as Focus Space): the library never picks one. Later the profile
 * database owns the choice and this stays the device's cache (O16).
 */
export const themeStore = createThemeStore({ prefix: 'pastelmedia', defaultAccent: 'solar-lime' });

const cachedMode = (): ThemeMode => themeStore.getMode() ?? 'system';

/** Paints a window in the remembered look before React renders anything. */
export function paintCachedTheme(doc: Document = document) {
  applyTheme(cachedMode(), themeStore.getAccent(), doc);
}

/** The theme and accent the app shows, kept on the page and remembered on the device. */
export function useAppearance() {
  const [mode, setMode] = useState<ThemeMode>(cachedMode);
  const [accent, setAccent] = useState<AccentId>(() => themeStore.getAccent());
  useThemeSync(mode, accent, themeStore);
  return { mode, setMode, accent, setAccent };
}
