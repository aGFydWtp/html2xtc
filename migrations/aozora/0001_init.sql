-- Aozora Bunko catalog sync schema.
--
-- Generation-based versioning: every synced row carries a `generation`
-- string, and only after a full generation is loaded and validated does
-- aozora_catalog_state.active_generation switch to it. The *_active views
-- read that pointer, so search callers never see a half-loaded generation.
-- IDs are kept as TEXT: the source CSV zero-pads work_id / person_id
-- (e.g. "000773"), and INTEGER storage would drop the leading zeros.

PRAGMA foreign_keys = ON;

CREATE TABLE aozora_catalog_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_generation TEXT,
  source_sha256 TEXT,
  source_etag TEXT,
  source_last_modified TEXT,
  last_success_at TEXT,
  active_book_count INTEGER NOT NULL DEFAULT 0,
  active_contributor_count INTEGER NOT NULL DEFAULT 0,
  lock_owner TEXT,
  lock_expires_at TEXT
);

INSERT INTO aozora_catalog_state (id)
VALUES (1)
ON CONFLICT(id) DO NOTHING;

CREATE TABLE aozora_catalog_sync_runs (
  run_id TEXT PRIMARY KEY,
  generation TEXT,
  status TEXT NOT NULL CHECK (
    status IN (
      'running',
      'unchanged',
      'completed',
      'failed',
      'skipped_locked'
    )
  ),
  source_url TEXT NOT NULL,
  source_sha256 TEXT,
  source_etag TEXT,
  source_last_modified TEXT,
  source_row_count INTEGER,
  book_count INTEGER,
  contributor_count INTEGER,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT
);

CREATE INDEX idx_aozora_sync_runs_started_at
ON aozora_catalog_sync_runs(started_at DESC);

CREATE TABLE aozora_books (
  generation TEXT NOT NULL,
  work_id TEXT NOT NULL,

  title TEXT NOT NULL,
  title_kana TEXT,
  title_sort TEXT,
  subtitle TEXT,
  subtitle_kana TEXT,
  original_title TEXT,
  first_appearance TEXT,
  ndc TEXT,
  orthography TEXT,
  copyrighted INTEGER NOT NULL DEFAULT 0,

  published_on TEXT,
  updated_on TEXT,
  card_url TEXT NOT NULL,

  inputter TEXT,
  proofreader TEXT,

  text_url TEXT,
  text_updated_on TEXT,
  text_encoding TEXT,

  html_url TEXT,
  html_updated_on TEXT,
  html_encoding TEXT,

  contributor_names TEXT NOT NULL DEFAULT '',
  contributor_names_kana TEXT NOT NULL DEFAULT '',

  title_normalized TEXT NOT NULL,
  title_kana_normalized TEXT NOT NULL DEFAULT '',
  contributor_names_normalized TEXT NOT NULL DEFAULT '',
  contributor_names_kana_normalized TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL,

  PRIMARY KEY (generation, work_id)
);

CREATE INDEX idx_aozora_books_generation_title
ON aozora_books(generation, title_normalized);

CREATE INDEX idx_aozora_books_generation_title_kana
ON aozora_books(generation, title_kana_normalized);

CREATE INDEX idx_aozora_books_generation_contributors
ON aozora_books(generation, contributor_names_normalized);

CREATE INDEX idx_aozora_books_generation_contributors_kana
ON aozora_books(generation, contributor_names_kana_normalized);

CREATE INDEX idx_aozora_books_generation_published
ON aozora_books(generation, published_on DESC);

CREATE INDEX idx_aozora_books_generation_ndc
ON aozora_books(generation, ndc);

CREATE TABLE aozora_book_contributors (
  generation TEXT NOT NULL,
  work_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  role TEXT NOT NULL,
  ordinal INTEGER NOT NULL,

  last_name TEXT,
  first_name TEXT,
  last_name_kana TEXT,
  first_name_kana TEXT,
  last_name_sort TEXT,
  first_name_sort TEXT,
  last_name_romaji TEXT,
  first_name_romaji TEXT,

  born_on TEXT,
  died_on TEXT,
  copyrighted INTEGER NOT NULL DEFAULT 0,

  display_name TEXT NOT NULL,
  display_name_kana TEXT NOT NULL DEFAULT '',
  name_normalized TEXT NOT NULL,
  name_kana_normalized TEXT NOT NULL DEFAULT '',

  PRIMARY KEY (generation, work_id, person_id, role),

  FOREIGN KEY (generation, work_id)
    REFERENCES aozora_books(generation, work_id)
    ON DELETE CASCADE
);

CREATE INDEX idx_aozora_contributors_generation_work
ON aozora_book_contributors(generation, work_id, ordinal);

CREATE INDEX idx_aozora_contributors_generation_name
ON aozora_book_contributors(generation, name_normalized);

CREATE INDEX idx_aozora_contributors_generation_name_kana
ON aozora_book_contributors(generation, name_kana_normalized);

CREATE INDEX idx_aozora_contributors_generation_role
ON aozora_book_contributors(generation, role);

CREATE VIEW aozora_books_active AS
SELECT b.*
FROM aozora_books AS b
WHERE b.generation = (
  SELECT active_generation
  FROM aozora_catalog_state
  WHERE id = 1
);

CREATE VIEW aozora_book_contributors_active AS
SELECT c.*
FROM aozora_book_contributors AS c
WHERE c.generation = (
  SELECT active_generation
  FROM aozora_catalog_state
  WHERE id = 1
);
