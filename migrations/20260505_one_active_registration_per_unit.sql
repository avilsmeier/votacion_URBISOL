-- Una unidad/propiedad solo puede tener una solicitud vigente por campaña.
-- Permite volver a registrar si la solicitud previa fue rechazada, pero impide
-- duplicados PENDING/APPROVED para la misma unidad en la misma campaña.
--
-- IMPORTANTE: si ya existen duplicados PENDING/APPROVED, este indice fallara.
-- Revisar antes con:
-- SELECT election_id, unit_id, COUNT(*)
-- FROM registrations
-- WHERE status IN ('PENDING','APPROVED')
-- GROUP BY election_id, unit_id
-- HAVING COUNT(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS registrations_one_open_per_unit_uidx
  ON public.registrations(election_id, unit_id)
  WHERE status IN ('PENDING','APPROVED');
