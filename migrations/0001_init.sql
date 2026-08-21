CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  kind TEXT NOT NULL CHECK (kind IN ('qa','cloze')),
  question TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  retired INTEGER NOT NULL DEFAULT 0,
  flag_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  due TEXT NOT NULL,
  stability REAL NOT NULL DEFAULT 0,
  difficulty REAL NOT NULL DEFAULT 0,
  elapsed_days REAL NOT NULL DEFAULT 0,
  scheduled_days REAL NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  state INTEGER NOT NULL DEFAULT 0,
  last_review TEXT
);
CREATE INDEX idx_prompts_due ON prompts (retired, due);
CREATE INDEX idx_prompts_source ON prompts (source_id, position);

CREATE TABLE captures (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  text TEXT NOT NULL,
  url TEXT,
  title TEXT,
  note TEXT,
  image_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','consumed'))
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('remembered','forgot','skip','flag','retire')),
  elapsed_days REAL,
  state_after TEXT
);
CREATE INDEX idx_events_prompt ON events (prompt_id, ts);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES
  ('session_cap', '20'),
  ('desired_retention', '0.9'),
  ('email_hour', '7'),
  ('timezone', 'America/Los_Angeles'),
  ('cadence', '{"unanswered":0,"mode":"daily","last_sent":null}');
