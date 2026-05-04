-- Admin UI + padron maestro de residentes
-- Ejecutar una vez en PostgreSQL: psql "$DATABASE_URL" -f migrations/20260504_admins_and_resident_registry.sql

ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS resident_registry (
  id serial PRIMARY KEY,
  unit_id integer NOT NULL REFERENCES units(id),
  name text NOT NULL,
  dni text,
  phone text,
  email text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','BLOCKED')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS resident_registry_unit_idx ON resident_registry(unit_id);
CREATE INDEX IF NOT EXISTS resident_registry_status_idx ON resident_registry(status);
CREATE UNIQUE INDEX IF NOT EXISTS resident_registry_dni_uidx ON resident_registry(lower(dni)) WHERE dni IS NOT NULL AND dni <> '';
CREATE UNIQUE INDEX IF NOT EXISTS resident_registry_email_uidx ON resident_registry(lower(email)) WHERE email IS NOT NULL AND email <> '';
CREATE INDEX IF NOT EXISTS resident_registry_phone_idx ON resident_registry(phone) WHERE phone IS NOT NULL AND phone <> '';
