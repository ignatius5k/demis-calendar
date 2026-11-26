create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron;
create extension if not exists pg_net;

create schema demi;
revoke all on schema demi from public, anon, authenticated;

create table demi.settings (
  id boolean primary key default true check (id),
  host_key_hash text,
  length_minutes integer not null default 60 check (length_minutes in (30, 45, 60, 90)),
  weekly jsonb not null default '[null,null,null,null,null,null,null]',
  connection jsonb,
  vapid_public_key text,
  closed_slots jsonb not null default '[]',
  check_lease_until timestamptz
);

insert into demi.settings default values;

create table demi.events (
  id uuid primary key,
  kind text not null check (kind in ('booking', 'block')),
  state text not null default 'pending' check (state in ('pending', 'confirmed', 'canceling', 'canceled')),
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  calendar_url text not null,
  name text not null default '',
  email text not null default '',
  note text not null default '',
  created_at timestamptz not null default now(),
  sync_lease_until timestamptz,
  exclude using gist (tstzrange(starts_at, ends_at, '[)') with &&) where (state <> 'canceled')
);
create index events_upcoming_idx on demi.events (ends_at, starts_at) where state <> 'canceled';

create table demi.activity (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  push_body text not null,
  created_at timestamptz not null default now(),
  pushed boolean not null default false
);
create index activity_recent_idx on demi.activity (created_at desc);

create table demi.subscriptions (
  endpoint text primary key,
  subscription jsonb not null,
  created_at timestamptz not null default now()
);

alter table demi.settings enable row level security;
alter table demi.events enable row level security;
alter table demi.activity enable row level security;
alter table demi.subscriptions enable row level security;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'demi_cron_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'demi_cron_key');
  end if;
end;
$$;
