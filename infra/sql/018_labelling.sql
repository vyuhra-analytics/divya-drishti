-- A hand-labelled gold set of crude headlines (research/sentiment/LABELLING.md): headlines sampled with a fixed seed, and one label per labeler. The gold labels
-- never use prices, so they can score any tone source (word list, FinBERT, an LLM prompt) without leaking the outcome the study measures.
CREATE TABLE IF NOT EXISTS gold_sample (
  id           SERIAL PRIMARY KEY,
  source       TEXT NOT NULL,                -- news (the app's archive) | gdelt
  ref          TEXT NOT NULL,                -- the id or key in that table
  title        TEXT NOT NULL,
  outlet       TEXT NOT NULL DEFAULT '',
  published_at TIMESTAMPTZ,
  stratum      TEXT NOT NULL DEFAULT '',     -- how it was drawn (the lexicon's sign), for the record only: never shown to a labeler
  UNIQUE (source, ref)
);

CREATE TABLE IF NOT EXISTS headline_labels (
  sample_id  INT NOT NULL REFERENCES gold_sample (id) ON DELETE CASCADE,
  labeler    TEXT NOT NULL,                  -- owner | claude | model names
  label      TEXT NOT NULL CHECK (label IN ('bullish', 'bearish', 'neutral', 'not_crude')),
  after_move BOOLEAN NOT NULL DEFAULT false, -- the headline only reports a price move that already happened
  note       TEXT,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sample_id, labeler)
);
