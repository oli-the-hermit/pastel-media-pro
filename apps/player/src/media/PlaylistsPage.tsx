import { useEffect, useMemo, useState } from 'react';
import {
  AlbumPage, Button, Combobox, EmptyState, IconButton, IconEdit, IconMusic, IconPlus, IconQueue, IconTrash, TextButton, TitleGrid, TitleTile,
  type Album, type ComboboxOption,
} from '@pastel-studio/react';
import { useNotify } from '../shell/notify';
import { strings } from '../strings';
import { toTrack, useCover, useCovers, type LibTrack, type Library } from './library';
import { byName, firstFew, matcher } from './listing';
import { useAddToPlaylist, usePlaylistDialogs } from './PlaylistActions';
import { addToPlaylist, setPlaylistSongs, usePlaylists, type Playlist } from './playlists';
import { usePlayback } from './playback';
import { useRemembered } from './remember';
import { SortMenu } from './SortMenu';
import { useDrillIn } from './useDrillIn';

type PlaylistSort = 'changed' | 'az' | 'za';
const SORTS: PlaylistSort[] = ['changed', 'az', 'za'];

/** What a playlist's page needs of the library: its songs by file, and the album each song's cover comes from. */
interface Songs {
  byPath: Map<string, LibTrack>;
  albumOf: Map<string, string>;
}

/** A playlist's songs that the library has right now, in the playlist's order. */
const songsOf = (playlist: Playlist, songs: Songs) => playlist.paths.map((p) => songs.byPath.get(p)).filter((t): t is LibTrack => !!t);

const shuffled = <T,>(items: T[]): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/** A playlist as a tile: the cover of its first song, its name and how many songs it holds. */
function PlaylistTile({ playlist, songs, onOpen }: { playlist: Playlist; songs: Songs; onOpen: () => void }) {
  const tracks = songsOf(playlist, songs);
  const cover = useCover(tracks[0] ? (songs.albumOf.get(tracks[0].id) ?? '') : '');
  return (
    <TitleTile
      title={playlist.name}
      subtitle={strings.playlists.songs(tracks.length)}
      image={cover}
      icon={<IconQueue size={28} />}
      data-tile-id={String(playlist.id)}
      onClick={onOpen}
    />
  );
}

/**
 * A playlist's own page: Back and a search that adds songs on its first line, then the playlist as the design
 * system shows one (Play, Shuffle, its ⋮ menu to rename or delete it) and its songs, which can be dragged into
 * another order, removed, or added to another playlist from their ⋮ menu.
 */
function OpenPlaylist({ playlist, library, songs, onBack }: { playlist: Playlist; library: Library; songs: Songs; onBack: () => void }) {
  const playback = usePlayback();
  const dialogs = usePlaylistDialogs();
  const notify = useNotify();
  const addTo = useAddToPlaylist(playlist.id);
  const [query, setQuery] = useState('');
  const tracks = useMemo(() => songsOf(playlist, songs), [playlist, songs]);
  const covers = useCovers(useMemo(() => [...new Set(tracks.map((t) => songs.albumOf.get(t.id) ?? '').filter(Boolean))], [tracks, songs]));
  const failed = (e: unknown) => notify(strings.playlists.failed(String(e)), 'error');

  const view = useMemo<Album>(
    () => ({
      id: `playlist-${playlist.id}`,
      title: playlist.name,
      artist: '',
      kind: 'Playlist',
      cover: tracks[0] ? covers[songs.albumOf.get(tracks[0].id) ?? ''] : undefined,
      description: playlist.description || undefined,
      tracks: tracks.map((t, i) => ({
        ...toTrack(t, covers[songs.albumOf.get(t.id) ?? '']),
        number: i + 1,
        addedAt: t.addedAt ? new Date(t.addedAt * 1000).toISOString() : undefined,
      })),
    }),
    [playlist, tracks, covers, songs],
  );

  // Songs of the library that are not in the playlist yet, for the search that adds them.
  const suggestions = useMemo<ComboboxOption[]>(() => {
    const match = matcher(query);
    if (!match) return [];
    const inside = new Set(playlist.paths);
    const found = library.tracks.filter((t) => !inside.has(t.path) && match(`${t.title} ${t.artist} ${t.album}`));
    return firstFew(found, query, (t) => t.title, 8).map((t) => ({
      id: t.id,
      label: t.title,
      detail: [t.artist, t.album].filter(Boolean).join(' · ') || undefined,
      icon: <IconMusic size={16} />,
    }));
  }, [library, playlist, query]);
  const pick = (option: ComboboxOption) => {
    const song = library.tracks.find((t) => t.id === option.id);
    if (!song) return;
    setQuery('');
    void addToPlaylist(playlist.id, [song.path]).catch(failed);
  };

  const pathOf = (id: string) => tracks.find((t) => t.id === id)?.path;
  const save = (paths: string[]) => void setPlaylistSongs(playlist.id, paths).catch(failed);
  // The songs the library does not have right now keep their place: only the ones shown move.
  const reorder = (sourceId: string, targetId: string) => {
    const [from, to] = [pathOf(sourceId), pathOf(targetId)];
    if (!from || !to || from === to) return;
    const paths = playlist.paths.filter((p) => p !== from);
    const at = playlist.paths.indexOf(to);
    paths.splice(at, 0, from);
    save(paths);
  };

  const playingHere = playback.current != null && tracks.some((t) => t.id === playback.current?.id);
  return (
    <div className="mp-page">
      <div className="mp-page-head">
        <TextButton onClick={onBack} autoFocus>
          {strings.playlists.all}
        </TextButton>
        <Combobox
          variant="search"
          className="mp-search"
          value={query}
          onChange={setQuery}
          suggestions={suggestions}
          onPick={pick}
          placeholder={strings.playlists.addSongs}
        />
      </div>
      <AlbumPage
        album={view}
        playing={playingHere && playback.engine.playing}
        onPlayPause={() => (playingHere ? playback.engine.toggle() : playback.playTracks(tracks, 0))}
        onShuffleChange={tracks.length > 1 ? () => playback.playTracks(shuffled(tracks), 0) : undefined}
        actions={[
          { key: 'rename', label: strings.playlists.rename, icon: <IconEdit size={16} />, onSelect: () => dialogs.edit(playlist) },
          { key: 'delete', label: strings.playlists.delete, icon: <IconTrash size={16} />, danger: true, onSelect: () => dialogs.remove(playlist) },
        ]}
        currentId={playback.current?.id}
        isPlaying={playback.engine.playing}
        onPlayTrack={(t) => {
          if (playback.current?.id === t.id) playback.engine.toggle();
          else playback.playTracks(tracks, tracks.findIndex((x) => x.id === t.id));
        }}
        onPause={playback.engine.pause}
        playlist={{ onReorder: reorder }}
        rowActions={(t) => {
          const path = pathOf(t.id);
          if (!path) return [];
          return [
            { key: 'remove', label: strings.playlists.remove, icon: <IconTrash size={16} />, onSelect: () => save(playlist.paths.filter((p) => p !== path)) },
            ...addTo([path]),
          ];
        }}
      />
      {tracks.length === 0 ? <p className="mp-note">{strings.playlists.emptyPlaylist}</p> : undefined}
    </div>
  );
}

