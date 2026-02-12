BEGIN;

-- Plan PDF local por lista (Directiva)
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS plan_pdf_path TEXT;

-- Miembros por lista de Directiva (roles fijos + personero opcional)
CREATE TABLE IF NOT EXISTS slate_members (
  id           SERIAL PRIMARY KEY,
  election_id  INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  slate_id     INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,  -- Presidente, Vicepresidente, Secretario, Tesorero, Personero
  full_name    TEXT NOT NULL,
  dni_ce       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Listas de Fiscales (N), sin personeros
CREATE TABLE IF NOT EXISTS fiscal_lists (
  id            SERIAL PRIMARY KEY,
  election_id   INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  titular_name  TEXT NOT NULL,
  titular_dni   TEXT,
  suplente_name TEXT NOT NULL,
  suplente_dni  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Voto fiscal: 1 por unidad por elección
CREATE TABLE IF NOT EXISTS fiscal_votes (
  id            SERIAL PRIMARY KEY,
  election_id   INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  unit_id       INTEGER NOT NULL REFERENCES units(id),
  fiscal_list_id INTEGER NOT NULL REFERENCES fiscal_lists(id),
  token_id      INTEGER NOT NULL REFERENCES vote_tokens(id),
  cast_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip            TEXT,
  user_agent    TEXT,
  UNIQUE(election_id, unit_id)
);

COMMIT;
