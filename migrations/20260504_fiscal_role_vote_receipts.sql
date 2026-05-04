-- Rol FISCAL + recibos verificables de voto
-- Ejecutar como owner/superusuario en la base de la app.

CREATE TABLE IF NOT EXISTS public.vote_receipts (
  id bigserial PRIMARY KEY,
  election_id integer NOT NULL REFERENCES public.elections(id) ON DELETE CASCADE,
  registration_id integer NOT NULL REFERENCES public.registrations(id) ON DELETE CASCADE,
  unit_id integer NOT NULL REFERENCES public.units(id),
  vote_kind text NOT NULL CHECK (vote_kind IN ('REFERENDUM','COUNCIL','FISCAL')),
  vote_table text NOT NULL CHECK (vote_table IN ('referendum_votes','votes','fiscal_votes')),
  vote_id integer NOT NULL,
  vote_hash text NOT NULL,
  receipt_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vote_table, vote_id)
);

CREATE INDEX IF NOT EXISTS vote_receipts_election_idx ON public.vote_receipts(election_id);
CREATE INDEX IF NOT EXISTS vote_receipts_registration_idx ON public.vote_receipts(registration_id);
CREATE INDEX IF NOT EXISTS vote_receipts_unit_idx ON public.vote_receipts(unit_id);
CREATE INDEX IF NOT EXISTS vote_receipts_kind_idx ON public.vote_receipts(vote_kind);

-- Nota: admin_users.role queda como text en el esquema actual.
-- Valores operativos esperados desde la app: admin, fiscal, viewer.
