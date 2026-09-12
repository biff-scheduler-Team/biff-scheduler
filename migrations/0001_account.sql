CREATE TABLE oauth_pending (
  cookie_hash TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_pending_expiry ON oauth_pending(expires_at);
CREATE TABLE app_session (
  token_hash TEXT PRIMARY KEY NOT NULL,
  subject TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  token_expires_at INTEGER NOT NULL,
  refresh_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX app_session_subject ON app_session(subject);
CREATE INDEX app_session_expiry ON app_session(expires_at);
CREATE TABLE festival_document (
  subject TEXT NOT NULL,
  edition TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  records TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(records)),
  last_operation TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(subject, edition)
);