/**
 * Playlists: the lists of songs a person makes. Controls as on every media page (ux.md §6): the search across the
 * first line with New playlist, a bare icon, at its end; the sort, a quiet menu, at the end of the second. A
 * playlist opens on its own page.
 */
export function PlaylistsPage({ library }: { library: Library }) {
  const lists = usePlaylists();
  const dialogs = usePlaylistDialogs();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useRemembered<PlaylistSort>('pastelmedia_playlists_sort', 'changed', (v) => SORTS.includes(v as PlaylistSort));
  const { openId, open, close } = useDrillIn();
  const songs = useMemo<Songs>(() => {
    const albumOf = new Map<string, string>();
    for (const a of library.albums) for (const id of a.trackIds) albumOf.set(id, a.id);
    return { byPath: new Map(library.tracks.map((t) => [t.path, t])), albumOf };
  }, [library]);
  const shown = useMemo(() => {
    const match = matcher(query);
    const found = match ? lists.filter((p) => match(`${p.name} ${p.description}`)) : [...lists];
    const az = byName((p: Playlist) => p.name);
    return sort === 'changed' ? found : found.sort(sort === 'az' ? az : (a, b) => az(b, a));
  }, [lists, query, sort]);

  const opened = openId === null ? undefined : lists.find((p) => String(p.id) === openId);
  // A playlist deleted while its page is open: back to the list.
  useEffect(() => {
    if (openId !== null && !opened) close();
  }, [openId, opened, close]);
  if (opened) return <OpenPlaylist key={opened.id} playlist={opened} library={library} songs={songs} onBack={close} />;

  if (lists.length === 0) {
    return (
      <EmptyState className="mp-player-empty">
        <p>{strings.pages.playlists.empty}</p>
        <Button variant="primary" icon={<IconPlus />} onClick={() => dialogs.create()}>
          {strings.playlists.new}
        </Button>
      </EmptyState>
    );
  }
  return (
    <div className="mp-page">
      <div className="mp-page-controls">
        <div className="mp-page-head">
          <Combobox variant="search" className="mp-search" value={query} onChange={setQuery} placeholder={strings.playlists.search} />
          <div className="mp-add mp-add--icons">
            <IconButton label={strings.playlists.new} surface={0} onClick={() => dialogs.create()}>
              <IconPlus size={20} />
            </IconButton>
          </div>
        </div>
        <div className="mp-page-head">
          <SortMenu orders={SORTS} labels={strings.playlists.sorts} value={sort} onChange={setSort} />
        </div>
      </div>
      {shown.length === 0 ? (
        <EmptyState>{strings.music.nothingFound(query.trim())}</EmptyState>
      ) : (
        <TitleGrid aria-label={strings.pages.playlists.label}>
          {shown.map((p) => (
            <PlaylistTile key={p.id} playlist={p} songs={songs} onOpen={() => open(String(p.id))} />
          ))}
        </TitleGrid>
      )}
    </div>
  );
}
