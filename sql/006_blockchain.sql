BEGIN;

-- 1) Columnas para mini-blockchain en votos directiva
ALTER TABLE votes
  ADD COLUMN IF NOT EXISTS chain_position bigint,
  ADD COLUMN IF NOT EXISTS previous_hash text,
  ADD COLUMN IF NOT EXISTS vote_hash text;

-- 2) Columnas para mini-blockchain en votos fiscales
ALTER TABLE fiscal_votes
  ADD COLUMN IF NOT EXISTS chain_position bigint,
  ADD COLUMN IF NOT EXISTS previous_hash text,
  ADD COLUMN IF NOT EXISTS vote_hash text;

-- 3) Tabla de sellos por campaña (hash global publicado al cierre)
CREATE TABLE IF NOT EXISTS election_seals (
  id bigserial PRIMARY KEY,
  election_id integer NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  kind text NOT NULL, -- 'COUNCIL' o 'FISCAL'
  global_hash text NOT NULL,
  total_votes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_admin_id integer REFERENCES admin_users(id),
  meta_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (election_id, kind)
);

COMMIT;
