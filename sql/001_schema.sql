-- 001_schema.sql
BEGIN;

CREATE TABLE IF NOT EXISTS units (
  id              SERIAL PRIMARY KEY,
  label           TEXT NOT NULL UNIQUE,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TYPE registration_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE IF NOT EXISTS registrations (
  id              SERIAL PRIMARY KEY,
  unit_id         INTEGER NOT NULL REFERENCES units(id),
  name            TEXT NOT NULL,
  dni             TEXT NOT NULL,
  phone           TEXT NOT NULL,
  email           TEXT,
  status          registration_status NOT NULL DEFAULT 'PENDING',
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     INTEGER
);

CREATE TYPE token_status AS ENUM ('ACTIVE', 'USED', 'REVOKED', 'EXPIRED');

CREATE TABLE IF NOT EXISTS vote_tokens (
  id              SERIAL PRIMARY KEY,
  registration_id INTEGER NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  unit_id         INTEGER NOT NULL REFERENCES units(id),
  token_hash      TEXT NOT NULL UNIQUE,
  status          token_status NOT NULL DEFAULT 'ACTIVE',
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at         TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  issued_via      TEXT NOT NULL DEFAULT 'COPY'
);

CREATE TABLE IF NOT EXISTS candidates (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  list_code       TEXT NOT NULL, -- ej: "Lista 1"
  sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS votes (
  id              SERIAL PRIMARY KEY,
  unit_id         INTEGER NOT NULL REFERENCES units(id),
  candidate_id    INTEGER NOT NULL REFERENCES candidates(id),
  token_id        INTEGER NOT NULL REFERENCES vote_tokens(id),
  cast_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip              TEXT,
  user_agent      TEXT,
  UNIQUE(unit_id) -- 1 voto por unidad (en digital)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id              BIGSERIAL PRIMARY KEY,
  event           TEXT NOT NULL,
  actor_admin_id  INTEGER,
  unit_id         INTEGER,
  registration_id INTEGER,
  token_id        INTEGER,
  meta_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_users (
  id              SERIAL PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'admin', -- admin | viewer
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS election_settings (
  id              INTEGER PRIMARY KEY DEFAULT 1,
  title           TEXT NOT NULL DEFAULT 'Elección Concejo Directivo',
  is_open         BOOLEAN NOT NULL DEFAULT FALSE,
  opens_at        TIMESTAMPTZ,
  closes_at       TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO election_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

COMMIT;
