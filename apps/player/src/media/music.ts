/**
 * Music as its page lists it: songs, albums and artists built from the library, sorted and searched in memory
 * (fine up to a few tens of thousands of songs; the database's own search comes with the materialised tables).
 * No React here: plain functions, tested on their own.
 */
import type { Play } from './history';
import type { LibAlbum, LibTrack, Library } from './library';

export type MusicView = 'songs' | 'albums' | 'artists';
export type MusicSort = 'played' | 'added' | 'az' | 'za';
export const MUSIC_VIEWS: MusicView[] = ['songs', 'albums', 'artists'];
export const MUSIC_SORTS: MusicSort[] = ['played', 'added', 'az', 'za'];

/** The id of the one entry that holds every song without an album. */
export const NO_ALBUM = 'no-album';

export interface AlbumEntry {
  id: string;
  /** Empty for the songs without an album. */
  title: string;
  /** Empty when unknown, and for a compilation. */
  artist: string;
  /** Its songs are by several artists and it has none of its own: "Various artists". */
  various: boolean;
  year: number | null;
  tracks: LibTrack[];
  /** The library album whose cover it shows; empty for the songs without an album. */
  coverId: string;
  /** When its newest song joined the library. */
  addedAt: number;
}

export interface ArtistEntry {
  id: string;
  /** Empty when unknown. */
  name: string;
  albums: AlbumEntry[];
  /** Their songs that have no album. */
  loose: LibTrack[];
  songs: number;
  addedAt: number;
}

export interface MusicIndex {
  songs: LibTrack[];
  albums: AlbumEntry[];
  artists: ArtistEntry[];
  /** The album a song is in (the no-album entry for a song without one). */
  albumOf: Map<string, AlbumEntry>;
}

/** Lower case, without accents or punctuation: "Pokémon" is found by "pokemon", "AC/DC" by "acdc" or "ac dc". */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const newest = (tracks: LibTrack[]) => tracks.reduce((m, t) => Math.max(m, t.addedAt ?? 0), 0);

