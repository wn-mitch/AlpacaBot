-- Cached BCP access token minted from the BCP_REFRESH_TOKEN secret; refreshed hourly.
CREATE TABLE bcp_auth (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Army list per entrant, readable with the signed-in BCP session.
ALTER TABLE bcp_roster ADD COLUMN list_id TEXT;
