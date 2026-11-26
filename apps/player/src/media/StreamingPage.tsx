import { useEffect, useMemo, useRef, useState } from 'react';
import { Combobox, EmptyState, FilterChips, IconFileVideo, IconMonitor, SegmentedControl, type ComboboxOption } from '@pastel-studio/react';
import { strings } from '../strings';
import { useHistory } from './history';
import { AddButtons } from './LibraryFolders';
import { EMPTY_LIBRARY, type Library } from './library';
import { useRemembered } from './remember';
import { SortMenu } from './SortMenu';
import {
  SERIES_SORTS, STREAMING_SECTIONS, VIDEO_SORTS, WATCH_FILTERS, keep, searchStreaming, seriesState, shelve, sortSeries, sortVideos, suggestStreaming,
  videoState, type StreamingSection, type VideoSort, type Watch,
} from './streaming';
import { StreamingHome, type OpenTitle } from './StreamingHome';
import { SeriesGrid, SeriesTitle, VideoGrid, VideoTitle } from './VideoPages';

type Shelf = Exclude<StreamingSection, 'home'>;

const SECTIONS = STREAMING_SECTIONS.map((value) => ({ value, label: strings.streaming.views[value].label }));
const WATCH_OPTIONS = WATCH_FILTERS.map((value) => ({ value, label: strings.streaming.watch[value] }));
const DEFAULT_SORTS: Record<Shelf, VideoSort> = { movies: 'az', series: 'az', clips: 'az' };
/** Back, from a title's page: where it was opened. */
const BACK: Record<StreamingSection, string> = {
  home: strings.videos.backHome,
  movies: strings.videos.allMovies,
  series: strings.videos.allSeries,
  clips: strings.videos.allClips,
};

/** A title open on its own page, over the lists. */
type Opened = { kind: 'video' | 'series'; id: string };

/**
 * Streaming (D15): films, series and clips. Its sections are Home (a banner and rows of suggestions) and the three
 * shelves. Controls as on every media page (ux.md §6): the sections, a segmented control, above; the search, a
 * field across the page, with Add a folder / Add files as bare icons at its end; and on a shelf, what was watched
 * as chips with the sort, a quiet menu, at the end. The search looks through all three shelves: on Home it lists
 * what it finds of each, on a shelf it narrows that shelf.
 */
