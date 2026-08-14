-- Migration for projects that already ran an EARLIER schema.sql.
-- New projects should run schema.sql only - it is already up to date.
--
-- Adds an optional per-question timer: questions.time_limit holds the
-- number of seconds a question stays open, or null for no limit (the
-- previous behaviour, where the host closes the question manually).

alter table public.questions add column if not exists time_limit int;

do $$
begin
  alter table public.questions
    add constraint questions_time_limit_range
    check (time_limit is null or (time_limit >= 5 and time_limit <= 600));
exception when duplicate_object then null;
end $$;

-- scoring, with the timer deadline enforced on the server as well, so a
-- late answer cannot score even if the host screen was closed
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
  select qtype, correct_index, options, meta, time_limit into q from public.questions where id = new.question_id;
  select status, question_started_at into s from public.game_sessions where id = new.session_id;

  if s.status is distinct from 'question' then
    raise exception 'session is not accepting answers';
  end if;

  elapsed := greatest(0, extract(epoch from (now() - s.question_started_at)));

  -- a timed question stops accepting answers at its deadline; the 2 second
  -- grace window keeps an answer sent in time over a slow mobile network
  if q.time_limit is not null and elapsed > q.time_limit + 2 then
    raise exception 'the time for this question is up';
  end if;

  base := 500 + 500 * exp(-elapsed / 30.0);

  if q.qtype = 'multiple_choice' then
    new.is_correct := (new.answer_index = q.correct_index);
    new.points := case when new.is_correct then round(base) else 0 end;

  elsif q.qtype = 'ranking' then
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
