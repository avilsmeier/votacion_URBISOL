-- Permitir que un mismo residente figure en mas de una unidad/propiedad.
-- DNI y email dejan de ser unicos globales en el padron maestro.
-- Esto evita fallas cuando una persona registra varias propiedades.

DROP INDEX IF EXISTS public.resident_registry_dni_uidx;
DROP INDEX IF EXISTS public.resident_registry_email_uidx;

CREATE INDEX IF NOT EXISTS resident_registry_dni_idx
  ON public.resident_registry(lower(dni))
  WHERE dni IS NOT NULL AND dni <> '';

CREATE INDEX IF NOT EXISTS resident_registry_email_idx
  ON public.resident_registry(lower(email))
  WHERE email IS NOT NULL AND email <> '';

CREATE INDEX IF NOT EXISTS resident_registry_unit_dni_idx
  ON public.resident_registry(unit_id, lower(dni))
  WHERE dni IS NOT NULL AND dni <> '';

CREATE INDEX IF NOT EXISTS resident_registry_unit_email_idx
  ON public.resident_registry(unit_id, lower(email))
  WHERE email IS NOT NULL AND email <> '';
