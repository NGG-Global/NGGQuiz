-- ============================================================
-- NGG Quiz - Supabase schema
-- Run this file in the Supabase SQL Editor (one time per project).
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- Tables
-- ------------------------------------------------------------

create table if not exists public.quizzes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  title text not null,
  subtitle text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  position int not null,
  text text not null,
  options jsonb not null,          -- array of 2-4 answer strings
  correct_index int not null,
  time_limit int not null default 20   -- seconds
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
  score int not null default 0,
  joined_at timestamptz not null default now(),
  unique (session_id, nickname)
);

create table if not exists public.answers (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  answer_index int not null,
  is_correct boolean not null default false,
  points int not null default 0,
  answered_at timestamptz not null default now(),
  unique (question_id, player_id)
);

-- ------------------------------------------------------------
-- Scoring: computed on the server so clients cannot tamper.
-- Correct answer earns 500-1000 points, scaled by answer speed:
-- instant answer -> 1000, answer at the time limit -> 500.
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
begin
  select correct_index, time_limit into q from public.questions where id = new.question_id;
  select status, question_started_at, current_index into s from public.game_sessions where id = new.session_id;

  if s.status is distinct from 'question' then
    raise exception 'session is not accepting answers';
  end if;

  new.is_correct := (new.answer_index = q.correct_index);

  if new.is_correct then
    elapsed := extract(epoch from (now() - s.question_started_at));
    elapsed := greatest(0, least(elapsed, q.time_limit));
    new.points := round(500 + 500 * (1 - elapsed / q.time_limit));
  else
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
-- Row Level Security
-- Admins (authenticated) manage their own quizzes and sessions.
-- Players (anon) may read game data, join a session and answer.
-- ------------------------------------------------------------

alter table public.quizzes enable row level security;
alter table public.questions enable row level security;
alter table public.game_sessions enable row level security;
alter table public.players enable row level security;
alter table public.answers enable row level security;

-- quizzes: shared library (all can read), only the owner edits
create policy "quizzes_select" on public.quizzes
  for select using (true);
create policy "quizzes_insert" on public.quizzes
  for insert to authenticated with check (owner_id = auth.uid());
create policy "quizzes_update" on public.quizzes
  for update to authenticated using (owner_id = auth.uid());
create policy "quizzes_delete" on public.quizzes
  for delete to authenticated using (owner_id = auth.uid());

-- questions: readable by all (players need option texts), owner edits
create policy "questions_select" on public.questions
  for select using (true);
create policy "questions_insert" on public.questions
  for insert to authenticated
  with check (exists (select 1 from public.quizzes q where q.id = quiz_id and q.owner_id = auth.uid()));
create policy "questions_update" on public.questions
  for update to authenticated
  using (exists (select 1 from public.quizzes q where q.id = quiz_id and q.owner_id = auth.uid()));
create policy "questions_delete" on public.questions
  for delete to authenticated
  using (exists (select 1 from public.quizzes q where q.id = quiz_id and q.owner_id = auth.uid()));

-- game sessions: anyone can look up by PIN, only the host controls
create policy "sessions_select" on public.game_sessions
  for select using (true);
create policy "sessions_insert" on public.game_sessions
  for insert to authenticated with check (host_id = auth.uid());
create policy "sessions_update" on public.game_sessions
  for update to authenticated using (host_id = auth.uid());

-- players: anyone may join a running session; scores change only
-- through the security-definer trigger, never directly by clients
create policy "players_select" on public.players
  for select using (true);
create policy "players_insert" on public.players
  for insert with check (
    exists (select 1 from public.game_sessions s
            where s.id = session_id and s.status <> 'finished')
  );

-- answers: players submit while a question is open
create policy "answers_select" on public.answers
  for select using (true);
create policy "answers_insert" on public.answers
  for insert with check (
    exists (select 1 from public.game_sessions s
            where s.id = session_id and s.status = 'question')
  );

-- ------------------------------------------------------------
-- Realtime: broadcast changes for the live game screens
-- ------------------------------------------------------------

alter publication supabase_realtime add table public.game_sessions;
alter publication supabase_realtime add table public.players;
alter publication supabase_realtime add table public.answers;
