import { useMemo } from 'react';
import { Button, EmptyState, IconFolderOpen, MusicPlayer, type Track } from '@pastel-studio/react';
import { isDesktop } from '@pastel-studio/desktop';
import { strings } from '../strings';
import { toTrack, useCover, type Library } from './library';
import { usePlayback } from './playback';
import { VideoView } from './VideoView';

/** The playing song as the design system's Track, with its album's cover when the library knows it. */
export function useNowPlayingTrack(library: Library | null): Track | undefined {
  const { current } = usePlayback();
  const albumId = library?.albums.find((a) => current && a.trackIds.includes(current.id))?.id ?? '';
  const cover = useCover(albumId);
  return useMemo(() => (current ? toTrack(current, cover) : undefined), [current, cover]);
}

interface PlayerPageProps {
  library: Library | null;
  /** The Open dialog. */
  onOpenFiles: () => void;
}

/**
 * The player, the default start page (D15, D16): the playing video, the playing song, or, with nothing playing,
 * a calm empty page that takes a drop or opens files.
 */
export function PlayerPage({ library, onOpenFiles }: PlayerPageProps) {
  const playback = usePlayback();
  const track = useNowPlayingTrack(library);
  if (playback.video) return <VideoView />;
  if (track) {
    return (
      <div className="mp-player">
        <MusicPlayer
          media={playback.engine}
          track={track}
          onPrevious={playback.previous}
          onNext={playback.next}
          hasPrevious={playback.index > 0}
          hasNext={playback.index < playback.queue.length - 1}
        />
      </div>
    );
  }
  return (
    <EmptyState className="mp-player-empty">
      <p>{strings.pages.player.empty}</p>
      {isDesktop() ? (
        <Button variant="primary" icon={<IconFolderOpen />} onClick={onOpenFiles}>
          {strings.player.open}
        </Button>
      ) : (
        <p>{strings.player.browserHint}</p>
      )}
    </EmptyState>
  );
}
