-- HYROX Race Tracker schema
-- Paste this whole file into Supabase Dashboard -> SQL Editor -> Run.

create table if not exists athletes (
  id text primary key,                -- 'andrea' | 'paul' (public display name: Paw)
  name text not null,
  emoji text not null default '🏃',
  color text not null default '#e63946',
  sheet_csv_url text                  -- published/export CSV url of their Google Sheet
);

create table if not exists workouts (
  id text primary key,                -- stable sheet row key, usually athlete_id + ':' + planned date
  athlete_id text not null references athletes(id),
  date date not null,
  planned text,
  result_raw text,
  notes text,
  rpe numeric,
  status text not null default 'pending',  -- completed | skipped | rest | pending
  km numeric not null default 0,
  kg_volume numeric not null default 0,
  points numeric not null default 0,
  parsed_by text,                     -- 'structured' | 'claude' | 'regex'
  updated_at timestamptz not null default now()
);

create table if not exists race_state (
  athlete_id text primary key references athletes(id),
  total_points numeric not null default 0,
  week_points numeric not null default 0,
  streak int not null default 0,
  total_km numeric not null default 0,
  total_kg numeric not null default 0,
  sessions_completed int not null default 0,
  sessions_skipped int not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists trophies (
  id text primary key,                -- e.g. 'weekly:2026-W28' or 'monthly:2026-07' or 'badge:100km:andrea'
  athlete_id text not null references athletes(id),
  kind text not null,                 -- weekly | monthly | badge
  label text not null,
  emoji text not null default '🏅',
  period text,
  awarded_at timestamptz not null default now()
);

create table if not exists sync_log (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  detail text
);

-- Read-only for the public site: enable RLS, allow SELECT to everyone,
-- and define NO insert/update/delete policies. Writes happen only through
-- the service-role key in the sync job (service role bypasses RLS).
alter table athletes  enable row level security;
alter table workouts  enable row level security;
alter table race_state enable row level security;
alter table trophies  enable row level security;
alter table sync_log  enable row level security;

create policy "public read athletes"  on athletes  for select using (true);
create policy "public read workouts"  on workouts  for select using (true);
create policy "public read race"      on race_state for select using (true);
create policy "public read trophies"  on trophies  for select using (true);
create policy "public read synclog"   on sync_log  for select using (true);

-- Seed the two racers (Paw's sheet URL to be filled in when he shares it)
insert into athletes (id, name, emoji, color, sheet_csv_url) values
  ('andrea', 'Andrea', '🏃‍♂️', '#e63946',
   'https://docs.google.com/spreadsheets/d/1fe20xccu1RAWGCQ6lgfTJr5MAm_vQ-U39kfZuxr6IaY/export?format=csv&gid=29381785'),
  ('paul', 'Paw', '🏃', '#457b9d', null)
on conflict (id) do update set
  name = excluded.name,
  emoji = excluded.emoji,
  color = excluded.color;

insert into race_state (athlete_id) values ('andrea'), ('paul')
on conflict (athlete_id) do nothing;
