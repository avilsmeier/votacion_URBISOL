BEGIN;

-- 1) Campañas (elecciones)
CREATE TABLE IF NOT EXISTS elections (
  id              SERIAL PRIMARY KEY,
  title           TEXT NOT NULL,
  reg_open_at     TIMESTAMPTZ NOT NULL,
  reg_close_at    TIMESTAMPTZ NOT NULL,
  vote_open_at    TIMESTAMPTZ NOT NULL,
  vote_close_at   TIMESTAMPTZ NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at       TIMESTAMPTZ
);

-- Garantiza 1 sola activa
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE indexname = 'one_active_election'
  ) THEN
    CREATE UNIQUE INDEX one_active_election ON elections (is_active) WHERE is_active;
  END IF;
END$$;

-- 2) Normalización de unidades: street + number + unit_extra, y label consistente
ALTER TABLE units
  ADD COLUMN IF NOT EXISTS street TEXT,
  ADD COLUMN IF NOT EXISTS number TEXT,
  ADD COLUMN IF NOT EXISTS unit_extra TEXT;

-- Si tu units.label ya tiene datos, lo dejamos y empezamos a usar los nuevos campos para nuevas unidades.
-- Unicidad por street/number/unit_extra (para evitar duplicados)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'units_unique_address'
  ) THEN
    CREATE UNIQUE INDEX units_unique_address
      ON units (street, number, unit_extra)
      WHERE street IS NOT NULL AND number IS NOT NULL;
  END IF;
END$$;

-- 3) Relación de todo con election_id
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS election_id INTEGER REFERENCES elections(id);
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS election_id INTEGER REFERENCES elections(id);
ALTER TABLE vote_tokens ADD COLUMN IF NOT EXISTS election_id INTEGER REFERENCES elections(id);
ALTER TABLE votes ADD COLUMN IF NOT EXISTS election_id INTEGER REFERENCES elections(id);
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS election_id INTEGER REFERENCES elections(id);

-- 4) Crear primera elección basada en election_settings (si existe)
-- Si tu election_settings existe y tiene title/opens_at/closes_at, úsalo, si no, ponemos defaults.
DO $$
DECLARE
  s RECORD;
  new_eid INTEGER;
BEGIN
  SELECT * INTO s FROM election_settings WHERE id=1;
  IF NOT FOUND THEN
    INSERT INTO elections(title, reg_open_at, reg_close_at, vote_open_at, vote_close_at, is_active)
    VALUES (
      'Elección Concejo Directivo',
      NOW(), NOW() + INTERVAL '1 day',
      NOW() + INTERVAL '2 days', NOW() + INTERVAL '2 days 8 hours',
      TRUE
    )
    RETURNING id INTO new_eid;
  ELSE
    INSERT INTO elections(title, reg_open_at, reg_close_at, vote_open_at, vote_close_at, is_active)
    VALUES (
      COALESCE(s.title, 'Elección Concejo Directivo'),
      NOW(), NOW() + INTERVAL '1 day',
      COALESCE(s.opens_at, NOW() + INTERVAL '2 days'),
      COALESCE(s.closes_at, NOW() + INTERVAL '2 days 8 hours'),
      TRUE
    )
    RETURNING id INTO new_eid;
  END IF;

  -- Apunta datos existentes a esa primera elección
  UPDATE candidates SET election_id = new_eid WHERE election_id IS NULL;
  UPDATE registrations SET election_id = new_eid WHERE election_id IS NULL;
  UPDATE vote_tokens SET election_id = new_eid WHERE election_id IS NULL;
  UPDATE votes SET election_id = new_eid WHERE election_id IS NULL;
  UPDATE audit_log SET election_id = new_eid WHERE election_id IS NULL;

END$$;

-- 5) Email obligatorio (DB: no siempre conviene poner NOT NULL si ya hay data vieja)
-- Lo haremos obligatorio en la app/UI.

COMMIT;
