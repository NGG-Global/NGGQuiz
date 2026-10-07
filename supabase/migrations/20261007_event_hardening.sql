-- Migration for projects that already ran an EARLIER schema.sql.
-- New projects should run schema.sql only - it is already up to date.
--
-- Prepares live sessions for a large audience. Safe to run more than once,
-- and safe to run before or after the matching front end is deployed: the
-- screens fall back to their previous behaviour while the two new functions
-- are missing. Run it outside a live session - building the indexes briefly
-- holds writes to the answers and players tables.
--
--   indexes               the reads every phone and the projector make
--                         during a game stay index lookups as the answers
--                         table grows from event to event
--   answers_apply_points  fires only for an answer that earned points, so
--                         live mode, polls and surveys no longer rewrite a
--                         players row per answer - half the writes, and half
--                         the changes Realtime has to process
--   start_question        a repeated call for the question already open does
--                         nothing, so a double click on "next question" no
--                         longer restarts that question's clock
--   player_standing()     one player's score, rank and the player count, so a
--                         phone no longer downloads every player to find its
--                         own rank
--   server_time()         the database clock, so countdowns on phones and on
--                         the projector run on the same clock as the scoring

create index if not exists answers_session_question_idx
  on public.answers (session_id, question_id, answered_at, id);
create index if not exists answers_player_idx
  on public.answers (player_id);
create index if not exists players_session_score_idx
  on public.players (session_id, score desc);
create index if not exists questions_quiz_position_idx
  on public.questions (quiz_id, position);

drop trigger if exists answers_apply_points on public.answers;
create trigger answers_apply_points
  after insert on public.answers
  for each row
  when (new.points <> 0)
  execute function public.apply_points();

create or replace function public.start_question(p_session uuid, p_index int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
begin
  select host_id, status, current_index into s
    from public.game_sessions
   where id = p_session
     for update;

  if not found or s.host_id is distinct from auth.uid() then
    raise exception 'not authorized or session not found';
  end if;

  -- the question is already open: a second call (a double click, a retry
  -- after a lost response) must not restart its clock
  if s.status = 'question' and s.current_index = p_index then
    return;
  end if;

  update public.game_sessions
     set status = 'question',
         current_index = p_index,
         question_started_at = now()
   where id = p_session;
end;
$$;

grant execute on function public.start_question(uuid, int) to authenticated;

-- competition ranking: players on the same score share a rank
create or replace function public.player_standing(p_player uuid)
returns table (score int, rank int, total int)
language sql
stable
set search_path = public
as $$
  select me.score,
         (select count(*)::int + 1 from public.players p
           where p.session_id = me.session_id and p.score > me.score),
         (select count(*)::int from public.players p
           where p.session_id = me.session_id)
    from public.players me
   where me.id = p_player
$$;

grant execute on function public.player_standing(uuid) to anon, authenticated;

create or replace function public.server_time()
returns timestamptz
language sql
stable
as $$
  select now()
$$;

grant execute on function public.server_time() to anon, authenticated;
