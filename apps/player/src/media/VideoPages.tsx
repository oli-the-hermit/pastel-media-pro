import { useState } from 'react';
import { EmptyState, IconFileVideo, IconMonitor, TextButton } from '@pastel-studio/react';
import { MediaGrid, MediaTile } from '@pastel-media/media-ui';
import { strings } from '../strings';
import type { LibVideo, Library } from './library';
import { usePlayback } from './playback';

function VideoTiles({ videos, label, subtitle }: { videos: LibVideo[]; label: string; subtitle: (v: LibVideo) => string | undefined }) {
  const playback = usePlayback();
  return (
    <MediaGrid aria-label={label}>
      {videos.map((v) => (
        <div role="listitem" key={v.id}>
          <MediaTile
            shape="poster"
            title={v.title || v.fileName}
            subtitle={subtitle(v)}
            icon={<IconFileVideo size={32} />}
            current={playback.video?.id === v.id}
            onClick={() => playback.playVideo(v)}
          />
        </div>
      ))}
    </MediaGrid>
  );
}

/** Movies: every video the parser read as a film. */
export function MoviesPage({ library }: { library: Library }) {
  if (library.movies.length === 0) return <EmptyState>{strings.pages.movies.empty}</EmptyState>;
  return (
    <div className="mp-page">
      <p className="mp-note">{strings.library.testFolder(library.root)}</p>
      <VideoTiles videos={library.movies} label={strings.pages.movies.label} subtitle={(v) => (v.year ? String(v.year) : undefined)} />
    </div>
  );
}

/** Series: the shows, then a show's episodes in order. */
export function SeriesPage({ library }: { library: Library }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = library.series.find((s) => s.id === openId);
  if (library.series.length === 0) return <EmptyState>{strings.pages.series.empty}</EmptyState>;
  if (open) {
    return (
      <div className="mp-page">
        <div>
          <TextButton onClick={() => setOpenId(null)}>{strings.videos.allSeries}</TextButton>
        </div>
        <h2 className="mp-heading">{open.title}</h2>
        <VideoTiles videos={open.episodes} label={open.title} subtitle={(v) => strings.videos.episodeOf(v.season, v.episode) || v.fileName} />
      </div>
    );
  }
  return (
    <div className="mp-page">
      <p className="mp-note">{strings.library.testFolder(library.root)}</p>
      <MediaGrid aria-label={strings.pages.series.label}>
        {library.series.map((s) => (
          <div role="listitem" key={s.id}>
            <MediaTile shape="poster" title={s.title} subtitle={strings.videos.episodes(s.episodes.length)} icon={<IconMonitor size={32} />} onClick={() => setOpenId(s.id)} />
          </div>
        ))}
      </MediaGrid>
    </div>
  );
}
