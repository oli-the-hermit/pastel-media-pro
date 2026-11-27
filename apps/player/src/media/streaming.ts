/**
 * Streaming as its page lists it: the library's videos on three shelves (films, series, clips), what was watched
 * of each, filtered, sorted and searched in memory, and what Home suggests. No React here: plain functions, tested
 * on their own.
 */
import { progressOf, resumePoint, type Play } from './history';
import type { LibSeries, LibVideo, Library } from './library';
import { byName, firstFew, latestFirst, matcher } from './listing';

export type StreamingSection = 'home' | 'movies' | 'series' | 'clips';
export const STREAMING_SECTIONS: StreamingSection[] = ['home', 'movies', 'series', 'clips'];

export type WatchState = 'unwatched' | 'progress' | 'watched';
/** The watch filter: everything, or only what is in one state. */
export type Watch = 'all' | WatchState;
export const WATCH_FILTERS: Watch[] = ['all', 'unwatched', 'progress', 'watched'];

export type VideoSort = 'added' | 'watched' | 'az' | 'za' | 'year';
/** Films and clips; a series has no year of its own, so it has no Year order. */
export const VIDEO_SORTS: VideoSort[] = ['added', 'watched', 'az', 'za', 'year'];
export const SERIES_SORTS: VideoSort[] = ['added', 'watched', 'az', 'za'];

/** A video that is not an episode and is shorter than this (seconds) is a clip, not a film (open question O19). */
export const CLIP_MAX = 20 * 60;
/** How many titles a row of Home holds. */
export const ROW_MAX = 20;
/** How many titles Home's banner suggests (the design system's HeroBanner shows no more). */
export const HERO_MAX = 6;

type History = ReadonlyMap<string, Play>;

export interface Shelves {
  films: LibVideo[];
  clips: LibVideo[];
  series: LibSeries[];
}

/** A video whose length is known and short. One whose length is not known stays a film. */
export const isClip = (v: LibVideo) => v.duration != null && v.duration > 0 && v.duration < CLIP_MAX;

/** The library's videos on their shelves. */
export function shelve(library: Pick<Library, 'movies' | 'series'>): Shelves {
  return { films: library.movies.filter((v) => !isClip(v)), clips: library.movies.filter(isClip), series: library.series };
}

export const videoName = (v: LibVideo) => v.title || v.fileName;

/** A video is in progress once enough of it was seen to pick it up there (history.ts `resumePoint`). */
export function videoState(v: LibVideo, history: History): WatchState {
  const play = history.get(v.path);
  if (!play) return 'unwatched';
  if (play.finished) return 'watched';
  return resumePoint(play) > 0 ? 'progress' : 'unwatched';
}

/** Seconds left of a video that was started; 0 when its length is not known. */
export function leftOf(v: LibVideo, history: History): number {
  const play = history.get(v.path);
  const length = play?.duration || v.duration || 0;
  return play && length > 0 ? Math.max(0, length - play.position) : 0;
}

/** A series' episodes in the order they are watched: its seasons, then its specials. */
export function episodesOf(series: LibSeries): LibVideo[] {
  return [...series.episodes.filter((e) => e.season !== 0), ...series.episodes.filter((e) => e.season === 0)];
}

/** Watched once every episode is; in progress once any was started. */
export function seriesState(series: LibSeries, history: History): WatchState {
  const states = series.episodes.map((e) => videoState(e, history));
  if (states.length > 0 && states.every((s) => s === 'watched')) return 'watched';
  return states.some((s) => s !== 'unwatched') ? 'progress' : 'unwatched';
}

/** How much of a series was seen, 0 to 1: its episodes' own progress, together. */
export function seriesProgress(series: LibSeries, history: History): number {
  if (series.episodes.length === 0) return 0;
  return series.episodes.reduce((sum, e) => sum + progressOf(history.get(e.path)), 0) / series.episodes.length;
}

/**
 * The episode a series goes on with: the one watched last when it was left part-way, otherwise the first one after
 * it that is not watched (or, past the end, the first one that is not). A series never started, or watched to its
 * end, starts at its first episode.
 */
