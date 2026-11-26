import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccountMenu, AppShell, AppShellPage, EmptyState, IconLogOut, IconPlay, Modal, NavRail, NowPlayingBar, ToastRegion, useDrawer, useToasts,
} from '@pastel-studio/react';
import { ImportProvider } from './media/import/ImportFlow';
import { ImportQueue } from './media/import/ImportQueue';
import { NoFolders } from './media/LibraryFolders';
import { isEmptyLibrary, useLibrary, type Library } from './media/library';
import { MusicPage } from './media/MusicPage';
import { pickFiles, useOpenedFiles } from './media/opened';
import { PlaybackProvider, usePlayback } from './media/playback';
import { PlayerPage, useNowPlayingTrack } from './media/PlayerPage';
import { PlaylistDialogs } from './media/PlaylistActions';
import { PlaylistsPage } from './media/PlaylistsPage';
import { StreamingPage } from './media/StreamingPage';
import { rememberLastPage, useSettings } from './settings';
import { accountViews } from './shell/accountViews';
import { AppTopBar } from './shell/AppTopBar';
import { HelpView } from './shell/HelpView';
import { NotifyContext } from './shell/notify';
import { startPage, visiblePages, type PageKey } from './shell/pages';
import { usePlayerShortcuts } from './shell/shortcuts';
import { strings } from './strings';
import { useAppearance } from './theme';

// A placeholder mark until the logo is designed.
const BRAND = { mark: <IconPlay size={16} />, name: strings.app.name };
const PROFILE = { name: strings.account.defaultName };

interface PageContentProps {
  page: PageKey;
  library: Library | null;
  onOpenFiles: () => void;
  onLeaveVideo: () => void;
}

function PageContent({ page, library, onOpenFiles, onLeaveVideo }: PageContentProps) {
  if (page === 'player') return <PlayerPage library={library} onOpenFiles={onOpenFiles} onLeaveVideo={onLeaveVideo} />;
  // Nothing to read yet: the media pages ask for one folder (ux.md, "capture before organising").
  if ((page === 'music' || page === 'streaming') && library && isEmptyLibrary(library)) return <NoFolders preset={page === 'music' ? 'music' : 'movies'} />;
  if (page === 'streaming') return <StreamingPage library={library} />;
  if (page === 'music') return library ? <MusicPage library={library} /> : <EmptyState>{strings.library.reading}</EmptyState>;
  if (page === 'playlists') return library ? <PlaylistsPage library={library} /> : <EmptyState>{strings.library.reading}</EmptyState>;
  return <EmptyState>{strings.pages[page].empty}</EmptyState>;
}

/** The bar along the bottom while songs play, on every page but the player's. */
function NowPlaying({ library }: { library: Library | null }) {
  const playback = usePlayback();
  const track = useNowPlayingTrack(library);
  return (
    <NowPlayingBar
      media={playback.engine}
      track={track}
      onPrevious={playback.previous}
      onNext={playback.next}
      hasPrevious={playback.index > 0}
      hasNext={playback.index < playback.queue.length - 1}
    />
  );
}

