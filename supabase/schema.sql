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

-- Insert default site_settings row
insert into public.site_settings (id, bot_enabled, maintenance_mode, updated_at)
values (1, true, false, now())
on conflict (id) do nothing;

-- Create indexes for performance
create index if not exists idx_diagnosis_results_user_id on public.diagnosis_results(user_id);
create index if not exists idx_chat_messages_session_id on public.chat_messages(session_id);
create index if not exists idx_chat_sessions_user_id on public.chat_sessions(user_id);

-- Enable RLS (Row Level Security)
alter table public.profiles enable row level security;
alter table public.diagnosis_results enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;
alter table public.site_settings enable row level security;

-- RLS Policies for profiles
create policy "Users can view their own profile"
  on public.profiles for select
  using (auth.uid() = id or exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  ));

create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

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
  with check (auth.uid() = user_id);

create policy "Users can update their own chat sessions"
  on public.chat_sessions for update
  using (auth.uid() = user_id);

-- RLS Policies for chat_messages
create policy "Users can view messages in their chat sessions"
  on public.chat_messages for select
  using (exists (
    select 1 from public.chat_sessions
    where id = session_id and (user_id = auth.uid() or exists (
      select 1 from public.profiles where id = auth.uid() and role = 'admin'
    ))
  ));

create policy "Users can create messages in their chat sessions"
  on public.chat_messages for insert
  with check (exists (
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
