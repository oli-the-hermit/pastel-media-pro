import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlbumPage, Button, Combobox, EmptyState, FilterChips, IconChevronDown, IconMusic, IconPlay, IconShuffle, IconUser, Menu, TextButton, TitleGrid,
  TitleTile, TrackList,
  type ComboboxOption,
} from '@pastel-studio/react';
import { strings } from '../strings';
import { useHistory } from './history';
import { AddButtons } from './LibraryFolders';
import { toAlbum, toTrack, useCover, type LibTrack, type Library } from './library';
import {
  MUSIC_SORTS, MUSIC_VIEWS, asLibAlbum, buildMusic, searchMusic, sortAlbums, sortArtists, sortSongs, suggestMusic,
  type AlbumEntry, type ArtistEntry, type MusicSort, type MusicView,
} from './music';
import { usePlayback } from './playback';
import { useRemembered } from './remember';

const VIEW_OPTIONS = MUSIC_VIEWS.map((value) => ({ value, label: strings.music.views[value] }));
const DEFAULT_SORTS: Record<MusicView, MusicSort> = { songs: 'az', albums: 'az', artists: 'az' };

/** What is open over the lists: an album, or an artist (and maybe one of their albums over them). */
type Opened = { kind: 'album' | 'artist'; id: string };

/** A long list is drawn a part at a time: more rows as the end of what is drawn comes into view. */
function useShown(total: number, key: unknown, step = 200): [number, (el: HTMLElement | null) => void] {
  const [shown, setShown] = useState(step);
  useEffect(() => setShown(step), [key, step]);
  const watcher = useRef<IntersectionObserver | null>(null);
  const sentinel = useCallback(
    (el: HTMLElement | null) => {
      watcher.current?.disconnect();
      if (!el || typeof IntersectionObserver === 'undefined') return;
      watcher.current = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setShown((n) => Math.min(total, n + step)), { rootMargin: '600px' });
      watcher.current.observe(el);
    },
    [total, step],
  );
  return [Math.min(shown, total), sentinel];
}

const albumName = (a: AlbumEntry) => a.title || strings.music.noAlbum;
const artistName = (name: string) => name || strings.music.unknownArtist;

function AlbumTile({ album, current, onOpen }: { album: AlbumEntry; current: boolean; onOpen: () => void }) {
  const cover = useCover(album.coverId);
  return (
    <TitleTile
      title={albumName(album)}
      subtitle={strings.music.albumSubtitle(album.various ? strings.music.variousArtists : artistName(album.artist), album.tracks.length)}
      image={cover}
      icon={<IconMusic size={28} />}
      current={current}
      data-tile-id={album.id}
      onClick={onOpen}
    />
  );
}

function AlbumsGrid({ albums, onOpen }: { albums: AlbumEntry[]; onOpen: (id: string) => void }) {
  const playing = usePlayback().current?.id;
  return (
    <TitleGrid aria-label={strings.music.albums}>
      {albums.map((a) => (
        <AlbumTile key={a.id} album={a} current={!!playing && a.tracks.some((t) => t.id === playing)} onOpen={() => onOpen(a.id)} />
      ))}
    </TitleGrid>
  );
}

/** Songs as a list: their number in it, title and artist, album, when they were added, length. */
function SongsList({ songs, label }: { songs: LibTrack[]; label: string }) {
  const playback = usePlayback();
  const [shown, sentinel] = useShown(songs.length, songs);
  const tracks = useMemo(
    () =>
      songs.slice(0, shown).map((t, i) => ({
        ...toTrack(t),
        number: i + 1,
        addedAt: t.addedAt ? new Date(t.addedAt * 1000).toISOString() : undefined,
      })),
    [songs, shown],
  );
  return (
    <div className="mp-songs">
      <TrackList
        tracks={tracks}
        ariaLabel={label}
        columns={{ album: true, added: songs.some((t) => t.addedAt) }}
        currentId={playback.current?.id}
        playing={playback.engine.playing}
        onPlay={(t) => {
          if (playback.current?.id === t.id) playback.engine.toggle();
          else playback.playTracks(songs, songs.findIndex((x) => x.id === t.id));
        }}
        onPause={playback.engine.pause}
      />
      {shown < songs.length ? <div ref={sentinel} className="mp-songs-more" aria-hidden="true" /> : undefined}
    </div>
  );
}

