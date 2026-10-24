import { useMemo, useState } from 'react';
import { AlbumPage, EmptyState, IconMusic, TextButton } from '@pastel-studio/react';
import { MediaGrid, MediaTile } from '@pastel-media/media-ui';
import { strings } from '../strings';
import { toAlbum, useCover, type LibAlbum, type LibTrack, type Library } from './library';
import { usePlayback } from './playback';

function AlbumTile({ album, current, onOpen }: { album: LibAlbum; current: boolean; onOpen: () => void }) {
  const cover = useCover(album.id);
  return (
    <div role="listitem">
      <MediaTile
        title={album.title || strings.music.noAlbum}
        subtitle={strings.music.albumSubtitle(album.artist || strings.music.unknownArtist, album.trackIds.length)}
        cover={cover}
        icon={<IconMusic size={28} />}
        current={current}
        onClick={onOpen}
      />
    </div>
  );
}

function OpenAlbum({ album, tracks, onBack }: { album: LibAlbum; tracks: LibTrack[]; onBack: () => void }) {
  const cover = useCover(album.id);
  const playback = usePlayback();
  const view = useMemo(() => toAlbum(album, tracks, cover), [album, tracks, cover]);
  const playingHere = playback.current != null && album.trackIds.includes(playback.current.id);
  return (
    <div className="mp-page">
      <div>
        <TextButton onClick={onBack}>{strings.music.allAlbums}</TextButton>
      </div>
      <AlbumPage
        album={view}
        playing={playingHere && playback.engine.playing}
        onPlayPause={() => (playingHere ? playback.engine.toggle() : playback.playTracks(tracks, 0))}
        currentId={playback.current?.id}
        isPlaying={playback.engine.playing}
        onPlayTrack={(t) => {
          const i = tracks.findIndex((x) => x.id === t.id);
          if (playback.current?.id === t.id) playback.engine.toggle();
          else playback.playTracks(tracks, i);
        }}
        onPause={playback.engine.pause}
      />
    </div>
  );
}

/** Music: the albums of the test library, and an album's songs. */
export function MusicPage({ library }: { library: Library }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const playback = usePlayback();
  const byId = useMemo(() => new Map(library.tracks.map((t) => [t.id, t])), [library]);
  const open = library.albums.find((a) => a.id === openId);

  if (library.albums.length === 0) return <EmptyState>{strings.pages.music.empty}</EmptyState>;
  if (open) return <OpenAlbum album={open} tracks={open.trackIds.map((id) => byId.get(id)!)} onBack={() => setOpenId(null)} />;
  return (
    <div className="mp-page">
      <p className="mp-note">{strings.library.testFolder(library.root)}</p>
      <MediaGrid aria-label={strings.music.albums}>
        {library.albums.map((a) => (
          <AlbumTile key={a.id} album={a} current={!!playback.current && a.trackIds.includes(playback.current.id)} onOpen={() => setOpenId(a.id)} />
        ))}
      </MediaGrid>
    </div>
  );
}
