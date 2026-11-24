import { useMemo, useState } from 'react';
import { Button, EmptyState, IconFolderOpen, MusicPlayer, TextButton, type Track } from '@pastel-studio/react';
import { isDesktop } from '@pastel-studio/desktop';
import { strings } from '../strings';
import { toTrack, useCover, useOpenedCover, type Library } from './library';
import { usePlayback, type PlayFailure } from './playback';
import { VideoView } from './VideoView';

/**
 * The playing song as the design system's Track, with its album's cover when the library knows it, or, for a song
 * opened from Windows, the picture in its file or beside it.
 */
export function useNowPlayingTrack(library: Library | null): Track | undefined {
  const { current } = usePlayback();
  const albumId = library?.albums.find((a) => current && a.trackIds.includes(current.id))?.id ?? '';
  const albumCover = useCover(albumId);
  const fileCover = useOpenedCover(!albumId && current ? current.path : '');
  const cover = albumCover ?? fileCover;
  return useMemo(() => (current ? toTrack(current, cover) : undefined), [current, cover]);
}

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

/** "We can't play this file": the file's name, the engine's reason under Details, and a way to open another. */
function CantPlay({ failure, onOpenFiles }: { failure: PlayFailure; onOpenFiles: () => void }) {
  const [details, setDetails] = useState(false);
  return (
    <EmptyState className="mp-player-empty mp-cant-play" role="alert">
      <h2 className="mp-heading">{strings.playback.cantPlay}</h2>
      <p className="mp-cant-play-file">{fileName(failure.path)}</p>
      <TextButton aria-expanded={details} onClick={() => setDetails((d) => !d)}>
        {details ? strings.playback.hideDetails : strings.playback.details}
      </TextButton>
      {details ? (
        <p className="mp-cant-play-details">
          {failure.reason}
          <br />
          {failure.path}
        </p>
      ) : undefined}
      <Button variant="primary" icon={<IconFolderOpen />} onClick={onOpenFiles}>
        {strings.player.open}
      </Button>
    </EmptyState>
  );
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
  if (playback.failure) return <CantPlay failure={playback.failure} onOpenFiles={onOpenFiles} />;
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