export function StreamingPage({ library }: { library: Library | null }) {
  const [section, setSection] = useState<StreamingSection>('home');
  const [query, setQuery] = useState('');
  const [watch, setWatch] = useState<Watch>('all');
  const [sorts, setSorts] = useRemembered<Record<Shelf, VideoSort>>('pastelmedia_streaming_sort', DEFAULT_SORTS, (v) => !!v && typeof v === 'object');
  const [opened, setOpened] = useState<Opened | null>(null);
  const [hero, setHero] = useState(0);
  const history = useHistory(library != null);
  const shelves = useMemo(() => shelve(library ?? EMPTY_LIBRARY), [library]);
  const found = useMemo(() => searchStreaming(shelves, query), [shelves, query]);

  const orders = section === 'series' ? SERIES_SORTS : VIDEO_SORTS;
  const sort = section !== 'home' && orders.includes(sorts[section]) ? sorts[section] : 'az';
  const films = useMemo(() => sortVideos(keep(found.films, watch, (v) => videoState(v, history)), sort, history), [found, watch, sort, history]);
  const clips = useMemo(() => sortVideos(keep(found.clips, watch, (v) => videoState(v, history)), sort, history), [found, watch, sort, history]);
  const series = useMemo(() => sortSeries(keep(found.series, watch, (s) => seriesState(s, history)), sort, history), [found, watch, sort, history]);

  const suggestions = useMemo<ComboboxOption[]>(
    () =>
      suggestStreaming(shelves, query).map((s) => ({
        id: `${s.kind}:${s.id}`,
        label: s.label || strings.videos.unknownSeries,
        detail: s.detail || undefined,
        group: strings.streaming.kinds[s.kind],
        icon: s.kind === 'series' ? <IconMonitor size={16} /> : <IconFileVideo size={16} />,
      })),
    [shelves, query],
  );

  // Closing a title's page puts the focus back on the tile that opened it, so a keyboard user keeps their place.
  const root = useRef<HTMLDivElement>(null);
  const returnTo = useRef<string | null>(null);
  const open: OpenTitle = (title, tileId) => {
    returnTo.current = tileId;
    setOpened(title);
  };
  useEffect(() => {
    if (opened !== null || returnTo.current === null) return;
    const id = returnTo.current;
    returnTo.current = null;
    root.current?.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(id)}"]`)?.focus();
  }, [opened]);

  const pick = (option: ComboboxOption) => {
    const at = option.id.indexOf(':');
    setQuery('');
    setOpened({ kind: option.id.slice(0, at) === 'series' ? 'series' : 'video', id: option.id.slice(at + 1) });
  };

  if (!library) return <EmptyState>{strings.library.reading}</EmptyState>;

  const close = () => setOpened(null);
  if (opened?.kind === 'video') {
    const video = library.movies.find((v) => v.id === opened.id);
    if (video) return <VideoTitle key={video.id} video={video} backLabel={BACK[section]} onBack={close} />;
  }
  if (opened?.kind === 'series') {
    const show = library.series.find((s) => s.id === opened.id);
    if (show) return <SeriesTitle key={show.id} series={show} backLabel={BACK[section]} onBack={close} />;
  }

  const searching = query.trim() !== '';
  const nothing = <EmptyState>{strings.streaming.nothingFound(query.trim())}</EmptyState>;
  const openVideo = (v: { id: string }) => open({ kind: 'video', id: v.id }, v.id);
  const openSeries = (s: { id: string }) => open({ kind: 'series', id: s.id }, s.id);
  const filmsGrid = <VideoGrid videos={films} history={history} label={strings.streaming.views.movies.label} onOpen={openVideo} />;
  const seriesGrid = <SeriesGrid series={series} history={history} label={strings.streaming.views.series.label} onOpen={openSeries} />;
  const clipsGrid = <VideoGrid videos={clips} history={history} label={strings.streaming.views.clips.label} onOpen={openVideo} />;

  let content;
  if (section === 'home' && library.movies.length === 0 && library.series.length === 0) {
    // A library with music only: Home says what will show here, like the shelves do.
    content = <EmptyState>{strings.streaming.views.home.empty}</EmptyState>;
  } else if (section === 'home' && !searching) {
    content = (
      <StreamingHome
        shelves={shelves}
        history={history}
        hero={hero}
        onHero={setHero}
        onOpen={open}
        onSeeAll={(to, order) => {
          setWatch('all');
          if (to !== 'home') setSorts({ ...sorts, [to]: order });
          setSection(to);
        }}
      />
    );
  } else if (section === 'home') {
    // A search on Home lists what it finds on each shelf.
    const parts = [
      { key: 'film', count: films.length, grid: filmsGrid },
      { key: 'series', count: series.length, grid: seriesGrid },
      { key: 'clip', count: clips.length, grid: clipsGrid },
    ] as const;
    content = parts.some((p) => p.count > 0)
      ? parts
          .filter((p) => p.count > 0)
          .map((p) => (
            <section key={p.key} className="mp-section" aria-label={strings.streaming.kinds[p.key]}>
              <h2 className="mp-heading-sm">{strings.streaming.kinds[p.key]}</h2>
              {p.grid}
            </section>
          ))
      : nothing;
  } else {
    const [all, count, grid] =
      section === 'movies' ? [shelves.films.length, films.length, filmsGrid] : section === 'series' ? [shelves.series.length, series.length, seriesGrid] : [shelves.clips.length, clips.length, clipsGrid];
    content = all === 0 ? <EmptyState>{strings.streaming.views[section].empty}</EmptyState> : count === 0 ? nothing : grid;
  }

  return (
    <div className="mp-streaming" ref={root}>
      <div className="mp-page-controls">
        <div className="mp-page-head">
          <SegmentedControl options={SECTIONS} value={section} onChange={setSection} ariaLabel={strings.streaming.viewsLabel} />
        </div>
        <div className="mp-page-head">
          <Combobox
            variant="search"
            className="mp-search"
            value={query}
            onChange={setQuery}
            suggestions={suggestions}
            onPick={pick}
            placeholder={strings.streaming.search}
          />
          <AddButtons preset="movies" icons />
        </div>
        {section !== 'home' && (
          <div className="mp-page-head">
            <FilterChips options={WATCH_OPTIONS} value={watch} onChange={setWatch} ariaLabel={strings.streaming.watchLabel} />
            <SortMenu orders={orders} labels={strings.streaming.sorts} value={sort} onChange={(order) => setSorts({ ...sorts, [section]: order })} />
          </div>
        )}
      </div>
      {content}
    </div>
  );
}