function Main({ launchedWithFiles }: { launchedWithFiles: boolean }) {
  const settings = useSettings();
  const [page, setPage] = useState<PageKey>(() => startPage(settings, launchedWithFiles));
  const [helpOpen, setHelpOpen] = useState(false);
  const drawer = useDrawer('pastelmedia_drawer');
  const appearance = useAppearance();
  const { toasts, showToast } = useToasts();
  const playback = usePlayback();
  const pages = visiblePages(settings);
  // Read the first time a page that shows it opens; never at launch (D16), never for a hidden Streaming tab.
  const library = useLibrary(page === 'music' || page === 'playlists' || (page === 'streaming' && settings.showStreaming));
  const exit = { label: strings.account.switchProfile, icon: <IconLogOut />, onSelect: () => showToast(strings.account.switchProfileLater, 'info') };

  const go = useCallback((key: PageKey) => {
    setPage(key);
    rememberLastPage(key);
  }, []);

  // Streaming switched off while open: back to the player.
  useEffect(() => {
    if (!pages.some((p) => p.key === page)) go('player');
  }, [pages, page, go]);

  usePlayerShortcuts(playback);

  const { error, clearError, skipped, clearSkipped, playOpened } = playback;
  useEffect(() => {
    if (!skipped) return;
    showToast(strings.playback.skipped(skipped.split(/[\\/]/).pop() ?? skipped), 'error');
    clearSkipped();
  }, [skipped, clearSkipped, showToast]);
  useEffect(() => {
    if (!error) return;
    const words: Record<string, string> = { unplayable: strings.playback.unplayable, browser: strings.playback.browser };
    showToast(words[error] ?? strings.playback.failed(error), 'error');
    clearError();
  }, [error, clearError, showToast]);

  // Files from the system play at once, on the player (D16).
  useOpenedFiles(
    useCallback(
      (items) => {
        playOpened(items);
        go('player');
      },
      [playOpened, go],
    ),
  );
  const openFiles = useCallback(() => {
    void pickFiles().then(
      (items) => items.length > 0 && playOpened(items),
      (e) => showToast(strings.playback.failed(String(e)), 'error'),
    );
  }, [playOpened, showToast]);

  // A video picked on any page plays on the player. The page it was picked on is kept, with whatever it had open
  // (a film's or a series' title page): the player's Back button returns there.
  const video = playback.video != null;
  const cameFrom = useRef<PageKey | null>(null);
  useEffect(() => {
    if (!video) {
      cameFrom.current = null;
      return;
    }
    setPage((p) => {
      if (p !== 'player') cameFrom.current = p;
      return 'player';
    });
  }, [video]);
  const { stop } = playback;
  const leaveVideo = useCallback(() => {
    const back = cameFrom.current;
    cameFrom.current = null;
    stop();
    if (back && pages.some((p) => p.key === back)) go(back);
  }, [stop, pages, go]);

  return (
    <NotifyContext.Provider value={showToast}>
      <ImportProvider>
      <PlaylistDialogs>
      <AppShell
        surface={video && page === 'player' && playback.pictureReady ? 'transparent' : 'solid'}
        nav={
          <NavRail
            label={strings.nav.label}
            items={pages.map(({ key, icon }) => ({ key, label: strings.pages[key].label, icon }))}
            activeKey={page}
            onSelect={(key) => {
              // The picture lives on the player page; leaving it stops the video (until the mini player, Phase 7).
              if (video && key !== 'player') {
                cameFrom.current = null;
                playback.stop();
              }
              go(key as PageKey);
            }}
            variant={drawer.expanded ? 'expanded' : 'rail'}
            brand={BRAND}
            onToggle={drawer.canExpand ? drawer.toggle : undefined}
            footer={({ expanded }) => <AccountMenu profile={PROFILE} compact={!expanded} views={accountViews(appearance)} exit={exit} />}
          />
        }
        topBar={<AppTopBar title={strings.pages[page].label} onOpenHelp={() => setHelpOpen(true)} />}
        bottomBar={playback.current && page !== 'player' ? <NowPlaying library={library} /> : undefined}
        overlays={
          <>
            <ImportQueue />
            <ToastRegion toasts={toasts} />
            <Modal isOpen={helpOpen} title={strings.help.title} onClose={() => setHelpOpen(false)}>
              <HelpView />
            </Modal>
          </>
        }
      >
        {pages.map(({ key }) => (
          <AppShellPage key={key} active={key === page} fill={key === 'player' && video}>
            <PageContent page={key} library={library} onOpenFiles={openFiles} onLeaveVideo={leaveVideo} />
          </AppShellPage>
        ))}
      </AppShell>
      </PlaylistDialogs>
      </ImportProvider>
    </NotifyContext.Provider>
  );
}

interface AppProps {
  /** The app was started with files ("Open with", a double-click): it opens on the player. */
  launchedWithFiles?: boolean;
}

/** The main window: the shared shell from the design system, around the player and the media pages. */
export function App({ launchedWithFiles = false }: AppProps) {
  return (
    <PlaybackProvider>
      <Main launchedWithFiles={launchedWithFiles} />
    </PlaybackProvider>
  );
}
