-- The latest rendered /bcp circuit table per season, replaced when standings change.
CREATE TABLE bcp_circuit_images (
  season TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  png BLOB NOT NULL
);
