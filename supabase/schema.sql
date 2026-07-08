-- ============================================================
-- NGG Quiz - Supabase schema
-- Run this file in the Supabase SQL Editor.
-- The script is idempotent: it is safe to run repeatedly and on
-- any database state (fresh, partial, or an older version) - it
-- converges the database to the current shape without data loss.
-- The files in supabase/migrations/ are NOT needed if you run
-- this file; they exist only as standalone patches.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- Tables
-- ------------------------------------------------------------

create table if not exists public.folders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  name text not null,
  color text,                      -- hex color used to label the folder
  created_at timestamptz not null default now()
);

create table if not exists public.quizzes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  folder_id uuid references public.folders(id) on delete set null,
  title text not null,
  subtitle text,
  logo_url text,                   -- client logo shown on the opening screen
  teams_enabled boolean not null default false,
  team_mode text not null default 'manual'
    check (team_mode in ('manual', 'random')),
  teams jsonb,                     -- array of team names
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  position int not null,
  qtype text not null default 'multiple_choice'
    check (qtype in ('multiple_choice', 'poll', 'word_cloud', 'ranking', 'hotspot')),
  text text not null,
  options jsonb,                   -- mc/poll: answer strings; ranking: items in the CORRECT order
  correct_index int,               -- multiple_choice only
  meta jsonb,                      -- hotspot: {image_url, x, y} in percent coordinates
  explanation text                 -- optional, shown when the answer is revealed
);

create table if not exists public.game_sessions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  host_id uuid not null default auth.uid() references auth.users(id),
  pin text not null unique,
  status text not null default 'lobby'
    check (status in ('lobby', 'question', 'reveal', 'leaderboard', 'finished')),
  current_index int not null default -1,
  question_started_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  nickname text not null,
  team text,                       -- team name when the quiz runs in team mode
  score int not null default 0,
  joined_at timestamptz not null default now(),
  unique (session_id, nickname)
);

create table if not exists public.answers (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  answer_index int,                -- multiple_choice / poll
  answer jsonb,                    -- word_cloud: {text}; ranking: {order}; hotspot: {x, y}
  is_correct boolean not null default false,
  points int not null default 0,
  answered_at timestamptz not null default now(),
  unique (question_id, player_id)
);

-- convergence guards: bring tables created by older versions of this
-- file up to the current shape (no-ops on a fresh database)
alter table public.folders add column if not exists color text;
alter table public.quizzes add column if not exists logo_url text;
alter table public.quizzes add column if not exists folder_id uuid references public.folders(id) on delete set null;
alter table public.quizzes add column if not exists teams_enabled boolean not null default false;
alter table public.quizzes add column if not exists team_mode text not null default 'manual';
alter table public.quizzes add column if not exists teams jsonb;
alter table public.questions add column if not exists explanation text;
alter table public.questions add column if not exists qtype text not null default 'multiple_choice';
alter table public.questions add column if not exists meta jsonb;
alter table public.questions alter column correct_index drop not null;
alter table public.questions alter column options drop not null;
alter table public.questions drop column if exists time_limit;
alter table public.players add column if not exists team text;
alter table public.answers add column if not exists answer jsonb;
alter table public.answers alter column answer_index drop not null;

-- ------------------------------------------------------------
-- Scoring: computed on the server so clients cannot tamper.
-- There is no time limit; speed still matters. The speed base is
-- 500-1000 points with an exponential decay by response time
-- (instant -> 1000, ~30s -> ~684, several minutes -> ~500).
--   multiple_choice: full base when correct, 0 otherwise
--   ranking:         base scaled by Kendall-tau similarity
--   hotspot:         base scaled by distance from the target
--   poll/word_cloud: participation only, no points
-- ------------------------------------------------------------

create or replace function public.score_answer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  q record;
  s record;
  elapsed numeric;
  base numeric;
  arr jsonb;
  n int;
  d int;
  i int;
  j int;
  sim numeric;
  dist numeric;
