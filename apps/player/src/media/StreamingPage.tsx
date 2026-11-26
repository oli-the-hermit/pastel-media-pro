import { useState } from 'react';
import { EmptyState, SegmentedControl } from '@pastel-studio/react';
import { strings } from '../strings';
import { AddButtons } from './LibraryFolders';
import type { Library } from './library';
import { MoviesPage, SeriesPage } from './VideoPages';

type View = keyof typeof strings.streaming.views;

const VIEWS = (Object.keys(strings.streaming.views) as View[]).map((value) => ({ value, label: strings.streaming.views[value].label }));

/**
 * Streaming (D15): films, series and clips. Home, with its banner and rows, and Clips come in Phase 5; Movies and
 * Series show the test library meanwhile.
 */
export function StreamingPage({ library }: { library: Library | null }) {
  const [view, setView] = useState<View>('home');
  let content;
  if (!library) content = <EmptyState>{strings.library.reading}</EmptyState>;
  else if (view === 'movies') content = <MoviesPage library={library} />;
  else if (view === 'series') content = <SeriesPage library={library} />;
  else content = <EmptyState>{strings.streaming.views[view].empty}</EmptyState>;
  return (
    <div className="mp-streaming">
      <div className="mp-page-head">
        <SegmentedControl options={VIEWS} value={view} onChange={setView} ariaLabel={strings.streaming.viewsLabel} />
        <AddButtons preset="movies" />
      </div>
      {content}
    </div>
  );
}
