/**
 * The desktop (Tauri) side of the window: its buttons and the mini player window. Tauri's modules
 * are imported lazily, so the app in a plain browser never loads them.
 */

export const MINI_WINDOW_LABEL = 'mini';
/** The URL hash that makes main.tsx render the mini player instead of the app. */
export const MINI_WINDOW_HASH = '#mini';

const MINI_WIDTH = 400;
const MINI_HEIGHT = 152;

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

const currentWindow = async () => (await import('@tauri-apps/api/window')).getCurrentWindow();

export async function minimizeWindow(): Promise<void> {
  await (await currentWindow()).minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  await (await currentWindow()).toggleMaximize();
}

export async function closeWindow(): Promise<void> {
  await (await currentWindow()).close();
}

/** Calls `handler` with the maximized state now and after every resize; resolves to the unsubscribe. */
export async function watchMaximized(handler: (maximized: boolean) => void): Promise<() => void> {
  const win = await currentWindow();
  handler(await win.isMaximized());
  return win.onResized(async () => handler(await win.isMaximized()));
}

/**
 * Whether the mini player window is already open (it outlives a reload of the main window);
 * if it is, `onClosed` runs when it goes away.
 */
export async function findMini(onClosed: () => void): Promise<boolean> {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const mini = await WebviewWindow.getByLabel(MINI_WINDOW_LABEL);
  if (mini) void mini.once('tauri://destroyed', () => onClosed());
  return !!mini;
}

/** Opens the frameless mini player window, or focuses it. `onClosed` runs when it goes away. */
export async function openMini(title: string, onClosed: () => void): Promise<void> {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const existing = await WebviewWindow.getByLabel(MINI_WINDOW_LABEL);
  if (existing) {
    await existing.setFocus();
    return;
  }
  const mini = new WebviewWindow(MINI_WINDOW_LABEL, {
    // App-relative, so it resolves to the dev server or the bundled UI alike.
    url: `index.html${MINI_WINDOW_HASH}`,
    title,
    width: MINI_WIDTH,
    height: MINI_HEIGHT,
    center: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    decorations: false,
    alwaysOnTop: true,
    // The shadow keeps Windows 11's rounded corners.
    shadow: true,
    focus: true,
    dragDropEnabled: false,
  });
  await new Promise<void>((resolve, reject) => {
    mini.once('tauri://created', () => resolve());
    mini.once('tauri://error', (e) => reject(e));
  });
  void mini.once('tauri://destroyed', () => onClosed());
}

export async function closeMini(): Promise<void> {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  await (await WebviewWindow.getByLabel(MINI_WINDOW_LABEL))?.close();
}
