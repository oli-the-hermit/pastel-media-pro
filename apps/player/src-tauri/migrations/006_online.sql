-- What was asked online (Plan 3, Step 7), so nothing is asked twice and a person's own choice is never undone.
-- kind 'movie' (key = the file's id) or 'show' (key = the series' key, parse::series_key).
-- state: 'matched' (found by itself), 'none' (nothing plain enough was found), 'failed' (no answer: tried again
-- later), 'chosen' (the person picked this title), 'removed' (the person said it has no match: never asked again).
CREATE TABLE lookups (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  state TEXT NOT NULL,
  external_id TEXT,          -- "tmdb:603"
  tried_at INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
);
