-- Ejecutar una sola vez en el mismo proyecto Supabase de SynthesisOne.
-- El bucket privado 'whatsapp-sessions' se crea automáticamente por el bot
-- mediante la API de Storage usando la clave secreta del servidor.

create table if not exists public.whatsapp_webhook_events (
  event_id text primary key,
  received_at timestamptz not null default now(),
  transaction_id text,
  amount numeric,
  currency text,
  direction text,
  recipient text,
  status text not null default 'PROCESSING',
  attempts integer not null default 1,
  error text,
  message_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists whatsapp_webhook_events_created_idx on public.whatsapp_webhook_events (created_at desc);
create index if not exists whatsapp_webhook_events_status_idx on public.whatsapp_webhook_events (status, updated_at desc);
create index if not exists whatsapp_webhook_events_tx_idx on public.whatsapp_webhook_events (transaction_id) where transaction_id is not null;
