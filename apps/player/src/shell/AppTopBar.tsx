import { IconButton, IconHelp, IconMiniPlayer, TopBar } from '@pastel-studio/react';
import { isTauri } from '../desktop';
import { strings } from '../strings';
import { AppWindowControls } from './AppWindowControls';
import { useMiniWindow } from './useMiniWindow';

// Tauri moves the window from the pressed element only, so the bar spreads this on its free parts.
const DRAG_REGION = { 'data-tauri-drag-region': true };

interface AppTopBarProps {
  title: string;
  onOpenHelp: () => void;
}

/**
 * The page title and the global tools. On the desktop the bar is also the frameless window's
 * title bar. The status slot stays empty until something plays (the now-playing chip).
 */
export function AppTopBar({ title, onOpenHelp }: AppTopBarProps) {
  const desktop = isTauri();
  const mini = useMiniWindow();
  return (
    <TopBar
      title={title}
      dragRegionProps={desktop ? DRAG_REGION : undefined}
      tools={
        <>
          {mini.supported && (
            <IconButton label={mini.open ? strings.topBar.closeMini : strings.topBar.openMini} pressed={mini.open} onClick={mini.toggle}>
              <IconMiniPlayer size={19} />
            </IconButton>
          )}
          <IconButton label={strings.topBar.help} aria-haspopup="dialog" onClick={onOpenHelp}>
            <IconHelp size={19} />
          </IconButton>
        </>
      }
      windowControls={desktop ? <AppWindowControls /> : undefined}
    />
  );
}
