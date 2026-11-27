import { useMemo } from 'react';
import { Button, HeroBanner, IconPlay, MediaRow, type HeroBannerItem } from '@pastel-studio/react';
import { strings } from '../strings';
import type { Play } from './history';
import { usePosters, type LibSeries, type LibVideo } from './library';
import { usePlayback } from './playback';
import { buildHome, videoName, videoState, type HomePick, type Shelves, type StreamingSection, type VideoSort } from './streaming';
import { SeriesTile, VideoTile, leftLabel, lengthOf } from './VideoPages';

type History = ReadonlyMap<string, Play>;

/** A title to open on its page, and the tile (or button) the focus returns to when that page closes. */
export type OpenTitle = (title: { kind: 'video' | 'series'; id: string }, tileId: string) => void;

/** The banner moves on by itself this often (ms); it waits while the pointer or the focus is on it. */
const BANNER_EVERY = 10_000;

const nameOf = (p: HomePick) => (p.series ? p.series.title || strings.videos.unknownSeries : videoName(p.video));
const titleOf = (p: HomePick) => (p.series ? ({ kind: 'series', id: p.series.id } as const) : ({ kind: 'video', id: p.video.id } as const));
/** The picture of a suggestion: the video's own frame or poster, or its series' poster. */
const artOf = (p: HomePick) => p.video.backdrop ?? p.video.poster ?? p.series?.poster;

/** A suggestion's facts on the banner: where a series is, or a film's year, length and genres; then what is left of it. */
function factsOf(p: HomePick, history: History): string[] {
  const left = leftLabel(p.video, history);
  if (p.series) {
    return [p.video.season != null ? strings.videos.season(p.video.season) : '', strings.videos.episodeRow(p.video.episode, p.video.episodeTitle), left].filter(Boolean);
  }
  return [p.video.year ? String(p.video.year) : '', lengthOf(p.video), (p.video.genres ?? []).slice(0, 3).join(', '), left].filter(Boolean);
}

/**
 * Streaming's Home: a banner of a few titles (what was left part-way, what is new, what waits), then rows:
 * Continue watching, what was added last, what was never watched, and a row per genre the films share. A tile of
 * Continue watching plays at once, where it was left; every other tile opens its title's page.
 */
export function StreamingHome({ shelves, history, hero, onHero, onOpen, onSeeAll }: {
  shelves: Shelves;
  history: History;
  /** The banner's suggestion in view, kept by the page so it is still there after a title's page closes. */
  hero: number;
  onHero: (index: number) => void;
  onOpen: OpenTitle;
  /** A row's "See all": its section, in the row's order. */
  onSeeAll: (section: StreamingSection, sort: VideoSort) => void;
}) {
  const playback = usePlayback();
  const home = useMemo(() => buildHome(shelves, history), [shelves, history]);
  const art = usePosters(home.hero.map(artOf));

  const items: HeroBannerItem[] = home.hero.map((p, i) => ({
    id: p.id,
    overline: strings.streaming.home.reasons[p.reason],
    title: nameOf(p),
    facts: factsOf(p, history),
    summary: p.video.overview ?? undefined,
    image: art[i],
    actions: (
      <>
        <Button variant="primary" icon={<IconPlay />} onClick={() => playback.playVideo(p.video)}>
          {videoState(p.video, history) === 'progress' ? strings.videos.resumeShort : strings.videos.play}
        </Button>
        <Button data-tile-id={`hero:${p.id}`} onClick={() => onOpen(titleOf(p), `hero:${p.id}`)}>
          {strings.streaming.home.details}
        </Button>
      </>
    ),
  }));

  const film = (row: string) => (v: LibVideo) => {
    const id = `${row}:${v.id}`;
    return <VideoTile key={v.id} video={v} history={history} id={id} onClick={() => onOpen({ kind: 'video', id: v.id }, id)} />;
  };
  const show = (row: string) => (s: LibSeries) => {
    const id = `${row}:${s.id}`;
    return <SeriesTile key={s.id} series={s} history={history} id={id} onClick={() => onOpen({ kind: 'series', id: s.id }, id)} />;
  };

  return (
    <div className="mp-home">
      <HeroBanner items={items} index={hero} onIndexChange={onHero} autoAdvance={BANNER_EVERY} ariaLabel={strings.streaming.home.banner} />
      {home.continuing.length > 0 && (
        <MediaRow title={strings.streaming.home.continuing}>
          {home.continuing.map((p) => (
            <VideoTile
              key={p.id}
              shape="wide"
              video={{ ...p.video, poster: p.video.poster ?? p.series?.poster }}
              history={history}
              id={`continue:${p.id}`}
              title={nameOf(p)}
              subtitle={[p.series ? strings.videos.episodeShort(p.video.season, p.video.episode) : '', leftLabel(p.video, history)].filter(Boolean).join(' · ') || undefined}
              onClick={() => playback.playVideo(p.video)}
            />
          ))}
        </MediaRow>
      )}
      {home.newFilms.length > 0 && (
        <MediaRow title={strings.streaming.home.newFilms} onSeeAll={() => onSeeAll('movies', 'added')}>
          {home.newFilms.map(film('new-films'))}
        </MediaRow>
      )}
      {home.newSeries.length > 0 && (
        <MediaRow title={strings.streaming.home.newSeries} onSeeAll={() => onSeeAll('series', 'added')}>
          {home.newSeries.map(show('new-series'))}
        </MediaRow>
      )}
      {home.unwatched.length > 0 && (
        <MediaRow title={strings.streaming.home.unwatched}>
          {home.unwatched.map((p) => (p.series ? show('unwatched')(p.series) : film('unwatched')(p.video)))}
        </MediaRow>
      )}
      {home.genres.map(({ genre, films }) => (
        <MediaRow key={genre} title={genre}>
          {films.map(film(`genre-${genre}`))}
        </MediaRow>
      ))}
    </div>
  );
}