export function nextEpisode(series: LibSeries, history: History): LibVideo | null {
  const episodes = episodesOf(series);
  if (episodes.length === 0) return null;
  const playedAt = (e: LibVideo) => history.get(e.path)?.lastPlayedAt ?? -1;
  let last = -1;
  episodes.forEach((e, i) => {
    if (playedAt(e) >= 0 && (last < 0 || playedAt(e) >= playedAt(episodes[last]))) last = i;
  });
  if (last < 0) return episodes[0];
  if (videoState(episodes[last], history) === 'progress') return episodes[last];
  const open = (e: LibVideo) => videoState(e, history) !== 'watched';
  return episodes.slice(last + 1).find(open) ?? episodes.find(open) ?? episodes[0];
}

/** Only what is in the state asked for; everything for `all`. */
export function keep<T>(items: T[], watch: Watch, state: (item: T) => WatchState): T[] {
  return watch === 'all' ? items : items.filter((item) => state(item) === watch);
}

const seriesName = (s: LibSeries) => s.title;
const newestOf = (s: LibSeries) => s.episodes.reduce((m, e) => Math.max(m, e.addedAt ?? 0), 0);
const lastWatched = (v: LibVideo, history: History) => history.get(v.path)?.lastPlayedAt ?? 0;
const seriesWatched = (s: LibSeries, history: History) => s.episodes.reduce((m, e) => Math.max(m, lastWatched(e, history)), 0);

/** Films or clips in an order: the latest added or watched first, by name, or the newest year first (no year last). */
export function sortVideos(videos: LibVideo[], sort: VideoSort, history: History): LibVideo[] {
  const az = byName(videoName);
  const out = [...videos];
  if (sort === 'added') out.sort(latestFirst((v) => v.addedAt ?? 0, videoName));
  else if (sort === 'watched') out.sort(latestFirst((v) => lastWatched(v, history), videoName));
  else if (sort === 'year') out.sort(latestFirst((v) => v.year ?? 0, videoName));
  else out.sort(sort === 'za' ? (a, b) => az(b, a) : az);
  return out;
}

/** Series in an order: by their newest episode, the one watched last, or by name. */
export function sortSeries(series: LibSeries[], sort: VideoSort, history: History): LibSeries[] {
  const az = byName(seriesName);
  const out = [...series];
  if (sort === 'added') out.sort(latestFirst(newestOf, seriesName));
  else if (sort === 'watched') out.sort(latestFirst((s) => seriesWatched(s, history), seriesName));
  else out.sort(sort === 'za' ? (a, b) => az(b, a) : az);
  return out;
}

/** What a search finds: films and clips by title, year or genre; series by title. An empty search finds everything. */
export function searchStreaming(shelves: Shelves, query: string): Shelves {
  const match = matcher(query);
  if (!match) return shelves;
  const video = (v: LibVideo) => match(`${videoName(v)} ${v.year ?? ''} ${(v.genres ?? []).join(' ')}`);
  return { films: shelves.films.filter(video), clips: shelves.clips.filter(video), series: shelves.series.filter((s) => match(s.title)) };
}

export interface StreamingSuggestion {
  kind: 'film' | 'series' | 'clip';
  id: string;
  label: string;
  /** A film's year. */
  detail: string;
}

/** A few of each kind for the search's list, names that start with what was typed first. */
export function suggestStreaming(shelves: Shelves, query: string, each = 4): StreamingSuggestion[] {
  if (!matcher(query)) return [];
  const found = searchStreaming(shelves, query);
  const video = (kind: 'film' | 'clip') => (v: LibVideo): StreamingSuggestion => ({ kind, id: v.id, label: videoName(v), detail: v.year ? String(v.year) : '' });
  return [
    ...firstFew(found.films, query, videoName, each).map(video('film')),
    ...firstFew(found.series, query, seriesName, each).map((s): StreamingSuggestion => ({ kind: 'series', id: s.id, label: s.title, detail: '' })),
    ...firstFew(found.clips, query, videoName, each).map(video('clip')),
  ];
}

