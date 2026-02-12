BEGIN;

-- Detalle de integrantes de lista de CONCEJO (presi/vice/secre/teso + personero opcional)
CREATE TABLE IF NOT EXISTS slate_members (
  id           SERIAL PRIMARY KEY,
  election_id  INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  slate_id     INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE, -- candidate = “lista”
  role         TEXT NOT NULL, -- Presidente, Vicepresidente, Secretario, Tesorero, Personero
  full_name    TEXT NOT NULL,
  dni_ce       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PDF/plan de trabajo opcional por lista (URL o ruta local)
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS plan_pdf_url TEXT;

-- Fiscal titular y suplente (por “lista fiscal”)
CREATE TABLE IF NOT EXISTS fiscal_lists (
  id           SERIAL PRIMARY KEY,
  election_id  INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,      -- “Lista Fiscal 1”
  code         TEXT NOT NULL,      -- FISCAL_1, FISCAL_2
  titular_name TEXT NOT NULL,
  titular_dni  TEXT,
  suplente_name TEXT NOT NULL,
  suplente_dni  TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  UNIQUE(election_id, code)
);

CREATE TABLE IF NOT EXISTS fiscal_votes (
  id          SERIAL PRIMARY KEY,
  election_id INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  unit_id     INTEGER NOT NULL REFERENCES units(id),
  fiscal_list_id INTEGER NOT NULL REFERENCES fiscal_lists(id),
  token_id    INTEGER NOT NULL REFERENCES vote_tokens(id),
  cast_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip          TEXT,
  user_agent  TEXT,
  UNIQUE(election_id, unit_id) -- 1 voto fiscal por unidad por elección
);

COMMIT;