begin
  select qtype, correct_index, options, meta into q from public.questions where id = new.question_id;
  select status, question_started_at into s from public.game_sessions where id = new.session_id;

  if s.status is distinct from 'question' then
    raise exception 'session is not accepting answers';
  end if;

  elapsed := greatest(0, extract(epoch from (now() - s.question_started_at)));
  base := 500 + 500 * exp(-elapsed / 30.0);

  if q.qtype = 'multiple_choice' then
    new.is_correct := (new.answer_index = q.correct_index);
    new.points := case when new.is_correct then round(base) else 0 end;

  elsif q.qtype = 'ranking' then
    -- answer.order holds the original item indices in the player's
    -- chosen order; the correct order is 0..n-1, so the Kendall
    -- distance equals the number of inversions in the permutation
    arr := new.answer -> 'order';
    n := coalesce(jsonb_array_length(q.options), 0);
    if arr is null or jsonb_array_length(arr) <> n or n < 2 then
      raise exception 'invalid ranking answer';
    end if;
    d := 0;
    for i in 0 .. n - 2 loop
      for j in i + 1 .. n - 1 loop
        if (arr ->> i)::int > (arr ->> j)::int then
          d := d + 1;
        end if;
      end loop;
    end loop;
    sim := 1 - d / (n * (n - 1) / 2.0);
    new.is_correct := (d = 0);
    new.points := round(base * sim);

  elsif q.qtype = 'hotspot' then
    -- percent-coordinate distance: full credit within 5, nothing
    -- beyond 40, linear in between
    dist := sqrt(
      power((q.meta ->> 'x')::numeric - (new.answer ->> 'x')::numeric, 2) +
      power((q.meta ->> 'y')::numeric - (new.answer ->> 'y')::numeric, 2)
    );
    sim := greatest(0, least(1, (40 - dist) / 35.0));
    new.is_correct := sim >= 0.5;
    new.points := round(base * sim);

  else
    -- poll / word_cloud: no right answer, no points
    new.is_correct := false;
    new.points := 0;
  end if;

  return new;
end;
$$;

drop trigger if exists answers_score on public.answers;
create trigger answers_score
  before insert on public.answers
  for each row execute function public.score_answer();

create or replace function public.apply_points()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.players set score = score + new.points where id = new.player_id;
  return new;
end;
$$;

drop trigger if exists answers_apply_points on public.answers;
create trigger answers_apply_points
  after insert on public.answers
  for each row execute function public.apply_points();

-- keep quizzes.updated_at fresh
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists quizzes_touch on public.quizzes;
create trigger quizzes_touch
  before update on public.quizzes
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- start_question: sets the question start time with the DATABASE
-- clock, so scoring is immune to the host machine's clock skew.
-- Only the session host may call it.
-- ------------------------------------------------------------

create or replace function public.start_question(p_session uuid, p_index int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.game_sessions
     set status = 'question',
         current_index = p_index,
         question_started_at = now()
   where id = p_session
     and host_id = auth.uid();

  if not found then
    raise exception 'not authorized or session not found';
  end if;
end;
$$;

grant execute on function public.start_question(uuid, int) to authenticated;

-- ------------------------------------------------------------
-- Admin access: any account with an @nggconsult.com email.
-- 1) a trigger on auth.users blocks sign-ups from other domains
-- 2) is_admin() re-checks the domain inside the RLS policies
-- Players never authenticate, so none of this affects them.
-- ------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'email', '') ilike '%@nggconsult.com'
$$;

create or replace function public.enforce_admin_email_domain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is null or new.email not ilike '%@nggconsult.com' then
    raise exception 'registration is limited to @nggconsult.com accounts';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_admin_email_domain on auth.users;
create trigger enforce_admin_email_domain
  before insert on auth.users
  for each row execute function public.enforce_admin_email_domain();

-- ------------------------------------------------------------
-- Row Level Security
-- Admins (@nggconsult.com accounts) manage their own quizzes and
-- sessions. Players (anon) may read game data, join and answer.
-- ------------------------------------------------------------

alter table public.folders enable row level security;
alter table public.quizzes enable row level security;
alter table public.questions enable row level security;
alter table public.game_sessions enable row level security;
alter table public.players enable row level security;
alter table public.answers enable row level security;

