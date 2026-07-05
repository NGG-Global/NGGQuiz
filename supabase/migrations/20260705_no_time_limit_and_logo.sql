-- Migration for projects that already ran the ORIGINAL schema.sql.
-- New projects should run schema.sql only - it is already up to date.

-- client logo on the quiz opening screen
alter table public.quizzes add column if not exists logo_url text;

-- questions no longer have a time limit
alter table public.questions drop column if exists time_limit;

-- scoring without a time limit: exponential decay by response speed
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
  select correct_index into q from public.questions where id = new.question_id;
  select status, question_started_at, current_index into s from public.game_sessions where id = new.session_id;

  if s.status is distinct from 'question' then
    raise exception 'session is not accepting answers';
  end if;

  new.is_correct := (new.answer_index = q.correct_index);

  if new.is_correct then
    elapsed := greatest(0, extract(epoch from (now() - s.question_started_at)));
    new.points := round(500 + 500 * exp(-elapsed / 30.0));
  else
    new.points := 0;
  end if;

  return new;
end;
$$;

-- public storage bucket for logos
insert into storage.buckets (id, name, public)
values ('logos', 'logos', true)
on conflict (id) do nothing;

drop policy if exists "logos_read" on storage.objects;
create policy "logos_read" on storage.objects
  for select using (bucket_id = 'logos');

drop policy if exists "logos_write" on storage.objects;
create policy "logos_write" on storage.objects
  for insert to authenticated with check (bucket_id = 'logos');
