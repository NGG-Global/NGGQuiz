-- Migration for projects that already ran an EARLIER schema.sql.
-- New projects should run schema.sql only - it is already up to date.
--
-- Adds live mode and the true/false question:
--   quizzes.scored     - false runs the quiz in live mode: no points, live
--                        results on the projector and an answer slide
--   quizzes.anonymous  - participants join without a nickname; allowed only
--                        on an unscored quiz
--   questions.qtype    - gains 'true_false', whose options are always
--                        ['נכון', 'לא נכון'] with correct_index 0 or 1
--
-- Apply this BEFORE merging the front end: the deploy publishes on merge,
-- and the new screens select these columns.

alter table public.quizzes add column if not exists scored boolean not null default true;
alter table public.quizzes add column if not exists anonymous boolean not null default false;

-- anonymous join only makes sense without a leaderboard (anonymous => unscored),
-- and teams only make sense with one (teams => scored)
do $$
begin
  alter table public.quizzes
    add constraint quizzes_live_settings
    check ((not scored or not anonymous) and (scored or not teams_enabled));
exception when duplicate_object then null;
end $$;

-- the question types grew, so the constraint is replaced, not added
alter table public.questions drop constraint if exists questions_qtype_check;
alter table public.questions
  add constraint questions_qtype_check
  check (qtype in ('multiple_choice', 'poll', 'word_cloud', 'ranking', 'hotspot', 'scale', 'true_false'));

-- a true/false question has exactly its two answers and one of them marked
-- correct. CASE keeps jsonb_array_length away from other types, and the
-- explicit null test matters: a CHECK that evaluates to null passes
do $$
begin
  alter table public.questions
    add constraint questions_true_false_shape
    check (case when qtype = 'true_false'
      then options is not null and jsonb_array_length(options) = 2
           and correct_index is not null and correct_index in (0, 1)
      else true end);
exception when duplicate_object then null;
end $$;

-- scoring, with true_false scored like multiple_choice (a true/false answer
-- outside its two options is rejected as a tampered client), and no points
-- at all in an unscored quiz, while is_correct is still set for the
-- answer slide
create or replace function public.score_answer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  q record;
  s record;
  quiz_scored boolean;
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
  select quiz_id, qtype, correct_index, options, meta, time_limit into q from public.questions where id = new.question_id;
  select status, question_started_at into s from public.game_sessions where id = new.session_id;

  if s.status is distinct from 'question' then
    raise exception 'session is not accepting answers';
  end if;

  select scored into quiz_scored from public.quizzes where id = q.quiz_id;

  elapsed := greatest(0, extract(epoch from (now() - s.question_started_at)));

  -- a timed question stops accepting answers at its deadline; the 2 second
  -- grace window keeps an answer sent in time over a slow mobile network
  if q.time_limit is not null and elapsed > q.time_limit + 2 then
    raise exception 'the time for this question is up';
  end if;

  base := 500 + 500 * exp(-elapsed / 30.0);

  if q.qtype in ('multiple_choice', 'true_false') then
    -- a true/false answer can only be one of its two options; anything else
    -- comes from a tampered client, not from a wrong answer
    if q.qtype = 'true_false'
       and (new.answer_index is null or new.answer_index not in (0, 1)) then
      raise exception 'invalid true/false answer';
    end if;
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

  -- live mode (an unscored quiz) earns no points, so players.score stays 0;
  -- is_correct is still set above because the answer slide counts it
  if quiz_scored is false then
    new.points := 0;
  end if;

  return new;
end;
$$;
