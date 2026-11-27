import { useEffect, useMemo, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import {
  Button, IconCheck, IconFileVideo, IconMonitor, IconPlay, IconSearch, IconWarning, ListRow, Select, TextButton, TitleGrid, TitleHeader, TitleTile,
  formatDuration, formatTime, formatTimeLeft, type TitleTileShape,
} from '@pastel-studio/react';
import { strings } from '../strings';
import { tier } from './import/filters';
import { progressOf, resumePoint, useHistory, type Play } from './history';
import { usePoster, usePosters, wantFrames, type LibSeries, type LibVideo } from './library';
import { useMissing } from './missing';
import { usePlayback } from './playback';
import { isClip, leftOf, nextEpisode, seriesProgress, seriesState, videoName, videoState } from './streaming';

type History = ReadonlyMap<string, Play>;
/** What a tile passes on to its button: a row of Home gives it the tab stop. */
type TileRest = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'>;

/**
 * A film's or a series' title page: Back, then the design system's title header (a backdrop behind the poster, the
 * name and its facts, the synopsis, Play), then what it holds. The pictures and words come from the art and `.nfo`
 * beside the files; a title with no backdrop of its own gets a frame of its video.
 */
function TitlePage({ kind, title, facts, icon, poster, backdrop, overview, play, also, note, onBack, backLabel, children }: {
  kind: string;
  title: string;
  facts: string[];
  icon: ReactNode;
  /** Image hashes from the library's cache. */
  poster?: string | null;
  backdrop?: string | null;
  overview?: string | null;
  play: { label: string; icon?: ReactNode; onClick: () => void } | null;
  /** A second action beside Play ("Start over"). */
  also?: { label: string; onClick: () => void } | null;
  /** A line over the actions: the file can't be found. */
  note?: string;
  onBack: () => void;
  backLabel: string;
  children?: ReactNode;
}) {
  const [image, behind] = usePosters([poster, backdrop]);
  return (
    <div className="mp-page">
      <div>
        <TextButton onClick={onBack} autoFocus>
          {backLabel}
        </TextButton>
      </div>
      <TitleHeader
        overline={kind}
        title={title}
        facts={facts}
        summary={overview ?? undefined}
        poster={image}
        backdrop={behind}
        // With a backdrop and no poster, the picture is the backdrop: no empty poster beside the name.
        icon={behind ? undefined : icon}
        actions={
          play ? (
            <>
              <Button variant="primary" icon={play.icon ?? <IconPlay />} onClick={play.onClick}>
                {play.label}
              </Button>
              {also ? <Button onClick={also.onClick}>{also.label}</Button> : undefined}
            </>
          ) : undefined
        }
      >
        {note ? <p className="mp-title-note">{note}</p> : undefined}
      </TitleHeader>
      {children}
    </div>
  );
}

/** A video's length as its facts say it: seconds under a minute, otherwise hours and minutes. */
export const lengthOf = (v: LibVideo) => (v.duration ? (v.duration < 60 ? formatTime(v.duration) : formatDuration(v.duration)) : '');

/** A film's facts: year, length, genres, picture, file. */
function movieFacts(v: LibVideo): string[] {
  const lines = tier(v);
  return [v.year ? String(v.year) : '', lengthOf(v), (v.genres ?? []).join(', '), lines ? strings.review.lines(lines) : '', v.fileName].filter(Boolean);
}

/** What is left of a video that was started, as a tile or a row says it; empty when it was not. */
export function leftLabel(v: LibVideo, history: History): string {
  if (videoState(v, history) !== 'progress') return '';
  const left = leftOf(v, history);
  return left > 0 ? strings.videos.left(formatTimeLeft(left)) : '';
}

/**
 * A film, a clip or an episode as a tile: its poster (a frame for the `wide` shape), how far it was watched and the
 * mark of one watched to its end. `id` is the tile's own, which the focus returns to after its page closes.
 */
export function VideoTile({ video, history, id, shape = 'poster', title, subtitle, current = false, ...rest }: TileRest & {
  video: LibVideo;
  history: History;
  id?: string;
  shape?: TitleTileShape;
  title?: string;
  subtitle?: string;
  current?: boolean;
}) {
  // A film with no poster of its own shows the middle of its backdrop (a frame of the video) rather than nothing.
  const image = usePoster(shape === 'wide' ? (video.backdrop ?? video.still ?? video.poster) : (video.poster ?? video.backdrop ?? video.still));
  const play = history.get(video.path);
  return (
    <TitleTile
      shape={shape}
      title={title ?? videoName(video)}
      subtitle={subtitle ?? (video.year ? String(video.year) : undefined)}
      image={image}
      icon={<IconFileVideo size={32} />}
      progress={videoState(video, history) === 'progress' ? progressOf(play) : undefined}
      watched={play?.finished ?? false}
      current={current}
      unavailable={video.missing ? strings.missing.short : undefined}
      data-tile-id={id ?? video.id}
      {...rest}
    />
  );
}

/** A series as a tile: its poster, how much of it was watched, and the mark once every episode was. */
export function SeriesTile({ series, history, id, ...rest }: TileRest & { series: LibSeries; history: History; id?: string }) {
  const poster = usePoster(series.poster ?? series.backdrop);
  const state = seriesState(series, history);
  return (
    <TitleTile
      shape="poster"
      title={series.title || strings.videos.unknownSeries}
      subtitle={strings.videos.episodes(series.episodes.length)}
      image={poster}
      icon={<IconMonitor size={32} />}
      progress={state === 'progress' ? seriesProgress(series, history) : undefined}
      watched={state === 'watched'}
      unavailable={series.episodes.every((e) => e.missing) ? strings.missing.short : undefined}
      data-tile-id={id ?? series.id}
      {...rest}
    />
  );
}

/** Films or clips as a grid of posters; one opens on its title page. */
export function VideoGrid({ videos, history, label, onOpen }: { videos: LibVideo[]; history: History; label: string; onOpen: (video: LibVideo) => void }) {
  const playing = usePlayback().video?.id;
  return (
    <TitleGrid shape="poster" aria-label={label}>
      {videos.map((v) => (
        <VideoTile key={v.id} video={v} history={history} current={playing === v.id} onClick={() => onOpen(v)} />
      ))}
    </TitleGrid>
  );
}

/** Series as a grid of posters; one opens on its title page. */
export function SeriesGrid({ series, history, label, onOpen }: { series: LibSeries[]; history: History; label: string; onOpen: (series: LibSeries) => void }) {
  return (
    <TitleGrid shape="poster" aria-label={label}>
      {series.map((s) => (
        <SeriesTile key={s.id} series={s} history={history} onClick={() => onOpen(s)} />
      ))}
    </TitleGrid>
  );
}

/** A film's or a clip's title page. Left part-way, its Play picks up there, with Start over beside it. */
export function VideoTitle({ video, backLabel, onBack }: { video: LibVideo; backLabel: string; onBack: () => void }) {
  const playback = usePlayback();
  const history = useHistory();
  const missing = useMissing();
  const left = resumePoint(history.get(video.path));
  // No backdrop yet: one is made from the video, ahead of the rest of the library's.
  const { path, backdrop, missing: gone } = video;
  useEffect(() => {
    if (!backdrop && !gone) wantFrames([path]);
  }, [path, backdrop, gone]);
  return (
    <TitlePage
      kind={isClip(video) ? strings.videos.clip : strings.videos.film}
      title={videoName(video)}
      facts={movieFacts(video)}
      icon={<IconFileVideo size={48} />}
      poster={video.poster}
      backdrop={video.backdrop}
      overview={video.overview}
      play={
        video.missing
          ? { label: strings.missing.find, icon: <IconSearch />, onClick: () => missing.find({ path: video.path, name: videoName(video) }) }
          : { label: left > 0 ? strings.videos.resume(formatTime(left)) : strings.videos.play, onClick: () => playback.playVideo(video) }
      }
      also={!video.missing && left > 0 ? { label: strings.videos.startOver, onClick: () => playback.playVideo(video, { fromStart: true }) } : null}
      note={video.missing ? strings.missing.short : undefined}
      onBack={onBack}
      backLabel={backLabel}
    />
  );
}

/** Episodes with no season (most anime releases) are listed under this one. */
const NO_SEASON = -1;
const seasonOf = (e: LibVideo) => e.season ?? NO_SEASON;
const seasonName = (s: number) => strings.videos.season(s === NO_SEASON ? null : s);

/** A series' seasons in order. */
function seasonsOf(series: LibSeries): number[] {
  return [...new Set(series.episodes.map(seasonOf))].sort((a, b) => a - b);
}

/**
 * A series' title page: its seasons and episodes, each with what was watched of it. Once the series was started,
 * Play goes on with it (the episode left part-way, or the next one) and the page opens on that episode's season.
 */
export function SeriesTitle({ series, backLabel, onBack }: { series: LibSeries; backLabel: string; onBack: () => void }) {
  const playback = usePlayback();
  const history = useHistory();
  const missing = useMissing();
  const seasons = useMemo(() => seasonsOf(series), [series]);
  const started = seriesState(series, history) !== 'unwatched';
  const next = started ? nextEpisode(series, history) : null;
  // Specials (season 0) are listed but a series opens on its first real season, or on the one it goes on with.
  const [season, setSeason] = useState(() => (next ? seasonOf(next) : (seasons.find((s) => s > 0) ?? seasons[0] ?? NO_SEASON)));
  const episodes = series.episodes.filter((e) => seasonOf(e) === season);
  const first: LibVideo | undefined = next ?? episodes.find((e) => !e.missing);
  const resumes = !!first && resumePoint(history.get(first.path)) > 0;
  const realSeasons = seasons.filter((s) => s > 0).length;
  // The pictures the season shown lacks (and the series' backdrop) are made first, from the episodes themselves.
  const lacking = episodes.filter((e) => !e.still && !e.missing).map((e) => e.path).join('\n');
  const anyEpisode = episodes.find((e) => !e.missing)?.path ?? '';
  const { key: showKey, backdrop: showBackdrop } = series;
  useEffect(() => {
    const paths = lacking ? lacking.split('\n') : [];
    if (!showBackdrop && showKey && anyEpisode) wantFrames(paths.length > 0 ? paths : [anyEpisode], showKey);
    else wantFrames(paths);
  }, [lacking, anyEpisode, showKey, showBackdrop]);
  return (
    <TitlePage
      kind={strings.videos.series}
      title={series.title || strings.videos.unknownSeries}
      facts={[
        series.year ? String(series.year) : '',
        realSeasons > 1 ? strings.videos.seasons(realSeasons) : '',
        strings.videos.episodes(series.episodes.length),
        (series.genres ?? []).join(', '),
      ].filter(Boolean)}
      icon={<IconMonitor size={48} />}
      poster={series.poster}
      backdrop={series.backdrop}
      overview={series.overview}
      play={
        first
          ? { label: (resumes ? strings.videos.resumeFrom : strings.videos.playFrom)(first.season, first.episode), onClick: () => playback.playVideo(first) }
          : null
      }
      onBack={onBack}
      backLabel={backLabel}
    >
      <section className="mp-episodes-section" aria-label={seasonName(season)}>
        {seasons.length > 1 ? (
          <div className="mp-season-pick">
            <Select
              value={season}
              onChange={setSeason}
              options={seasons.map((s) => ({ value: s, label: seasonName(s) }))}
              ariaLabel={strings.videos.seasonLabel}
            />
          </div>
        ) : (
          <h3 className="mp-heading-sm">{seasonName(season)}</h3>
        )}
        <div role="list" className="mp-episodes">
          {episodes.map((e) => {
            const watched = videoState(e, history) === 'watched';
            return (
              <div role="listitem" key={e.id}>
                <ListRow
                  className={e.missing ? 'is-missing' : undefined}
                  icon={e.missing ? <IconWarning size={18} /> : watched ? <IconCheck size={18} /> : <IconPlay size={18} />}
                  title={strings.videos.episodeRow(e.episode, e.episodeTitle)}
                  description={[lengthOf(e), e.missing ? strings.missing.short : watched ? strings.videos.watched : leftLabel(e, history), e.fileName]
                    .filter(Boolean)
                    .join(' · ')}
                  aria-current={playback.video?.id === e.id ? 'true' : undefined}
                  onClick={() => (e.missing ? missing.find({ path: e.path, name: e.fileName }) : playback.playVideo(e))}
                />
              </div>
            );
          })}
        </div>
      </section>
    </TitlePage>
  );
}
