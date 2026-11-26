import { describe, expect, it } from 'vitest';
import type { Play } from './history';
import type { LibAlbum, LibTrack } from './library';
import { NO_ALBUM, buildMusic, fold, searchMusic, sortAlbums, sortArtists, sortSongs, suggestMusic } from './music';

let n = 0;
const song = (title: string, artist: string, album: string, addedAt = 0): LibTrack => ({
  id: `t${n++}`,
  title,
  artist,
  album,
  number: null,
  disc: null,
  year: null,
  duration: 200,
  path: `D:/Music/${artist}/${album}/${title}.mp3`,
  unplayable: false,
  addedAt,
});
const album = (id: string, title: string, artist: string, tracks: LibTrack[]): LibAlbum => ({ id, title, artist, year: null, trackIds: tracks.map((t) => t.id) });

const lights = song('Northern Lights', 'Aurora Collective', 'Polar Nights', 10);
const melt = song('Meltwater', 'Aurora Collective', 'Polar Nights', 10);
const tide = song('Low Tide', 'Marta Vey', 'Low Tide', 30);
const boats = song('Paper Boats', 'The Quiet Hours', 'Paper Boats', 20);
const demo = song('Demo 3', 'Marta Vey', '', 40);
const stray = song('Untitled', '', '', 5);
const library = {
  tracks: [lights, melt, tide, boats, demo, stray],
  albums: [
    album('a0', 'Polar Nights', 'Aurora Collective', [lights, melt]),
    album('a1', 'Low Tide', 'Marta Vey', [tide]),
    album('a2', 'Paper Boats', 'The Quiet Hours', [boats]),
    // The library makes one nameless album per artist: the page shows them as one entry
    album('a3', '', 'Marta Vey', [demo]),
    album('a4', '', '', [stray]),
  ],
};
const index = buildMusic(library);
const played = (path: string, at: number): [string, Play] => [path, { path, position: 0, duration: 200, finished: true, count: 1, lastPlayedAt: at }];
const names = (xs: { title?: string; name?: string }[]) => xs.map((x) => x.title ?? x.name);

describe('Music, as its page lists it', () => {
  it('gathers the songs without an album into one entry', () => {
    expect(index.albums.map((a) => a.id)).toEqual(['a0', 'a1', 'a2', NO_ALBUM]);
    const loose = index.albums.at(-1)!;
    expect(loose.tracks).toEqual([demo, stray]);
    expect(index.albumOf.get(demo.id)).toBe(loose);
    expect(index.albumOf.get(lights.id)?.title).toBe('Polar Nights');
  });

  it('lists artists by their albums, and by their songs that have no album', () => {
    const marta = index.artists.find((a) => a.name === 'Marta Vey')!;
    expect(marta.albums.map((a) => a.title)).toEqual(['Low Tide']);
    expect(marta.loose).toEqual([demo]);
    expect(marta.songs).toBe(2);
    expect(index.artists.find((a) => a.name === '')?.songs).toBe(1);
    expect(index.artists.find((a) => a.name === 'Aurora Collective')?.songs).toBe(2);
  });

  it('lists a compilation under each artist with a song on it', () => {
    const a = song('First', 'Cecil Sharp Project', 'English Folk');
    const b = song('Second', 'Bella Hardy', 'English Folk');
    const folk = buildMusic({ tracks: [a, b], albums: [album('c0', 'English Folk', '', [a, b])] });
    expect(folk.albums[0].various).toBe(true);
    expect(folk.artists.map((x) => [x.name, x.albums.length, x.songs])).toEqual([['Cecil Sharp Project', 1, 1], ['Bella Hardy', 1, 1]]);
    expect(names(searchMusic(folk, 'bella').albums)).toEqual(['English Folk']);
  });

  it('sorts by name as people file it, the nameless last', () => {
    expect(names(sortAlbums(index.albums, 'az', new Map()))).toEqual(['Low Tide', 'Paper Boats', 'Polar Nights', '']);
    expect(names(sortArtists(index.artists, 'az', new Map()))).toEqual(['Aurora Collective', 'Marta Vey', 'The Quiet Hours', '']);
    expect(names(sortArtists(index.artists, 'za', new Map())).slice(0, 2)).toEqual(['', 'The Quiet Hours']);
  });

  it('sorts by what was added last, and by what was played last with the never-played after', () => {
    expect(names(sortAlbums(index.albums, 'added', new Map()))).toEqual(['', 'Low Tide', 'Paper Boats', 'Polar Nights']);
    const history = new Map([played(boats.path, 500), played(melt.path, 900)]);
    expect(names(sortAlbums(index.albums, 'played', history))).toEqual(['Polar Nights', 'Paper Boats', 'Low Tide', '']);
    expect(names(sortSongs(index.songs, 'played', history)).slice(0, 3)).toEqual(['Meltwater', 'Paper Boats', 'Demo 3']);
    expect(names(sortArtists(index.artists, 'played', history))[0]).toBe('Aurora Collective');
  });

  it('finds words by their start, without accents or punctuation', () => {
    expect(fold('Pokémon: The First Movie')).toBe('pokemon the first movie');
    expect(names(searchMusic(index, 'pol ni').albums)).toEqual(['Polar Nights']);
    expect(names(searchMusic(index, 'marta').songs)).toEqual(['Low Tide', 'Demo 3']);
    expect(names(searchMusic(index, 'QUIET').artists)).toEqual(['The Quiet Hours']);
    expect(searchMusic(index, 'ights').songs).toEqual([]); // the middle of a word doesn't count
    expect(searchMusic(index, '  ').songs).toHaveLength(6);
  });

  it('suggests a few of each kind, what starts with the text first', () => {
    const s = suggestMusic(index, 'lo');
    expect(s.map((x) => `${x.kind}:${x.label}`)).toEqual(['album:Low Tide', 'song:Low Tide']);
    expect(suggestMusic(index, 'a').map((x) => x.kind)).toContain('artist');
    expect(suggestMusic(index, '')).toEqual([]);
    expect(suggestMusic(index, 'low')[1].detail).toBe('Marta Vey · Low Tide');
  });
});
