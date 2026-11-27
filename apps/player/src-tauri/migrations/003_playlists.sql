-- library.db, version 3: playlists, the lists of songs a person makes. A song is in a playlist once; taking a
-- file out of the library takes it out of its playlists too.

CREATE TABLE playlists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL                   -- renamed, or its songs changed
);

CREATE TABLE playlist_items (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,                    -- its place in the list, from 0; gaps are fine
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY (playlist_id, position),
  UNIQUE (playlist_id, file_id)
);
CREATE INDEX playlist_items_file ON playlist_items(file_id);
