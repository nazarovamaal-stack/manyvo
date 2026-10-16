PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('owner','participant')),
 age INTEGER, country TEXT, password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 csrf TEXT NOT NULL, expires_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS studies (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL DEFAULT '',
 question TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft'
 CHECK(status IN ('draft','moderating','open','closed')),
 version INTEGER NOT NULL DEFAULT 1, quota INTEGER, age_min INTEGER, age_max INTEGER,
 country TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, published_at REAL,
 deadline REAL, closed_at REAL, moderation_started REAL, moderation_reason TEXT NOT NULL DEFAULT '',
 moderation_provider TEXT, closure_reason TEXT
);
CREATE TABLE IF NOT EXISTS options (
 id TEXT PRIMARY KEY, study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
 position INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '', image TEXT,
 UNIQUE(study_id,position)
);
CREATE TABLE IF NOT EXISTS answers (
 id TEXT PRIMARY KEY, study_id TEXT NOT NULL REFERENCES studies(id),
 user_id TEXT NOT NULL REFERENCES users(id), personal_id TEXT NOT NULL REFERENCES options(id),
 prediction_id TEXT NOT NULL REFERENCES options(id), accepted_at REAL NOT NULL,
 UNIQUE(study_id,user_id)
);
CREATE TABLE IF NOT EXISTS ledger (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 study_id TEXT NOT NULL REFERENCES studies(id), kind TEXT NOT NULL CHECK(kind IN ('base','bonus')),
 amount INTEGER NOT NULL CHECK(amount=1), created_at REAL NOT NULL,
 UNIQUE(user_id,study_id,kind)
);
CREATE TABLE IF NOT EXISTS events (
 event_id TEXT PRIMARY KEY, type TEXT NOT NULL, study_id TEXT NOT NULL REFERENCES studies(id),
 participant_id TEXT, at REAL NOT NULL, fact_version INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS first_open ON events(study_id,participant_id) WHERE type='opened';
CREATE INDEX IF NOT EXISTS answer_study ON answers(study_id);
CREATE INDEX IF NOT EXISTS event_study_type ON events(study_id,type);
CREATE TABLE IF NOT EXISTS facts (
 study_id TEXT NOT NULL REFERENCES studies(id), version INTEGER NOT NULL,
 metric TEXT NOT NULL, unit TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
 is_rate INTEGER NOT NULL, values_json TEXT NOT NULL, created_at REAL NOT NULL,
 PRIMARY KEY(study_id,version)
);
