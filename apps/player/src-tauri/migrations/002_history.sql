-- library.db, version 2: what was played, how far and when. One row per file, updated as it plays.
-- It feeds Continue watching, Recently played, the watched marks, and picking a film up where it was left.

CREATE TABLE plays (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  position_ms INTEGER NOT NULL DEFAULT 0,       -- where it was left
  duration_ms INTEGER NOT NULL DEFAULT 0,       -- as the engine reported it; 0 when it never did
  finished INTEGER NOT NULL DEFAULT 0,          -- played to the end, or near enough (history.rs FINISHED_AT)
  play_count INTEGER NOT NULL DEFAULT 0,        -- times it was started
  last_played_at INTEGER NOT NULL
);
CREATE INDEX plays_last ON plays(last_played_at);
