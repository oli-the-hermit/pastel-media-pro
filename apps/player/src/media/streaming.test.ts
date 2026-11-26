import { describe, expect, it } from 'vitest';
import type { Play } from './history';
import type { LibSeries, LibVideo } from './library';
import {
  buildHome, episodesOf, keep, nextEpisode, searchStreaming, seriesState, shelve, sortSeries, sortVideos, suggestStreaming, videoState,
} from './streaming';

let n = 0;
const video = (title: string, more: Partial<LibVideo> = {}): LibVideo => ({
  id: `v${n++}`,
  title,
  year: null,
  season: null,
  episode: null,
  episodeTitle: null,
  fileName: `${title}.mkv`,
  path: `D:/Videos/${title}-${n}.mkv`,
  ...more,
});
const ep = (season: number, episode: number, addedAt = 0) => video('Dark', { season, episode, addedAt, duration: 3000 });

const heat = video('Heat', { year: 1995, duration: 10200, addedAt: 30, genres: ['Crime', 'Thriller'] });
const ronin = video('Ronin', { year: 1998, duration: 7300, addedAt: 20, genres: ['Crime'] });
const quiet = video('The Quiet Earth', { year: 1985, duration: 5400, addedAt: 10 });
const unknown = video('Home video'); // no length: it stays a film
const jamboo = video('Coco Jamboo', { year: 1996, duration: 215, addedAt: 40 });
const special = ep(0, 1);
const [e1, e2, e3] = [ep(1, 1, 5), ep(1, 2, 5), ep(2, 1, 50)];
const dark: LibSeries = { id: 's0', title: 'Dark', episodes: [special, e1, e2, e3] };
const lost: LibSeries = { id: 's1', title: 'Lost', episodes: [video('Lost', { season: 1, episode: 1, addedAt: 15 })] };

const shelves = shelve({ movies: [heat, ronin, quiet, unknown, jamboo], series: [dark, lost] });

const play = (v: LibVideo, position: number, at: number, finished = false): [string, Play] => [
  v.path,
  { path: v.path, position, duration: v.duration ?? 0, finished, count: 1, lastPlayedAt: at },
];
const none = new Map<string, Play>();

describe('the shelves', () => {
  it('puts short videos with Clips and the rest, also the ones of unknown length, with Movies', () => {
    expect(shelves.clips).toEqual([jamboo]);
    expect(shelves.films).toEqual([heat, ronin, quiet, unknown]);
    expect(shelves.series).toHaveLength(2);
  });
});

describe('what was watched', () => {
  it('counts a video as in progress only once enough was seen to pick it up', () => {
    expect(videoState(heat, none)).toBe('unwatched');
    expect(videoState(heat, new Map([play(heat, 10, 1)]))).toBe('unwatched');
    expect(videoState(heat, new Map([play(heat, 900, 1)]))).toBe('progress');
    expect(videoState(heat, new Map([play(heat, 10000, 1, true)]))).toBe('watched');
  });

  it('counts a series as watched when every episode is, in progress once one was started', () => {
    expect(seriesState(dark, none)).toBe('unwatched');
    expect(seriesState(dark, new Map([play(e1, 3000, 1, true)]))).toBe('progress');
    expect(seriesState(dark, new Map([special, e1, e2, e3].map((e, i) => play(e, 3000, i, true))))).toBe('watched');
  });

  it('filters by state', () => {
    const history = new Map([play(heat, 900, 1), play(ronin, 7000, 2, true)]);
    const state = (v: LibVideo) => videoState(v, history);
    expect(keep(shelves.films, 'all', state)).toHaveLength(4);
    expect(keep(shelves.films, 'progress', state)).toEqual([heat]);
    expect(keep(shelves.films, 'watched', state)).toEqual([ronin]);
    expect(keep(shelves.films, 'unwatched', state)).toEqual([quiet, unknown]);
  });
});

describe('the episode a series goes on with', () => {
  it('watches the seasons before the specials', () => {
    expect(episodesOf(dark)).toEqual([e1, e2, e3, special]);
  });
  it('starts a series never played at its first episode', () => {
    expect(nextEpisode(dark, none)).toBe(e1);
  });
  it('stays on the episode left part-way', () => {
    expect(nextEpisode(dark, new Map([play(e1, 3000, 1, true), play(e2, 600, 2)]))).toBe(e2);
  });
  it('moves on to the one after the episode watched last', () => {
    expect(nextEpisode(dark, new Map([play(e1, 3000, 1, true), play(e2, 3000, 2, true)]))).toBe(e3);
  });
  it('comes back for an episode that was skipped, once the end is reached', () => {
    expect(nextEpisode(dark, new Map([play(e1, 3000, 1, true), play(e3, 3000, 2, true), play(special, 3000, 3, true)]))).toBe(e2);
  });
  it('starts again once everything was watched', () => {
    expect(nextEpisode(dark, new Map([special, e1, e2, e3].map((e, i) => play(e, 3000, i, true))))).toBe(e1);
  });
});

