-- What the app itself has to know of a person's choices before any page is open (the pages keep theirs in the
-- window): the image cache's size limit.
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
