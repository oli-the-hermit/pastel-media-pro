-- library.db, version 1 (Phase 3): the device library of architecture.md §4 (spike S6's tables) plus the import
-- tables (places, filters, jobs) and room for matched details, images and the person's corrections.
-- Rows are keyed by the file's row id; the fingerprint is a plain index used to re-link a moved file (S6).

CREATE TABLE places (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  kind_hint TEXT NOT NULL DEFAULT 'mixed',      -- music, video or mixed
  created_at INTEGER NOT NULL,
  last_scan_at INTEGER,
  tmdb_enabled INTEGER NOT NULL DEFAULT 0,      -- D13, Phase 5
  show_review INTEGER NOT NULL DEFAULT 1
);

-- The filters chosen in the review list, used again by every rescan. NULL means "any".
CREATE TABLE place_filters (
  place_id INTEGER PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
  preset TEXT NOT NULL,
  kinds TEXT,                                   -- "audio,video"
  min_duration_s INTEGER,
  max_duration_s INTEGER,
  min_bytes INTEGER,
  max_bytes INTEGER,
  min_height INTEGER,
  extensions TEXT,                              -- "mkv,mp4"; NULL for all
  name_rules TEXT                               -- "skip-extras"
);

-- Files the person unchecked in the review list: a rescan never brings them back.
CREATE TABLE skipped (
  path TEXT PRIMARY KEY,
  place_id INTEGER REFERENCES places(id) ON DELETE CASCADE
);

CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  place_id INTEGER REFERENCES places(id) ON DELETE CASCADE,  -- NULL for "Add files"
  fp TEXT,
  path TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  kind TEXT NOT NULL,                           -- audio or video
  added_at INTEGER NOT NULL,
  scanned_at INTEGER NOT NULL,
  missing INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX files_fp ON files(fp);
CREATE INDEX files_place ON files(place_id);
CREATE INDEX files_added ON files(added_at);

CREATE TABLE tracks (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album_artist TEXT NOT NULL,
  album TEXT NOT NULL,
  track_no INTEGER,
  disc_no INTEGER,
  year INTEGER,
  duration_ms INTEGER NOT NULL,
  problem TEXT                                  -- "no readable audio"
);
CREATE INDEX tracks_album ON tracks(album_artist, album);

CREATE TABLE videos (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  duration_ms INTEGER,
  width INTEGER,
  height INTEGER,
  kind TEXT NOT NULL,                           -- movie or episode (parse.rs)
  title TEXT NOT NULL,
  year INTEGER,
  season INTEGER,
  episode INTEGER,
  episode_title TEXT,
  show_folder TEXT,                             -- the show's folder above a season folder, when there is one
  poster TEXT,                                  -- images.hash (an episode may share its show's poster)
  backdrop TEXT
);

-- Matched details: source = nfo, sidecar, tags or filename (tmdb in Phase 5). One row per file and source.
CREATE TABLE metadata (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  external_id TEXT,                             -- "tmdb:603", "imdb:tt0133093"
  title TEXT,
  original_title TEXT,
  year INTEGER,
  overview TEXT,
  runtime_min INTEGER,
  genres TEXT,
  rating REAL,
  cast_json TEXT,
  language TEXT,
  fetched_at INTEGER NOT NULL,
  UNIQUE (file_id, source)
);

-- Posters, backdrops and covers, resized once into the app-data cache.
CREATE TABLE images (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                           -- poster, backdrop, logo, still, cover
  file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  metadata_id INTEGER REFERENCES metadata(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  w INTEGER NOT NULL,
  h INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX images_file ON images(file_id);

-- The person's corrections ("this is a series", Fix match): a rescan never undoes them.
CREATE TABLE overrides (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  kind TEXT,
  title TEXT,
  year INTEGER,
  season INTEGER,
  episode INTEGER,
  external_id TEXT
);

CREATE TABLE import_jobs (
  id INTEGER PRIMARY KEY,
  place_id INTEGER REFERENCES places(id) ON DELETE SET NULL,  -- NULL for "Add files"
  title TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  problems INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL                           -- queued, running, done, failed, cancelled
);

CREATE TABLE import_items (
  job_id INTEGER NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  state TEXT NOT NULL,                          -- waiting, done, failed
  problem TEXT
);
CREATE INDEX import_items_job ON import_items(job_id);
