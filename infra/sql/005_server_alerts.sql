-- Alerts that fire without the browser open (evaluated by the stream service, delivered to Telegram or a webhook), and a small key-value table
-- (the Telegram chat id discovered when you link the bot).
CREATE TABLE IF NOT EXISTS server_alerts (
  id         TEXT        PRIMARY KEY,
  alert      JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
