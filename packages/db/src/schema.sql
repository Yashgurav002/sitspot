-- SITSPOT_BUILD_SPEC.md §7, idempotent, runs on PGlite (+vector) and any Postgres with pgvector.
create extension if not exists vector;
-- Tiger Cloud only:
-- create extension if not exists timescaledb;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  phone_e164 text,                    -- encrypt at app level before storing
  timezone text not null default 'Asia/Kolkata',
  quiet_start time not null default '22:00',
  quiet_end time not null default '07:00',
  threshold real not null default 0.35,
  push_subscription jsonb,            -- Web Push fallback
  created_at timestamptz not null default now()
);

create table if not exists spots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('home','park','heritage','coastal')),
  lat double precision not null,
  lon double precision not null,
  travel_min int not null default 10,
  created_at timestamptz not null default now()
);

create table if not exists conditions (
  time timestamptz not null,
  spot_id uuid not null references spots(id) on delete cascade,
  temp_c real, apparent_c real, rh_pct real, wind_ms real,
  precip_mm real, cloud_pct real,
  pm25 real, pm10 real, us_aqi real,
  tide_m real,
  is_forecast boolean not null default true,
  primary key (spot_id, time)
);
-- select create_hypertable('conditions','time', if_not_exists => true);

create table if not exists sightings (
  time timestamptz not null,
  checklist_id text,
  loc_id text,
  lat double precision, lon double precision,
  species_code text not null,
  common_name text,
  how_many int,
  primary key (loc_id, species_code, time)
);
-- select create_hypertable('sightings','time', if_not_exists => true);

create table if not exists training_checklists (       -- TabPFN training table (from eBird)
  checklist_id text primary key,
  loc_id text, lat double precision, lon double precision,
  obs_time timestamptz,
  duration_min int,
  protocol text,
  num_species int,
  features jsonb not null default '{}'   -- joined weather/AQI/tide/sun features
);

create table if not exists forecasts (
  time timestamptz not null,             -- the hour being forecast
  spot_id uuid not null references spots(id) on delete cascade,
  p_rich real not null,
  model_version text not null,
  created_at timestamptz not null default now(),
  primary key (spot_id, time, model_version)
);

create table if not exists invitations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  spot_id uuid not null references spots(id),
  window_start timestamptz not null,
  window_end timestamptz not null,
  score real not null,
  factors jsonb not null,                -- each factor of the score
  reason text not null,                  -- one sentence
  script text,                           -- what the call said
  channel text not null default 'call' check (channel in ('call','push')),
  status text not null default 'pending'
    check (status in ('pending','sent','accepted','declined','no_answer','arrived','completed','missed','cancelled')),
  workflow_id text,
  call_id text,
  created_at timestamptz not null default now(),
  responded_at timestamptz
);

create table if not exists visits (
  id uuid primary key default gen_random_uuid(),
  invitation_id uuid unique references invitations(id),
  arrived_at timestamptz not null,
  ended_at timestamptz,
  minutes int,
  rating int check (rating between 1 and 5)
);

create table if not exists detections (
  time timestamptz not null,
  visit_id uuid not null references visits(id) on delete cascade,
  species_code text not null,
  common_name text,
  confidence real not null,
  model_version text not null,
  primary key (visit_id, time, species_code)
);
-- select create_hypertable('detections','time', if_not_exists => true);

create table if not exists observations (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid references visits(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  time timestamptz not null default now(),
  text text not null,
  embedding vector(768)
);

create table if not exists field_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  date date not null,
  body text not null,
  facts jsonb not null,                  -- deterministic facts the note was built from
  model text not null,
  embedding vector(768),
  body_tsv tsvector generated always as (to_tsvector('english', body)) stored
);
create index if not exists field_notes_body_tsv_idx on field_notes using gin (body_tsv);
create index if not exists field_notes_embedding_idx on field_notes using hnsw (embedding vector_cosine_ops);
-- Tiger Cloud alternative for BM25: pg_textsearch index [verify syntax/availability]

create table if not exists preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  key text not null,                     -- e.g. 'avoid_species', 'spot_weekends_only', 'loves'
  value jsonb not null,
  source_utterance text not null check (length(trim(source_utterance)) > 0), -- the user's own words, required
  created_at timestamptz not null default now()
);

create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  invitation_id uuid references invitations(id),
  kind text not null,                    -- 'script','chat','note','intent'
  model text not null,
  tokens_in int, tokens_out int, latency_ms int,
  trace_id text,
  created_at timestamptz not null default now()
);
