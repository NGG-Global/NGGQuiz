-- Migration for projects that already ran an earlier schema.sql.
-- New projects should run schema.sql only - it is already up to date.

-- folders for organizing the quiz library
create table if not exists public.folders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  name text not null,
  created_at timestamptz not null default now()
);

alter table public.quizzes
  add column if not exists folder_id uuid references public.folders(id) on delete set null;

-- optional explanation shown when the answer is revealed
alter table public.questions add column if not exists explanation text;

alter table public.folders enable row level security;

drop policy if exists "folders_select" on public.folders;
create policy "folders_select" on public.folders
  for select using (true);

drop policy if exists "folders_insert" on public.folders;
create policy "folders_insert" on public.folders
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists "folders_update" on public.folders;
create policy "folders_update" on public.folders
  for update to authenticated using (owner_id = auth.uid());

drop policy if exists "folders_delete" on public.folders;
create policy "folders_delete" on public.folders
  for delete to authenticated using (owner_id = auth.uid());
