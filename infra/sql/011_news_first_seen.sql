-- When WE first saw each story, set once on insert and never changed. `published_at` is the feed's own time (it can trail the wire and can move
-- when an earlier copy of the story turns up) and `updated_at` moves on every poll that touches the row, so neither says when a headline could first
-- have been acted on. A study of headline sentiment against returns needs exactly that time (see research/sentiment/PREREGISTRATION.md).
-- Rows archived before this column existed stay NULL: their first-seen time is unknown and is never guessed.
ALTER TABLE news ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS news_first_seen_at ON news (first_seen_at) WHERE first_seen_at IS NOT NULL;
