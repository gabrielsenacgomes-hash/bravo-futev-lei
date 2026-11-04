-- Execute once in the Supabase SQL Editor. Safe to run again: preserves data.
create table if not exists public.bravo_state (
  id integer primary key check (id = 1),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  revision bigint not null default 0 check (revision >= 0)
);

-- Students and phone numbers are accessible only through the Bravo server.
alter table public.bravo_state enable row level security;
revoke all on public.bravo_state from anon, authenticated;
grant select, update on public.bravo_state to service_role;

insert into public.bravo_state (id, payload, revision)
values (1, '{"students":[],"slots":[],"bookings":[],"studentAccounts":[],"reminders":{}}'::jsonb, 0)
on conflict (id) do nothing;