/** The library's music as songs, albums (songs without one share a single entry) and artists. */
export function buildMusic(library: Pick<Library, 'tracks' | 'albums'>): MusicIndex {
  const byId = new Map(library.tracks.map((t) => [t.id, t]));
  const albums: AlbumEntry[] = [];
  const loose: LibTrack[] = [];
  const albumOf = new Map<string, AlbumEntry>();
  for (const a of library.albums) {
    const tracks = a.trackIds.map((id) => byId.get(id)).filter((t): t is LibTrack => !!t);
    if (!a.title.trim()) {
      loose.push(...tracks);
      continue;
    }
    const various = !a.artist && new Set(tracks.map((t) => fold(t.artist))).size > 1;
    const entry: AlbumEntry = { id: a.id, title: a.title, artist: a.artist, various, year: a.year, tracks, coverId: a.id, addedAt: newest(tracks) };
    albums.push(entry);
    for (const t of tracks) albumOf.set(t.id, entry);
  }
  if (loose.length > 0) {
    const entry: AlbumEntry = { id: NO_ALBUM, title: '', artist: '', various: true, year: null, tracks: loose, coverId: '', addedAt: newest(loose) };
    albums.push(entry);
    for (const t of loose) albumOf.set(t.id, entry);
  }

  // An artist is who an album is by; a song without an album belongs to its own artist.
  const artists = new Map<string, ArtistEntry>();
  const artist = (name: string) => {
    const key = fold(name);
    let a = artists.get(key);
    if (!a) {
      a = { id: `artist:${key}`, name: name.trim(), albums: [], loose: [], songs: 0, addedAt: 0 };
      artists.set(key, a);
    }
    return a;
  };
  for (const al of albums) {
    if (al.id === NO_ALBUM) continue;
    // A compilation is listed under each artist who has a song on it
    const names = al.various ? al.tracks.map((t) => t.artist) : [al.artist];
    for (const name of new Map(names.map((n) => [fold(n), n])).values()) {
      const a = artist(name);
      a.albums.push(al);
      a.songs += al.various ? al.tracks.filter((t) => fold(t.artist) === fold(name)).length : al.tracks.length;
      a.addedAt = Math.max(a.addedAt, al.addedAt);
    }
  }
  for (const t of loose) {
    const a = artist(t.artist);
    a.loose.push(t);
    a.songs += 1;
    a.addedAt = Math.max(a.addedAt, t.addedAt ?? 0);
  }
  return { songs: library.tracks, albums, artists: [...artists.values()], albumOf };
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
/** A–Z as people file names: "The Quiet Hours" under Q; nameless ones last. */
const filed = (s: string) => fold(s).replace(/^(?:the|a|an|el|la|los|las|le|les) (?=\S)/, '');
function byName<T>(name: (x: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const [x, y] = [filed(name(a)), filed(name(b))];
    if (!x || !y) return x ? -1 : y ? 1 : 0;
    return collator.compare(x, y);
  };
}

type History = ReadonlyMap<string, Play>;
const lastPlayed = (tracks: LibTrack[], history: History) => tracks.reduce((m, t) => Math.max(m, history.get(t.path)?.lastPlayedAt ?? 0), 0);

/** Sorts a list: by when it was last played or added (the latest first, the never-played after them by name), or by name. */
function sorted<T>(items: T[], sort: MusicSort, name: (x: T) => string, played: (x: T) => number, added: (x: T) => number): T[] {
  const az = byName(name);
  const by = (value: (x: T) => number) => (a: T, b: T) => value(b) - value(a) || az(a, b);
  const out = [...items];
  if (sort === 'played') out.sort(by(played));
  else if (sort === 'added') out.sort(by(added));
  else out.sort(sort === 'az' ? az : (a, b) => az(b, a));
  return out;
}

export function sortSongs(songs: LibTrack[], sort: MusicSort, history: History): LibTrack[] {
  return sorted(songs, sort, (t) => t.title, (t) => history.get(t.path)?.lastPlayedAt ?? 0, (t) => t.addedAt ?? 0);
}
export function sortAlbums(albums: AlbumEntry[], sort: MusicSort, history: History): AlbumEntry[] {
  return sorted(albums, sort, (a) => a.title, (a) => lastPlayed(a.tracks, history), (a) => a.addedAt);
}
export function sortArtists(artists: ArtistEntry[], sort: MusicSort, history: History): ArtistEntry[] {
  const tracks = (a: ArtistEntry) => [...a.albums.flatMap((al) => al.tracks), ...a.loose];
  return sorted(artists, sort, (a) => a.name, (a) => lastPlayed(tracks(a), history), (a) => a.addedAt);
}

/** Every word typed is in the text, each at the start of a word: "pol ni" finds "Polar Nights". */
function matcher(query: string): ((text: string) => boolean) | null {
  const words = fold(query).split(' ').filter(Boolean);
  if (words.length === 0) return null;
  return (text) => {
    const t = ` ${fold(text)}`;
    return words.every((w) => t.includes(` ${w}`));
  };
}

export interface MusicResults {
  songs: LibTrack[];
  albums: AlbumEntry[];
  artists: ArtistEntry[];
}

/** What a search finds: songs by title, artist or album; albums by title or artist; artists by name. An empty search finds everything. */
export function searchMusic(index: MusicIndex, query: string): MusicResults {
  const match = matcher(query);
  if (!match) return { songs: index.songs, albums: index.albums, artists: index.artists };
  return {
    songs: index.songs.filter((t) => match(`${t.title} ${t.artist} ${t.album}`)),
    albums: index.albums.filter((a) => a.id !== NO_ALBUM && match(`${a.title} ${a.artist} ${a.various ? a.tracks.map((t) => t.artist).join(' ') : ''}`)),
    artists: index.artists.filter((a) => a.name !== '' && match(a.name)),
  };
}

export interface MusicSuggestion {
  kind: 'song' | 'album' | 'artist';
  id: string;
  label: string;
  detail: string;
}

/** A few of each kind for the search's list, names that start with what was typed first. */
export function suggestMusic(index: MusicIndex, query: string, each = 4): MusicSuggestion[] {
  const q = fold(query);
  if (!q) return [];
  const found = searchMusic(index, query);
  const first = <T>(items: T[], name: (x: T) => string) => {
    const starts = (x: T) => (fold(name(x)).startsWith(q) ? 0 : 1);
    return [...items].sort((a, b) => starts(a) - starts(b) || byName(name)(a, b)).slice(0, each);
  };
  return [
    ...first(found.artists, (a) => a.name).map((a): MusicSuggestion => ({ kind: 'artist', id: a.id, label: a.name, detail: '' })),
    ...first(found.albums, (a) => a.title).map((a): MusicSuggestion => ({ kind: 'album', id: a.id, label: a.title, detail: a.artist })),
    ...first(found.songs, (t) => t.title).map((t): MusicSuggestion => ({ kind: 'song', id: t.id, label: t.title, detail: [t.artist, t.album].filter(Boolean).join(' · ') })),
  ];
}

/** The library album behind an entry, for the pieces that still take one (the album page, the cover). */
export function asLibAlbum(entry: AlbumEntry): LibAlbum {
  return { id: entry.coverId || entry.id, title: entry.title, artist: entry.artist, year: entry.year, trackIds: entry.tracks.map((t) => t.id) };
}
