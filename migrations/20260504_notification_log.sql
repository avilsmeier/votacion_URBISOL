-- Log de notificaciones transaccionales
-- Ejecutar como owner/superusuario en la base de la app.

CREATE TABLE IF NOT EXISTS public.notification_log (
  id bigserial PRIMARY KEY,
  election_id integer REFERENCES public.elections(id) ON DELETE SET NULL,
  registration_id integer REFERENCES public.registrations(id) ON DELETE SET NULL,
  admin_user_id integer REFERENCES public.admin_users(id) ON DELETE SET NULL,
  channel text NOT NULL DEFAULT 'EMAIL',
  template text NOT NULL,
  recipient text NOT NULL,
  status text NOT NULL CHECK (status IN ('SENT','FAILED','SKIPPED')),
  error text,
  meta_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_log_election_idx ON public.notification_log(election_id);
CREATE INDEX IF NOT EXISTS notification_log_registration_idx ON public.notification_log(registration_id);
CREATE INDEX IF NOT EXISTS notification_log_admin_user_idx ON public.notification_log(admin_user_id);
CREATE INDEX IF NOT EXISTS notification_log_created_idx ON public.notification_log(created_at DESC);