function OpenAlbum({ album, backLabel, onBack }: { album: AlbumEntry; backLabel: string; onBack: () => void }) {
  const cover = useCover(album.coverId);
  const playback = usePlayback();
  const tracks = album.tracks;
  const view = useMemo(
    () => toAlbum({ ...asLibAlbum(album), artist: album.various ? strings.music.variousArtists : album.artist }, tracks, cover),
    [album, tracks, cover],
  );
  const playingHere = playback.current != null && tracks.some((t) => t.id === playback.current?.id);
  return (
    <div className="mp-page">
      <div>
        <TextButton onClick={onBack} autoFocus>
          {backLabel}
        </TextButton>
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

const shuffled = <T,>(items: T[]): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/** An artist's page: who it is, Play and Shuffle, their albums, then their songs that have no album. */
function OpenArtist({ artist, onOpenAlbum, onBack }: { artist: ArtistEntry; onOpenAlbum: (id: string) => void; onBack: () => void }) {
  const playback = usePlayback();
  const albums = useMemo(() => [...artist.albums].sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.title.localeCompare(b.title)), [artist]);
  const all = useMemo(() => [...albums.flatMap((a) => a.tracks), ...artist.loose], [albums, artist]);
  return (
    <div className="mp-page">
      <div>
        <TextButton onClick={onBack} autoFocus>
          {strings.music.allArtists}
        </TextButton>
      </div>
      <header className="mp-title">
        <div className="mp-title-poster mp-title-poster--round" aria-hidden="true">
          <IconUser size={48} />
        </div>
        <div className="mp-title-main">
          <span className="mp-title-kind">{strings.music.artist}</span>
          <h2 className="mp-title-name">{artistName(artist.name)}</h2>
          <p className="mp-title-facts">
            <span>{strings.music.artistFacts(albums.length, artist.songs)}</span>
          </p>
          <div className="mp-title-actions">
            <Button variant="primary" icon={<IconPlay />} onClick={() => playback.playTracks(all, 0)}>
              {strings.videos.play}
            </Button>
            <Button icon={<IconShuffle />} onClick={() => playback.playTracks(shuffled(all), 0)}>
              {strings.music.shuffle}
            </Button>
          </div>
        </div>
      </header>
      {albums.length > 0 && (
        <section className="mp-section" aria-label={strings.music.albums}>
          <h3 className="mp-heading-sm">{strings.music.albums}</h3>
          <AlbumsGrid albums={albums} onOpen={onOpenAlbum} />
        </section>
      )}
      {artist.loose.length > 0 && (
        <section className="mp-section" aria-label={strings.music.noAlbum}>
          <h3 className="mp-heading-sm">{strings.music.noAlbum}</h3>
          <SongsList songs={artist.loose} label={strings.music.noAlbum} />
        </section>
      )}
    </div>
  );
}

/**
 * Music: the library's songs, albums and artists. Two lines of controls, each kind with a shape of its own
 * (ux.md §6): the search, a field across the page, with Add a folder / Add files as bare icons at its end; under
 * it the views as chips, and the sort as a quiet menu at the end.
 */
export function MusicPage({ library }: { library: Library }) {
  const playback = usePlayback();
  const [view, setView] = useRemembered<MusicView>('pastelmedia_music_view', 'albums', (v) => MUSIC_VIEWS.includes(v as MusicView));
  const [sorts, setSorts] = useRemembered<Record<MusicView, MusicSort>>('pastelmedia_music_sort', DEFAULT_SORTS, (v) => !!v && typeof v === 'object');
  const [query, setQuery] = useState('');
  const [opened, setOpened] = useState<Opened[]>([]);
  const sort = MUSIC_SORTS.includes(sorts[view]) ? sorts[view] : 'az';
  // The history is only read once something asks for it: the "Recently played" order.
  const history = useHistory(sort === 'played');
  const index = useMemo(() => buildMusic(library), [library]);
  const found = useMemo(() => searchMusic(index, query), [index, query]);
  const songs = useMemo(() => sortSongs(found.songs, sort, history), [found, sort, history]);
  const albums = useMemo(() => sortAlbums(found.albums, sort, history), [found, sort, history]);
  const artists = useMemo(() => sortArtists(found.artists, sort, history), [found, sort, history]);

  const suggestions = useMemo<ComboboxOption[]>(
    () =>
      suggestMusic(index, query).map((s) => ({
        id: `${s.kind}:${s.id}`,
        label: s.kind === 'artist' ? artistName(s.label) : s.label,
        detail: s.detail || undefined,
        group: strings.music.kinds[s.kind],
        icon: s.kind === 'artist' ? <IconUser size={16} /> : <IconMusic size={16} />,
      })),
    [index, query],
  );
  const pick = (option: ComboboxOption) => {
    const at = option.id.indexOf(':');
    const [kind, id] = [option.id.slice(0, at), option.id.slice(at + 1)];
    if (kind === 'song') {
      const queue = index.albumOf.get(id)?.tracks ?? index.songs;
      playback.playTracks(queue, queue.findIndex((t) => t.id === id));
      return;
    }
    setQuery('');
    setOpened([{ kind: kind === 'artist' ? 'artist' : 'album', id }]);
  };

  // Going back to the lists puts the focus on the tile that was opened, so a keyboard user keeps their place.
  const returnTo = useRef<string | null>(null);
  const open = (o: Opened) => {
    if (opened.length === 0) returnTo.current = o.id;
    setOpened((list) => [...list, o]);
  };
  const back = () => setOpened((list) => list.slice(0, -1));
  useEffect(() => {
    if (opened.length > 0 || returnTo.current === null) return;
    const id = returnTo.current;
    returnTo.current = null;
    document.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(id)}"]`)?.focus();
  }, [opened]);

  if (library.tracks.length === 0) {
    return (
      <EmptyState className="mp-player-empty">
        <p>{strings.pages.music.empty}</p>
        <AddButtons preset="music" primary />
      </EmptyState>
    );
  }

  const top = opened.at(-1);
  if (top?.kind === 'album') {
    const album = index.albums.find((a) => a.id === top.id);
    const from = opened.at(-2);
    const artist = from?.kind === 'artist' ? index.artists.find((a) => a.id === from.id) : undefined;
    if (album) return <OpenAlbum key={album.id} album={album} backLabel={artist ? artistName(artist.name) : strings.music.allAlbums} onBack={back} />;
  }
  if (top?.kind === 'artist') {
    const artist = index.artists.find((a) => a.id === top.id);
    if (artist) return <OpenArtist key={artist.id} artist={artist} onOpenAlbum={(id) => open({ kind: 'album', id })} onBack={back} />;
  }

  const count = view === 'songs' ? songs.length : view === 'albums' ? albums.length : artists.length;
  return (
    <div className="mp-page">
      <div className="mp-page-controls">
        <div className="mp-page-head">
          <Combobox
            variant="search"
            className="mp-search"
            value={query}
            onChange={setQuery}
            suggestions={suggestions}
            onPick={pick}
            placeholder={strings.music.search}
          />
          <AddButtons preset="music" icons />
        </div>
        <div className="mp-page-head">
          <FilterChips options={VIEW_OPTIONS} value={view} onChange={setView} ariaLabel={strings.music.viewsLabel} />
          <Menu
            align="end"
            ariaLabel={strings.music.sortedBy(strings.music.sorts[sort])}
            triggerClassName="mp-sort"
            trigger={
              <>
                {strings.music.sorts[sort]}
                <IconChevronDown size={16} />
              </>
            }
            items={MUSIC_SORTS.map((value) => ({ key: value, label: strings.music.sorts[value], checked: value === sort, onSelect: () => setSorts({ ...sorts, [view]: value }) }))}
          />
        </div>
      </div>
      {count === 0 ? (
        <EmptyState>{strings.music.nothingFound(query.trim())}</EmptyState>
      ) : view === 'songs' ? (
        <SongsList songs={songs} label={strings.music.views.songs} />
      ) : view === 'albums' ? (
        <AlbumsGrid albums={albums} onOpen={(id) => open({ kind: 'album', id })} />
      ) : (
        <TitleGrid shape="round" aria-label={strings.music.views.artists}>
          {artists.map((a) => (
            <TitleTile
              key={a.id}
              shape="round"
              title={artistName(a.name)}
              subtitle={strings.music.artistFacts(a.albums.length, a.songs)}
              icon={<IconUser size={28} />}
              data-tile-id={a.id}
              onClick={() => open({ kind: 'artist', id: a.id })}
            />
          ))}
        </TitleGrid>
      )}
    </div>
  );
}
