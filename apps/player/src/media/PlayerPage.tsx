import { useEffect, useMemo, useState } from 'react';
import { Button, EmptyState, IconFolderOpen, MusicPlayer, PlayQueue, TextButton, type Track } from '@pastel-studio/react';
import { isDesktop } from '@pastel-studio/desktop';
import { strings } from '../strings';
import { toTrack, useCover, useCovers, useOpenedCover, type Library } from './library';
import { useMissing } from './missing';
import { usePlayback, type PlayFailure } from './playback';
import { useRemembered } from './remember';
import { lastCover, saveLastCover } from './session';
import { VideoView } from './VideoView';

/** How many of the queue's songs, each way from the one playing, show their cover; the others show a plain mark. */
const WITH_COVERS = 100;

/**
 * The playing song as the design system's Track, with its album's cover when the library knows it, or, for a song
 * opened from Windows, the picture in its file or beside it.
 */
export function useNowPlayingTrack(library: Library | null): Track | undefined {
  const { current } = usePlayback();
  const albumId = library?.albums.find((a) => current && a.trackIds.includes(current.id))?.id ?? '';
  const albumCover = useCover(albumId);
  const fileCover = useOpenedCover(!albumId && current ? current.path : '');
  // The song the player greets with shows the cover kept from last time, until the library is read.
  const path = current?.path ?? '';
  const kept = useMemo(() => lastCover(path), [path]);
  const found = albumCover ?? fileCover;
  useEffect(() => saveLastCover(path, found), [path, found]);
  const cover = found ?? kept;
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
  /** The video's Back button: stop it and go back to where it was started from. */
  onLeaveVideo?: () => void;
}

/**
 * The player, the default start page (D15, D16): the playing video; the playing song with its queue beside it
 * (also the song of the last session, paused where it was left: the player greets with it); or, with nothing
 * playing, a calm empty page that takes a drop or opens files.
 */
export function PlayerPage({ library, onOpenFiles, onLeaveVideo }: PlayerPageProps) {
  const playback = usePlayback();
  const missing = useMissing();
  const track = useNowPlayingTrack(library);
  const [queueOpen, setQueueOpen] = useRemembered<boolean>('pastelmedia_queue_open', true, (v) => typeof v === 'boolean');
  const { queue, index } = playback;
  // The whole queue: the design system's PlayQueue draws only the rows near the screen once there are many.
  const next = useMemo(() => queue.slice(index + 1), [queue, index]);
  const before = useMemo(() => queue.slice(0, Math.max(0, index)).reverse(), [queue, index]);
  // Each row's cover is its album's.
  const albumOf = useMemo(() => {
    const of = new Map<string, string>();
    for (const a of library?.albums ?? []) for (const id of a.trackIds) of.set(id, a.id);
    return of;
  }, [library]);
  const covers = useCovers(
    useMemo(
      () => [...new Set([...next.slice(0, WITH_COVERS), ...before.slice(0, WITH_COVERS)].map((t) => albumOf.get(t.id) ?? '').filter(Boolean))],
      [next, before, albumOf],
    ),
  );
  const upNext = useMemo(() => next.map((t) => toTrack(t, covers[albumOf.get(t.id) ?? ''])), [next, covers, albumOf]);
  const played = useMemo(() => before.map((t) => toTrack(t, covers[albumOf.get(t.id) ?? ''])), [before, covers, albumOf]);
  if (playback.video) return <VideoView onBack={onLeaveVideo} />;
  if (track) {
    return (
      <div className={queueOpen ? 'mp-player has-queue' : 'mp-player'}>
        <MusicPlayer
          media={playback.engine}
          track={track}
          onPrevious={playback.previous}
          onNext={playback.next}
          hasPrevious={playback.index > 0}
          hasNext={playback.index < playback.queue.length - 1}
          queueOpen={queueOpen}
          onQueueToggle={() => setQueueOpen(!queueOpen)}
        />
        {queueOpen ? (
          <PlayQueue
            className="mp-player-queue"
            current={track}
            playing={playback.engine.playing}
            upNext={upNext}
            history={played}
            onPlay={(t) => {
              if (t.id === track.id) playback.engine.toggle();
              else playback.playTracks(queue, queue.findIndex((x) => x.id === t.id));
            }}
            onUnavailable={(t) => {
              const song = queue.find((x) => x.id === t.id);
              if (song) missing.find({ path: song.path, name: song.title });
            }}
            onReorder={playback.moveInQueue}
            onRemove={(t) => playback.removeFromQueue(t.id)}
            onClear={upNext.length > 0 ? playback.clearUpNext : undefined}
            onClose={() => setQueueOpen(false)}
          />
        ) : undefined}
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
