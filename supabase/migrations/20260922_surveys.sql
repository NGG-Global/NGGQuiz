-- Migration for projects that already ran an EARLIER schema.sql.
-- New projects should run schema.sql only - it is already up to date.
--
-- Adds surveys: quizzes.kind marks a quiz as a scored quiz or an unscored
-- survey, and questions gains the 'scale' type, whose meta holds
-- {min, max, low_label, high_label}. A scale answer stores the chosen
-- value itself in answers.answer_index.

alter table public.quizzes add column if not exists kind text not null default 'quiz';

do $$
begin
  alter table public.quizzes
    add constraint quizzes_kind_check check (kind in ('quiz', 'survey'));
exception when duplicate_object then null;
end $$;

-- the question types grew, so the constraint is replaced, not added
alter table public.questions drop constraint if exists questions_qtype_check;
alter table public.questions
  add constraint questions_qtype_check
  check (qtype in ('multiple_choice', 'poll', 'word_cloud', 'ranking', 'hotspot', 'scale'));

-- scoring, with the scale question added: it earns no points, and its
-- value has to be a point on the scale so a tampered client cannot skew
-- the survey's statistics
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

  elsif q.qtype = 'scale' then
    -- unscored like a poll, but the value has to be a point on the scale:
    -- anything else would quietly skew the survey's statistics
    if new.answer_index is null
       or new.answer_index < (q.meta ->> 'min')::int
       or new.answer_index > (q.meta ->> 'max')::int then
      raise exception 'answer is outside the scale';
    end if;
    new.is_correct := false;
    new.points := 0;

  else
    -- poll / word_cloud: no right answer, no points
    new.is_correct := false;
    new.points := 0;
  end if;

  return new;
end;
$$;
