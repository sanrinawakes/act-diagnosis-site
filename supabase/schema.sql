-- Enable required extensions
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- Create profiles table (extends auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  role text not null default 'member' check (role in ('admin', 'member')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Create diagnosis_results table
create table if not exists public.diagnosis_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type_code text not null,
  consciousness_level integer not null check (consciousness_level >= 1 and consciousness_level <= 6),
  subtype text,
  scores_json jsonb,
  answers_json jsonb,
  created_at timestamptz not null default now()
);

-- Create chat_sessions table
create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  diagnosis_result_id uuid references public.diagnosis_results(id) on delete set null,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.chat_sessions add column if not exists is_pinned boolean not null default false;
alter table public.chat_sessions add column if not exists last_message_at timestamptz not null default now();
alter table public.chat_sessions add column if not exists message_count integer not null default 0;

-- Create chat_messages table
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  created_at timestamptz not null default now()
);

-- Create site_settings table
create table if not exists public.site_settings (
  id integer primary key default 1,
  bot_enabled boolean not null default true,
  maintenance_mode boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

-- Support correspondence is submitted through server routes and can only be
-- read or updated by authenticated administrators in the management screen.
create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  name text not null,
  email text not null,
  category text not null default 'general',
  subject text not null,
  message text not null,
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  submission_key uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Insert default site_settings row
insert into public.site_settings (id, bot_enabled, maintenance_mode, updated_at)
values (1, true, false, now())
on conflict (id) do nothing;

-- Create indexes for performance
create index if not exists idx_diagnosis_results_user_id on public.diagnosis_results(user_id);
create index if not exists idx_chat_messages_session_id on public.chat_messages(session_id);
create index if not exists idx_chat_sessions_user_id on public.chat_sessions(user_id);
create index if not exists idx_support_tickets_status_updated_at
  on public.support_tickets(status, updated_at desc);
create unique index if not exists support_tickets_user_submission_key_unique
  on public.support_tickets(user_id, submission_key)
  where submission_key is not null;

-- Enable RLS (Row Level Security)
alter table public.profiles enable row level security;
alter table public.diagnosis_results enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;
alter table public.site_settings enable row level security;
alter table public.support_tickets enable row level security;

-- RLS Policies for profiles
create policy "Users can view their own profile"
  on public.profiles for select
  using (auth.uid() = id or exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  ));

create policy "Admins can view all profiles"
  on public.profiles for select
  using (exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  ));

create policy "Admins can update all profiles"
  on public.profiles for update
  using (exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  ));

-- RLS Policies for diagnosis_results
create policy "Users can view their own diagnosis results"
  on public.diagnosis_results for select
  using (auth.uid() = user_id or exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  ));

create policy "Users can create their own diagnosis results"
  on public.diagnosis_results for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own diagnosis results"
  on public.diagnosis_results for update
  using (auth.uid() = user_id);

create policy "Admins can view all diagnosis results"
  on public.diagnosis_results for select
  using (exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  ));

-- RLS Policies for chat_sessions
create policy "Users can view their own chat sessions"
  on public.chat_sessions for select
  using (auth.uid() = user_id or exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  ));

create policy "Users can create their own chat sessions"
  on public.chat_sessions for insert
  with check (
    auth.uid() = user_id and (
      diagnosis_result_id is null or exists (
        select 1 from public.diagnosis_results
        where id = chat_sessions.diagnosis_result_id and user_id = auth.uid()
      )
    )
  );

create policy "Users can update their own chat sessions"
  on public.chat_sessions for update
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id and (
      diagnosis_result_id is null or exists (
        select 1 from public.diagnosis_results
        where id = chat_sessions.diagnosis_result_id and user_id = auth.uid()
      )
    )
  );

-- RLS Policies for chat_messages
create policy "Users can view messages in their chat sessions"
  on public.chat_messages for select
  using (exists (
    select 1 from public.chat_sessions
    where id = session_id and (user_id = auth.uid() or exists (
      select 1 from public.profiles where id = auth.uid() and role = 'admin'
    ))
  ));

create policy "Users can create their own chat inputs"
  on public.chat_messages for insert
  with check (role = 'user' and exists (
    select 1 from public.chat_sessions
    where id = session_id and user_id = auth.uid()
  ));

-- RLS Policies for site_settings
create policy "Anyone can view site settings"
  on public.site_settings for select
  using (true);

create policy "Only admins can update site settings"
  on public.site_settings for update
  using (exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  ));

create policy "Only admins can manage support tickets"
  on public.support_tickets for all
  to authenticated
  using (exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  ))
  with check (exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  ));

create or replace function public.enforce_pinned_chat_session_limit()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_pinned_count integer;
begin
  if new.is_pinned is not true
     or (tg_op = 'UPDATE' and old.is_pinned is true) then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(new.user_id::text));
  select count(*) into v_pinned_count
  from public.chat_sessions
  where user_id = new.user_id and is_pinned is true;
  if v_pinned_count >= 100 then
    raise exception 'A member may pin at most 100 chat sessions';
  end if;
  return new;
end;
$$;

drop trigger if exists trigger_enforce_pinned_chat_session_limit on public.chat_sessions;
create trigger trigger_enforce_pinned_chat_session_limit
before insert or update of is_pinned on public.chat_sessions
for each row execute function public.enforce_pinned_chat_session_limit();

-- Trigger to auto-create profile on auth.users insert
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, display_name, role, is_active)
  values (new.id, new.email, '', 'member', true)
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
