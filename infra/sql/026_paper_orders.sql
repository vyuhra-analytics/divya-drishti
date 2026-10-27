-- Paper limit orders waiting for their price (simulated, never a broker): the stream fills them when a live quote reaches the limit, or cancels them
-- after 24 hours. One row per waiting order, the order as JSON, removed when it fills or is cancelled.
CREATE TABLE IF NOT EXISTS paper_orders (
  id         TEXT        PRIMARY KEY,
  account    TEXT        NOT NULL REFERENCES paper_accounts (id) ON DELETE CASCADE,
  data       JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS paper_orders_account ON paper_orders (account);
