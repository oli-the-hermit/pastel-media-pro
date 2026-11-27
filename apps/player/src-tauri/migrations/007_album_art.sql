-- Album covers found online (Plan 3, Step 8), for albums that have none in their files or folder.
-- key: the album's artist and title, folded (musicbrainz::album_key); album ids change with the library.
-- state: 'found' (cover is an images.hash), 'none' (MusicBrainz has no such album, or no cover for it),
-- 'failed' (no answer: asked again another time).
CREATE TABLE album_art (
  key TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  mbid TEXT,
  cover TEXT,
  year INTEGER,
  tried_at INTEGER NOT NULL
);