describe('the order', () => {
  const titles = (videos: LibVideo[]) => videos.map((v) => v.title);
  it('sorts films by when they were added, watched, by name and by year', () => {
    const history = new Map([play(quiet, 900, 9), play(ronin, 900, 5)]);
    expect(titles(sortVideos(shelves.films, 'added', history))).toEqual(['Heat', 'Ronin', 'The Quiet Earth', 'Home video']);
    expect(titles(sortVideos(shelves.films, 'watched', history))).toEqual(['The Quiet Earth', 'Ronin', 'Heat', 'Home video']);
    expect(titles(sortVideos(shelves.films, 'az', history))).toEqual(['Heat', 'Home video', 'The Quiet Earth', 'Ronin']);
    expect(titles(sortVideos(shelves.films, 'za', history))).toEqual(['Ronin', 'The Quiet Earth', 'Home video', 'Heat']);
    expect(titles(sortVideos(shelves.films, 'year', history))).toEqual(['Ronin', 'Heat', 'The Quiet Earth', 'Home video']);
  });
  it('sorts series by their newest episode', () => {
    expect(sortSeries(shelves.series, 'added', none).map((s) => s.title)).toEqual(['Dark', 'Lost']);
    expect(sortSeries(shelves.series, 'za', none).map((s) => s.title)).toEqual(['Lost', 'Dark']);
  });
});

describe('the search', () => {
  it('finds films by title, year and genre, and series by title', () => {
    expect(searchStreaming(shelves, 'qui ear').films).toEqual([quiet]);
    expect(searchStreaming(shelves, '1995').films).toEqual([heat]);
    expect(searchStreaming(shelves, 'crime').films).toEqual([heat, ronin]);
    expect(searchStreaming(shelves, 'dar').series).toEqual([dark]);
    expect(searchStreaming(shelves, '').films).toHaveLength(4);
  });
  it('suggests a few of each kind', () => {
    expect(suggestStreaming(shelves, 'co').map((s) => [s.kind, s.label])).toEqual([['clip', 'Coco Jamboo']]);
    expect(suggestStreaming(shelves, 'h').map((s) => [s.kind, s.label, s.detail])).toEqual([
      ['film', 'Heat', '1995'],
      ['film', 'Home video', ''],
    ]);
    expect(suggestStreaming(shelves, '  ')).toEqual([]);
  });
});

describe('Home', () => {
  it('suggests what waits when nothing was watched, the newest first in its rows', () => {
    const home = buildHome(shelves, none);
    expect(home.continuing).toEqual([]);
    expect(home.newFilms.map((v) => v.title)).toEqual(['Heat', 'Ronin', 'The Quiet Earth']);
    expect(home.newSeries.map((s) => s.title)).toEqual(['Dark', 'Lost']);
    // The ones that waited longest first; a film without a date before them all
    expect(home.unwatched.map((p) => p.series?.title ?? p.video.title)).toEqual(['Home video', 'The Quiet Earth', 'Lost', 'Ronin', 'Heat', 'Dark']);
    expect(home.hero).toHaveLength(6);
    expect(home.hero.slice(0, 2).map((p) => [p.reason, p.series?.title ?? p.video.title])).toEqual([
      ['new', 'Dark'],
      ['new', 'Heat'],
    ]);
    expect(new Set(home.hero.map((p) => p.id)).size).toBe(6);
  });

  it('puts what was left part-way first: a film where it was, a series at its next episode', () => {
    const history = new Map([play(heat, 900, 5), play(e1, 3000, 9, true), play(jamboo, 60, 7)]);
    const home = buildHome(shelves, history);
    expect(home.continuing.map((p) => [p.series?.title ?? p.video.title, p.video.id])).toEqual([
      ['Dark', e2.id],
      ['Coco Jamboo', jamboo.id],
      ['Heat', heat.id],
    ]);
    // The banner leaves clips to their row
    expect(home.hero.slice(0, 2).map((p) => [p.reason, p.series?.title ?? p.video.title])).toEqual([
      ['continue', 'Dark'],
      ['continue', 'Heat'],
    ]);
    expect(home.unwatched.some((p) => p.id === heat.id || p.id === dark.id)).toBe(false);
  });

  it('makes a row for a genre several films share', () => {
    expect(buildHome(shelves, none).genres).toEqual([{ genre: 'Crime', films: [heat, ronin] }]);
  });
});
