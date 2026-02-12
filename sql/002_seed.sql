-- 002_seed.sql
BEGIN;

-- Candidatos (2 listas)
INSERT INTO candidates (name, list_code, sort_order)
VALUES
  ('Lista 1', 'LISTA_1', 1),
  ('Lista 2', 'LISTA_2', 2)
ON CONFLICT DO NOTHING;

-- Unidades (EJEMPLO): reemplaza por tu listado real
-- Tip: usa un label humano, tal cual lo entienden los vecinos.
-- Calle 1 Casa 01 ... Calle 3 Casa 40, Edif A Dpto 101...
INSERT INTO units (label)
VALUES
  ('Calle 1 Casa 01'),
  ('Calle 1 Casa 02'),
  ('Calle 2 Casa 01'),
  ('Edif A Dpto 101')
ON CONFLICT DO NOTHING;

COMMIT;
