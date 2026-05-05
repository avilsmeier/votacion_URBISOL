-- Blindaje: una unidad/propiedad solo puede emitir un voto por campaña.
-- Aplicar despues de limpiar votos duplicados de pruebas, si existieran.

CREATE UNIQUE INDEX IF NOT EXISTS referendum_votes_one_per_unit_uidx
  ON public.referendum_votes(election_id, unit_id);

CREATE UNIQUE INDEX IF NOT EXISTS votes_one_per_unit_uidx
  ON public.votes(election_id, unit_id);

CREATE UNIQUE INDEX IF NOT EXISTS fiscal_votes_one_per_unit_uidx
  ON public.fiscal_votes(election_id, unit_id);
