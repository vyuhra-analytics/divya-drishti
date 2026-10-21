-- Energy news archive written by drishti-core-stream after every feed poll (one row per story; every outlet that ran
-- the same headline in `copies`). Plain table, not a hypertable: a story's earliest time can move when an earlier
-- copy turns up, and volume is small (~1k stories/day).
CREATE TABLE IF NOT EXISTS news (
  id           TEXT        PRIMARY KEY,
  title        TEXT        NOT NULL,
  url          TEXT        NOT NULL,
  source       TEXT        NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  tags         TEXT[]      NOT NULL DEFAULT '{}',
  copies       JSONB,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS news_published_at ON news (published_at DESC);
CREATE INDEX IF NOT EXISTS news_tags ON news USING GIN (tags);
