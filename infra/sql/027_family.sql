-- Family accounts: the household's own broker statements (see docs/redesign/FAMILY_ACCOUNTS.md). A record-keeper only: no credentials, no full account
-- numbers (an account keeps a nickname and the broker's client id, which identifies it and is not a credential), and the uploaded files themselves are not
-- kept, only what was read from them. A file finds its account by client id; if none exists yet one is created under an "Unassigned" member to be named later.
CREATE TABLE IF NOT EXISTS family_members (
  id         SERIAL      PRIMARY KEY,
  nickname   TEXT        NOT NULL UNIQUE,
  relation   TEXT        NOT NULL DEFAULT '',
  hidden     BOOLEAN     NOT NULL DEFAULT false,
  note       TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS family_accounts (
  id         SERIAL      PRIMARY KEY,
  member_id  INTEGER     NOT NULL REFERENCES family_members (id) ON DELETE RESTRICT,
  broker     TEXT        NOT NULL CHECK (broker IN ('zerodha', 'kotak', 'other')),
  label      TEXT        NOT NULL,
  client_code TEXT       NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (member_id, label)
);
CREATE UNIQUE INDEX IF NOT EXISTS family_accounts_client ON family_accounts (broker, client_code) WHERE client_code <> '';

-- One row per uploaded statement or tradebook; `payload` is the parsed content (lines, charges, summary, or fills) exactly as read. The same file twice
-- (same hash) is refused by the unique key; an overlapping period of the same kind and segment is refused by the service.
CREATE TABLE IF NOT EXISTS family_imports (
  id          SERIAL      PRIMARY KEY,
  account_id  INTEGER     NOT NULL REFERENCES family_accounts (id) ON DELETE RESTRICT,
  kind        TEXT        NOT NULL CHECK (kind IN ('pnl', 'tradebook')),
  segment     TEXT        NOT NULL CHECK (segment IN ('fno', 'equity', 'currency', 'commodity')),
  period_from DATE        NOT NULL,
  period_to   DATE        NOT NULL,
  file_name   TEXT        NOT NULL,
  file_hash   TEXT        NOT NULL,
  payload     JSONB       NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, file_hash),
  CHECK (period_from <= period_to)
);
CREATE INDEX IF NOT EXISTS family_imports_account ON family_imports (account_id, kind, segment);
