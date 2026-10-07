-- Migration for projects that already ran an EARLIER schema.sql.
-- New projects should run schema.sql only - it is already up to date.
--
-- Answers with several values:
--   a poll may take several options when its question has
--     meta.multi_select = true; the answer is stored as answer.indexes
--   a word cloud may take several words when its question has
--     meta.max_entries = 2..5; the answer is stored as answer.texts
-- Each participant still sends one answer row per question.
--
-- The screens work before this file is run; it adds the database checks
-- that keep a modified client from sending options that do not exist, the
-- same option twice, more words than allowed, or very long words. Safe to
-- run more than once; it replaces only the scoring function.

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

  elsif q.qtype = 'poll' then
    -- no right answer and no points, but every chosen option has to exist:
    -- one option, or - when the author allowed it (meta.multi_select) -
    -- several in answer.indexes, none of them twice
    n := coalesce(jsonb_array_length(q.options), 0);
    if jsonb_typeof(new.answer -> 'indexes') = 'array' then
      arr := new.answer -> 'indexes';
      if coalesce((q.meta ->> 'multi_select')::boolean, false) is not true
         or jsonb_array_length(arr) = 0
         or jsonb_array_length(arr) > n
         or exists (select 1 from jsonb_array_elements(arr) e
                     where (e #>> '{}') !~ '^[0-9]+$' or (e #>> '{}')::int >= n)
         or (select count(distinct e) from jsonb_array_elements(arr) e) <> jsonb_array_length(arr) then
        raise exception 'invalid poll answer';
      end if;
      new.answer_index := null;
    elsif new.answer_index is null or new.answer_index < 0 or new.answer_index >= n then
      raise exception 'invalid poll answer';
    end if;
    new.is_correct := false;
    new.points := 0;

  elsif q.qtype = 'word_cloud' then
    -- short words only, and no more of them than the author allowed
    -- (meta.max_entries; one when unset)
    if jsonb_typeof(new.answer -> 'texts') = 'array' then
      arr := new.answer -> 'texts';
      n := least(greatest(coalesce((q.meta ->> 'max_entries')::int, 1), 1), 10);
      if jsonb_array_length(arr) = 0
         or jsonb_array_length(arr) > n
         or exists (select 1 from jsonb_array_elements(arr) e
                     where jsonb_typeof(e) <> 'string'
                        or char_length(btrim(e #>> '{}')) not between 1 and 60) then
        raise exception 'invalid word cloud answer';
      end if;
    elsif jsonb_typeof(new.answer -> 'text') is distinct from 'string'
          or char_length(btrim(new.answer ->> 'text')) not between 1 and 60 then
      raise exception 'invalid word cloud answer';
    end if;
    new.is_correct := false;
    new.points := 0;

  else
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