-- folders: shared library structure, only the creator manages
drop policy if exists "folders_select" on public.folders;
create policy "folders_select" on public.folders
  for select using (true);
drop policy if exists "folders_insert" on public.folders;
create policy "folders_insert" on public.folders
  for insert to authenticated with check (public.is_admin() and owner_id = auth.uid());
drop policy if exists "folders_update" on public.folders;
create policy "folders_update" on public.folders
  for update to authenticated using (owner_id = auth.uid());
drop policy if exists "folders_delete" on public.folders;
create policy "folders_delete" on public.folders
  for delete to authenticated using (owner_id = auth.uid());

-- quizzes: shared library - every admin can read and edit every
-- quiz; deletion stays with the quiz owner
drop policy if exists "quizzes_select" on public.quizzes;
create policy "quizzes_select" on public.quizzes
  for select using (true);
drop policy if exists "quizzes_insert" on public.quizzes;
create policy "quizzes_insert" on public.quizzes
  for insert to authenticated with check (public.is_admin() and owner_id = auth.uid());
drop policy if exists "quizzes_update" on public.quizzes;
create policy "quizzes_update" on public.quizzes
  for update to authenticated using (public.is_admin());
drop policy if exists "quizzes_delete" on public.quizzes;
create policy "quizzes_delete" on public.quizzes
  for delete to authenticated using (owner_id = auth.uid());

-- questions: readable by all (players need option texts),
-- editable by every admin (part of editing any quiz)
drop policy if exists "questions_select" on public.questions;
create policy "questions_select" on public.questions
  for select using (true);
drop policy if exists "questions_insert" on public.questions;
create policy "questions_insert" on public.questions
  for insert to authenticated with check (public.is_admin());
drop policy if exists "questions_update" on public.questions;
create policy "questions_update" on public.questions
  for update to authenticated using (public.is_admin());
drop policy if exists "questions_delete" on public.questions;
create policy "questions_delete" on public.questions
  for delete to authenticated using (public.is_admin());

-- game sessions: anyone can look up by PIN, only the host controls
drop policy if exists "sessions_select" on public.game_sessions;
create policy "sessions_select" on public.game_sessions
  for select using (true);
drop policy if exists "sessions_insert" on public.game_sessions;
create policy "sessions_insert" on public.game_sessions
  for insert to authenticated with check (public.is_admin() and host_id = auth.uid());
drop policy if exists "sessions_update" on public.game_sessions;
create policy "sessions_update" on public.game_sessions
  for update to authenticated using (host_id = auth.uid());

-- players: anyone may join a running session; scores change only
-- through the security-definer trigger, never directly by clients
drop policy if exists "players_select" on public.players;
create policy "players_select" on public.players
  for select using (true);
drop policy if exists "players_insert" on public.players;
create policy "players_insert" on public.players
  for insert with check (
    exists (select 1 from public.game_sessions s
            where s.id = session_id and s.status <> 'finished')
  );

-- answers: players submit while a question is open
drop policy if exists "answers_select" on public.answers;
create policy "answers_select" on public.answers
  for select using (true);
drop policy if exists "answers_insert" on public.answers;
create policy "answers_insert" on public.answers
  for insert with check (
    exists (select 1 from public.game_sessions s
            where s.id = session_id and s.status = 'question')
  );

-- ------------------------------------------------------------
-- Storage: public bucket for client logos
-- ------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('logos', 'logos', true)
on conflict (id) do nothing;

-- question images (hotspot questions)
insert into storage.buckets (id, name, public)
values ('media', 'media', true)
on conflict (id) do nothing;

drop policy if exists "logos_read" on storage.objects;
create policy "logos_read" on storage.objects
  for select using (bucket_id in ('logos', 'media'));

drop policy if exists "logos_write" on storage.objects;
create policy "logos_write" on storage.objects
  for insert to authenticated with check (bucket_id in ('logos', 'media'));

-- ------------------------------------------------------------
-- Realtime: broadcast changes for the live game screens
-- ------------------------------------------------------------

do $$
begin
  alter publication supabase_realtime add table public.game_sessions;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.players;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.answers;
exception when duplicate_object then null;
end $$;
