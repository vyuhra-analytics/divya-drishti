-- Server-side paper trading (simulated, never a broker): accounts, open positions, the trade journal and an audit log of every write.
-- Driven by the stream service so a paper trade placed in the browser or by an agent over MCP is the same account everywhere.
CREATE TABLE IF NOT EXISTS paper_accounts (
  id         TEXT             PRIMARY KEY,
  capital    DOUBLE PRECISION NOT NULL,
  slippage   DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS paper_positions (
  id        TEXT        PRIMARY KEY,
  account   TEXT        NOT NULL REFERENCES paper_accounts (id) ON DELETE CASCADE,
  data      JSONB       NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS paper_positions_account ON paper_positions (account);
CREATE TABLE IF NOT EXISTS paper_trades (
  id        TEXT        PRIMARY KEY,
  account   TEXT        NOT NULL REFERENCES paper_accounts (id) ON DELETE CASCADE,
  data      JSONB       NOT NULL,
  closed_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS paper_trades_account_closed ON paper_trades (account, closed_at DESC);
CREATE TABLE IF NOT EXISTS paper_audit (
  id      BIGSERIAL   PRIMARY KEY,
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor   TEXT        NOT NULL,
  action  TEXT        NOT NULL,
  account TEXT        NOT NULL,
  args    JSONB,
  ok      BOOLEAN     NOT NULL,
  detail  TEXT        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS paper_audit_orders ON paper_audit (account, actor, action, at DESC);
INSERT INTO paper_accounts (id, capital, slippage) VALUES ('main', 500000, 1) ON CONFLICT DO NOTHING;
