import { IconButton, IconHelp, IconMiniPlayer, TopBar } from '@pastel-studio/react';
import { DesktopWindowControls, DRAG_REGION, isDesktop } from '@pastel-studio/desktop';
import { strings } from '../strings';
import { useMiniWindow } from './useMiniWindow';

interface AppTopBarProps {
  title: string;
  onOpenHelp: () => void;
}

/**
 * The page title and the global tools. On the desktop the bar is also the frameless window's
 * title bar. The status slot stays empty until something plays (the now-playing chip).
 */
export function AppTopBar({ title, onOpenHelp }: AppTopBarProps) {
  const desktop = isDesktop();
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
      windowControls={desktop ? <DesktopWindowControls /> : undefined}
    />
  );
}
