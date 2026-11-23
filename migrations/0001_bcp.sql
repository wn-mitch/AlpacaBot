-- BCP events tracked from the SCD Discord calendar or /bcp track.
CREATE TABLE bcp_events (
  bcp_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'live', 'final'))
);

-- Entrants per event, refreshed from BCP; used for /bcp claim autocomplete and /bcp events.
CREATE TABLE bcp_roster (
  event_id TEXT NOT NULL REFERENCES bcp_events (bcp_id),
  bcp_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (event_id, bcp_user_id)
);

-- One BCP identity per Discord member and one member per BCP identity.
CREATE TABLE bcp_claims (
  discord_user_id TEXT PRIMARY KEY,
  bcp_user_id TEXT NOT NULL UNIQUE,
  bcp_name TEXT NOT NULL,
  claimed_at TEXT NOT NULL
);

-- Final placings for every entrant, so members who claim later still earn circuit points.
CREATE TABLE bcp_results (
  event_id TEXT NOT NULL REFERENCES bcp_events (bcp_id),
  bcp_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  faction TEXT,
  placing INTEGER NOT NULL,
  record TEXT NOT NULL,
  points REAL NOT NULL,
  season TEXT NOT NULL,
  PRIMARY KEY (event_id, bcp_user_id)
);

-- Claimed before sending so overlapping cron runs post each message once.
CREATE TABLE bcp_posts (
  post_key TEXT PRIMARY KEY,
  posted_at TEXT NOT NULL
);
