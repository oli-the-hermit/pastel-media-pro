import { useMemo, useState, type ReactNode } from 'react';
import { Button, EmptyState, IconFileVideo, IconMonitor, IconPlay, ListRow, Select, TextButton } from '@pastel-studio/react';
import { MediaGrid, MediaTile } from '@pastel-media/media-ui';
import { strings } from '../strings';
import type { LibSeries, LibVideo, Library } from './library';
import { usePlayback } from './playback';

/**
 * A film's or a series' title page: the poster, the name and its facts, Play, then what it holds. An early form of
 * Phase 5's details page; artwork, synopsis and the rest come with metadata.
 */
function TitlePage({ kind, title, facts, icon, play, onBack, backLabel, children }: {
  kind: string;
  title: string;
  facts: string[];
  icon: ReactNode;
  play: { label: string; onClick: () => void } | null;
  onBack: () => void;
  backLabel: string;
  children?: ReactNode;
}) {
  return (
    <div className="mp-page">
      <div>
        <TextButton onClick={onBack}>{backLabel}</TextButton>
      </div>
      <header className="mp-title">
        <div className="mp-title-poster" aria-hidden="true">{icon}</div>
        <div className="mp-title-main">
          <span className="mp-title-kind">{kind}</span>
          <h2 className="mp-title-name">{title}</h2>
          {facts.length > 0 && (
            <p className="mp-title-facts">
              {facts.map((f) => (
                <span key={f}>{f}</span>
              ))}
            </p>
          )}
          {play && (
            <div>
              <Button variant="primary" icon={<IconPlay />} onClick={play.onClick}>
                {play.label}
              </Button>
            </div>
          )}
        </div>
      </header>
      {children}
    </div>
  );
}

/** Movies: every video the parser read as a film; a film opens on its title page. */
export function MoviesPage({ library }: { library: Library }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const playback = usePlayback();
  const open = library.movies.find((m) => m.id === openId);
  if (library.movies.length === 0) return <EmptyState>{strings.streaming.views.movies.empty}</EmptyState>;
  if (open) {
    return (
      <TitlePage
        kind={strings.videos.film}
        title={open.title || open.fileName}
        facts={[open.year ? String(open.year) : '', open.fileName].filter(Boolean)}
        icon={<IconFileVideo size={48} />}
        play={{ label: strings.videos.play, onClick: () => playback.playVideo(open) }}
        onBack={() => setOpenId(null)}
        backLabel={strings.videos.allMovies}
      />
    );
  }
  return (
    <div className="mp-page">
      <p className="mp-note">{strings.library.from(library.roots)}</p>
      <MediaGrid aria-label={strings.streaming.views.movies.label}>
        {library.movies.map((v) => (
          <div role="listitem" key={v.id}>
            <MediaTile
              shape="poster"
              title={v.title || v.fileName}
              subtitle={v.year ? String(v.year) : undefined}
              icon={<IconFileVideo size={32} />}
              current={playback.video?.id === v.id}
              onClick={() => setOpenId(v.id)}
            />
          </div>
        ))}
      </MediaGrid>
    </div>
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

function SeriesTitle({ series, onBack }: { series: LibSeries; onBack: () => void }) {
  const playback = usePlayback();
  const seasons = useMemo(() => seasonsOf(series), [series]);
  // Specials (season 0) are listed but a series opens on its first real season.
  const [season, setSeason] = useState(() => seasons.find((s) => s > 0) ?? seasons[0] ?? NO_SEASON);
  const episodes = series.episodes.filter((e) => seasonOf(e) === season);
  const first: LibVideo | undefined = episodes[0];
  const realSeasons = seasons.filter((s) => s > 0).length;
  return (
    <TitlePage
      kind={strings.videos.series}
      title={series.title || strings.videos.unknownSeries}
      facts={[realSeasons > 1 ? strings.videos.seasons(realSeasons) : '', strings.videos.episodes(series.episodes.length)].filter(Boolean)}
      icon={<IconMonitor size={48} />}
      play={first ? { label: strings.videos.playFrom(first.season, first.episode), onClick: () => playback.playVideo(first) } : null}
      onBack={onBack}
      backLabel={strings.videos.allSeries}
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
          {episodes.map((e) => (
            <div role="listitem" key={e.id}>
              <ListRow
                icon={<IconPlay size={18} />}
                title={strings.videos.episodeRow(e.episode, e.episodeTitle)}
                description={e.fileName}
                aria-current={playback.video?.id === e.id ? 'true' : undefined}
                onClick={() => playback.playVideo(e)}
              />
            </div>
          ))}
        </div>
      </section>
    </TitlePage>
  );
}

/** Series: the shows; a show opens on its title page, with its seasons and episodes. */
export function SeriesPage({ library }: { library: Library }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = library.series.find((s) => s.id === openId);
  if (library.series.length === 0) return <EmptyState>{strings.streaming.views.series.empty}</EmptyState>;
  if (open) return <SeriesTitle key={open.id} series={open} onBack={() => setOpenId(null)} />;
  return (
    <div className="mp-page">
      <p className="mp-note">{strings.library.from(library.roots)}</p>
      <MediaGrid aria-label={strings.streaming.views.series.label}>
        {library.series.map((s) => (
          <div role="listitem" key={s.id}>
            <MediaTile
              shape="poster"
              title={s.title || strings.videos.unknownSeries}
              subtitle={strings.videos.episodes(s.episodes.length)}
              icon={<IconMonitor size={32} />}
              onClick={() => setOpenId(s.id)}
            />
          </div>
        ))}
      </MediaGrid>
    </div>
  );
}