/** One title Home suggests: a film or a clip, or a series with the episode it goes on with. */
export interface HomePick {
  /** The title's id: the film's, or the series'. */
  id: string;
  /** Why it is suggested. */
  reason: 'continue' | 'new' | 'unwatched';
  /** What Play starts: the film, or the series' next episode. */
  video: LibVideo;
  series?: LibSeries;
}

export interface Home {
  /** The banner: a few titles in progress, then the newest, then ones not watched yet. */
  hero: HomePick[];
  /** Started and not finished, the latest first. A series shows the episode it goes on with. */
  continuing: HomePick[];
  newFilms: LibVideo[];
  newSeries: LibSeries[];
  /** Films and series never started: the ones that waited longest first. */
  unwatched: HomePick[];
  /** A row per genre that several films share (genres come from a `.nfo` beside the file). */
  genres: { genre: string; films: LibVideo[] }[];
}

/** What Home shows, from the shelves and what was watched. */
export function buildHome(shelves: Shelves, history: History): Home {
  const film = (reason: HomePick['reason']) => (v: LibVideo): HomePick => ({ id: v.id, reason, video: v });
  const show = (reason: HomePick['reason']) => (s: LibSeries): HomePick | null => {
    const video = nextEpisode(s, history);
    return video ? { id: s.id, reason, video, series: s } : null;
  };
  const picked = (p: HomePick | null): p is HomePick => p !== null;
  const at = (p: HomePick) => (p.series ? seriesWatched(p.series, history) : lastWatched(p.video, history));
  const name = (p: HomePick) => (p.series ? p.series.title : videoName(p.video));
  const added = (p: HomePick) => (p.series ? newestOf(p.series) : (p.video.addedAt ?? 0));

  const continuing = [
    ...[...shelves.films, ...shelves.clips].filter((v) => videoState(v, history) === 'progress').map(film('continue')),
    ...shelves.series.filter((s) => seriesState(s, history) === 'progress').map(show('continue')).filter(picked),
  ].sort(latestFirst(at, name));

  // Without a date there is no "new": a library that has none has no such rows.
  const dated = <T>(items: T[], date: (x: T) => number) => items.filter((x) => date(x) > 0);
  const newFilms = sortVideos(dated(shelves.films, (v) => v.addedAt ?? 0), 'added', history).slice(0, ROW_MAX);
  const newSeries = sortSeries(dated(shelves.series, newestOf), 'added', history).slice(0, ROW_MAX);

  const waiting = [
    ...shelves.films.filter((v) => videoState(v, history) === 'unwatched').map(film('unwatched')),
    ...shelves.series.filter((s) => seriesState(s, history) === 'unwatched').map(show('unwatched')).filter(picked),
  ].sort((a, b) => added(a) - added(b) || byName(name)(a, b));

  const byGenre = new Map<string, LibVideo[]>();
  for (const v of shelves.films) for (const g of v.genres ?? []) byGenre.set(g, [...(byGenre.get(g) ?? []), v]);
  const genres = [...byGenre]
    .filter(([, films]) => films.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([genre, films]) => ({ genre, films: [...films].sort(byName(videoName)).slice(0, ROW_MAX) }));

  // The banner: three in progress at most, two of the newest, then ones that wait; whatever is left fills it.
  const fresh = [...newFilms.map(film('new')), ...newSeries.map(show('new')).filter(picked)].sort(latestFirst(added, name));
  const hero: HomePick[] = [];
  const take = (from: HomePick[], most: number) => {
    let left = most;
    for (const p of from) {
      if (left <= 0 || hero.length >= HERO_MAX) return;
      if (hero.some((h) => h.id === p.id)) continue;
      hero.push(p);
      left -= 1;
    }
  };
  take(continuing.filter((p) => p.series || !isClip(p.video)), 3);
  take(fresh.filter((p) => !continuing.some((c) => c.id === p.id)), 2);
  take(waiting, HERO_MAX);
  take(continuing, HERO_MAX);
  take(fresh, HERO_MAX);

  return { hero, continuing: continuing.slice(0, ROW_MAX), newFilms, newSeries, unwatched: waiting.slice(0, ROW_MAX), genres };
}
