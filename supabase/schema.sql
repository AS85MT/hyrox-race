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
  kg_volume numeric not null default 0, -- deprecated; retained so existing databases migrate safely
  points numeric not null default 0,
  parsed_by text,                     -- deprecated; scoring now uses explicit sheet columns only
  public_title text,                  -- workout name copied from the sheet's Session column
  updated_at timestamptz not null default now()
);

-- Keep this file safe to rerun against an existing installation.
alter table workouts add column if not exists public_title text;

create table if not exists race_state (
  athlete_id text primary key references athletes(id),
  total_points numeric not null default 0,
  week_points numeric not null default 0,
  streak int not null default 0,
  total_km numeric not null default 0,
  total_kg numeric not null default 0, -- deprecated; retained so existing databases migrate safely
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

drop policy if exists "public read athletes" on athletes;
drop policy if exists "public read workouts" on workouts;
drop policy if exists "public read race" on race_state;
drop policy if exists "public read trophies" on trophies;
drop policy if exists "public read synclog" on sync_log;

create policy "public read workouts" on workouts for select using (true);
create policy "public read race" on race_state for select using (true);
create policy "public read trophies" on trophies for select using (true);

-- RLS limits rows, not columns. Do not expose sheet URLs, raw workout notes,
-- parsing metadata, or operational logs through the publishable browser key.
revoke select on athletes, workouts, race_state, sync_log from anon, authenticated;
revoke select (kg_volume) on workouts from anon, authenticated;
revoke select (total_kg) on race_state from anon, authenticated;
grant select (athlete_id, date, public_title, status, km, rpe, points)
  on workouts to anon, authenticated;
grant select (athlete_id, total_points, week_points, streak, total_km,
  sessions_completed, sessions_skipped, updated_at)
  on race_state to anon, authenticated;
grant select on trophies to anon, authenticated;

-- Reject malformed metrics even if a future parser or manual edit misbehaves.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'workouts_status_valid' and conrelid = 'workouts'::regclass) then
    alter table workouts add constraint workouts_status_valid
      check (status in ('completed', 'skipped', 'rest', 'pending')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workouts_rpe_valid' and conrelid = 'workouts'::regclass) then
    alter table workouts add constraint workouts_rpe_valid
      check (rpe is null or rpe between 1 and 10) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workouts_metrics_nonnegative' and conrelid = 'workouts'::regclass) then
    alter table workouts add constraint workouts_metrics_nonnegative
      check (km >= 0 and kg_volume >= 0 and points >= 0) not valid;
  end if;
end $$;

-- Seed the two racers. Configure both private sheet URLs directly in Supabase;
-- keeping them out of source control avoids publishing the full training sheets.
insert into athletes (id, name, emoji, color, sheet_csv_url) values
  ('andrea', 'Andrea', '🏃‍♂️', '#e63946', null),
  ('paul', 'Paw', '🏃', '#457b9d', null)
on conflict (id) do update set
  name = excluded.name,
  emoji = excluded.emoji,
  color = excluded.color;

insert into race_state (athlete_id) values ('andrea'), ('paul')
on conflict (athlete_id) do nothing;
