-- A member can link several BCP accounts (people re-register under new ones);
-- each BCP account still belongs to at most one member.
CREATE TABLE bcp_claims_new (
  discord_user_id TEXT NOT NULL,
  bcp_user_id TEXT PRIMARY KEY,
  bcp_name TEXT NOT NULL,
  claimed_at TEXT NOT NULL
);
INSERT INTO bcp_claims_new SELECT discord_user_id, bcp_user_id, bcp_name, claimed_at FROM bcp_claims;
DROP TABLE bcp_claims;
ALTER TABLE bcp_claims_new RENAME TO bcp_claims;
CREATE INDEX bcp_claims_member ON bcp_claims (discord_user_id);
