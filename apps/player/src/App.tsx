import { useEffect, useMemo, useState } from 'react';
import {
  AccountMenu, AppShell, AppShellPage, EmptyState, IconLogOut, IconPlay, Modal, NavRail, NowPlayingBar, ToastRegion, useDrawer, useToasts,
  type NavRailItem,
} from '@pastel-studio/react';
import { toTrack, useCover, useLibrary, type Library } from './media/library';
import { MusicPage } from './media/MusicPage';
import { PlaybackProvider, usePlayback } from './media/playback';
import { MoviesPage, SeriesPage } from './media/VideoPages';
import { VideoView } from './media/VideoView';
import { accountViews } from './shell/accountViews';
import { AppTopBar } from './shell/AppTopBar';
import { PAGES, type PageKey } from './shell/pages';
import { strings } from './strings';
import { useAppearance } from './theme';

const NAV_ITEMS: NavRailItem[] = PAGES.map(({ key, icon }) => ({ key, label: strings.pages[key].label, icon }));
// A placeholder mark until the logo is designed.
const BRAND = { mark: <IconPlay size={16} />, name: strings.app.name };
const PROFILE = { name: strings.account.defaultName };

function PageContent({ page, library }: { page: PageKey; library: Library | null }) {
  const media = page === 'music' || page === 'movies' || page === 'series';
  if (media && !library) return <EmptyState>{strings.library.reading}</EmptyState>;
  if (library && page === 'music') return <MusicPage library={library} />;
  if (library && page === 'movies') return <MoviesPage library={library} />;
  if (library && page === 'series') return <SeriesPage library={library} />;
  return <EmptyState>{strings.pages[page].empty}</EmptyState>;
}

/** The bar along the bottom while songs play. */
function NowPlaying({ library }: { library: Library | null }) {
  const playback = usePlayback();
  const current = playback.current;
  const albumId = library?.albums.find((a) => current && a.trackIds.includes(current.id))?.id ?? '';
  const cover = useCover(albumId);
  const track = useMemo(() => (current ? toTrack(current, cover) : undefined), [current, cover]);
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

function Main() {
  const [page, setPage] = useState<PageKey>('home');
  const [helpOpen, setHelpOpen] = useState(false);
  const drawer = useDrawer('pastelmedia_drawer');
  const appearance = useAppearance();
  const { toasts, showToast } = useToasts();
  const library = useLibrary();
  const playback = usePlayback();
  const exit = { label: strings.account.switchProfile, icon: <IconLogOut />, onSelect: () => showToast(strings.account.switchProfileLater, 'info') };

  const { error, clearError } = playback;
  useEffect(() => {
    if (!error) return;
    const words: Record<string, string> = { unplayable: strings.playback.unplayable, browser: strings.playback.browser };
    showToast(words[error] ?? strings.playback.failed(error), 'error');
    clearError();
  }, [error, clearError, showToast]);

  const video = playback.video != null;
  return (
    <AppShell
      surface={video ? 'transparent' : 'solid'}
      nav={
        <NavRail
          label={strings.nav.label}
          items={NAV_ITEMS}
          activeKey={page}
          onSelect={(key) => {
            if (video) playback.stop();
            setPage(key as PageKey);
          }}
          variant={drawer.expanded ? 'expanded' : 'rail'}
          brand={BRAND}
          onToggle={drawer.canExpand ? drawer.toggle : undefined}
          footer={({ expanded }) => <AccountMenu profile={PROFILE} compact={!expanded} views={accountViews(appearance)} exit={exit} />}
        />
      }
      topBar={<AppTopBar title={strings.pages[page].label} onOpenHelp={() => setHelpOpen(true)} />}
      bottomBar={playback.current && !video ? <NowPlaying library={library} /> : undefined}
      overlays={
        <>
          <ToastRegion toasts={toasts} />
          <Modal isOpen={helpOpen} title={strings.help.title} onClose={() => setHelpOpen(false)}>
            <EmptyState>{strings.help.empty}</EmptyState>
          </Modal>
        </>
      }
    >
      {video ? (
        <AppShellPage active fill>
          <VideoView />
        </AppShellPage>
      ) : (
        PAGES.map(({ key }) => (
          <AppShellPage key={key} active={key === page}>
            <PageContent page={key} library={library} />
          </AppShellPage>
        ))
      )}
    </AppShell>
  );
}

/** The main window: Focus Space's shell from the design system, around the media pages. */
export function App() {
  return (
    <PlaybackProvider>
      <Main />
    </PlaybackProvider>
  );
}
