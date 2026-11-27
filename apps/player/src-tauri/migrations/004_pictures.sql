-- Pictures taken out of the videos themselves, and what a series is as a whole (Plan 3, Steps 5 and 6).

-- Where a cached image came from: 'own' (art beside the files), 'frame' (taken out of the video), later 'tmdb' and
-- 'caa'. A frame gives way to art found later; Clear cache never throws 'own' away (only a rescan makes it again).
ALTER TABLE images ADD COLUMN origin TEXT NOT NULL DEFAULT 'own';

-- One frame of the video, small: an episode's picture (images.hash).
ALTER TABLE videos ADD COLUMN still TEXT;
-- A frame was asked of this file already (it gave one, or it can't): it is not asked again by itself.
ALTER TABLE videos ADD COLUMN frames_tried INTEGER NOT NULL DEFAULT 0;

-- A series as a whole, under the key its episodes are grouped by (parse::series_key). One row per source:
-- 'nfo' (tvshow.nfo in its folder), 'frame' (a backdrop taken from one of its episodes), later 'tmdb'.
CREATE TABLE shows (
  key TEXT NOT NULL,
  source TEXT NOT NULL,
  external_id TEXT,
  title TEXT,
  year INTEGER,
  overview TEXT,
  genres TEXT,
  rating REAL,
  poster TEXT,     -- images.hash
  backdrop TEXT,   -- images.hash
  language TEXT,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (key, source)
);
