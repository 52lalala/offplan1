create extension if not exists pgcrypto;

create table if not exists public.rest_periods (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 30),
  start_time time not null,
  end_time time not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.rest_periods (name, start_time, end_time, sort_order, is_active)
select *
from (
  values
    ('午高峰', '10:30:00'::time, '13:30:00'::time, 1, true),
    ('晚高峰', '18:00:00'::time, '20:00:00'::time, 2, true)
) as seed(name, start_time, end_time, sort_order, is_active)
where not exists (
  select 1
  from public.rest_periods existing
  where existing.name = seed.name
    and existing.start_time = seed.start_time
    and existing.end_time = seed.end_time
);

create table if not exists public.rest_weeks (
  id uuid primary key default gen_random_uuid(),
  start_date date not null,
  end_date date not null,
  is_active boolean not null default false,
  default_period_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);

alter table public.rest_weeks
add column if not exists default_period_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'rest_weeks_default_period_id_fkey'
  ) then
    alter table public.rest_weeks
    add constraint rest_weeks_default_period_id_fkey
    foreign key (default_period_id)
    references public.rest_periods(id)
    on update cascade
    on delete set null;
  end if;
end $$;

insert into public.rest_weeks (start_date, end_date, is_active, default_period_id)
select
  '2026-05-25'::date,
  '2026-05-31'::date,
  true,
  (
    select id
    from public.rest_periods
    where is_active = true
    order by sort_order asc, created_at asc
    limit 1
  )
where not exists (
  select 1
  from public.rest_weeks existing
  where existing.start_date = '2026-05-25'::date
    and existing.end_date = '2026-05-31'::date
);

update public.rest_weeks
set default_period_id = (
  select id
  from public.rest_periods
  where is_active = true
  order by sort_order asc, created_at asc
  limit 1
)
where default_period_id is null;

create table if not exists public.rest_day_limits (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  rest_date date not null,
  max_slots integer not null check (max_slots >= 0 and max_slots <= 20),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (week_start, rest_date)
);

create table if not exists public.employee_week_shifts (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  work_date date not null,
  employee_name text not null check (char_length(trim(employee_name)) between 1 and 20),
  status text not null check (status in ('work', 'rest')),
  period_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_name, work_date),
  unique (employee_name, week_start, work_date)
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'employee_week_shifts_period_id_fkey'
  ) then
    alter table public.employee_week_shifts
    add constraint employee_week_shifts_period_id_fkey
    foreign key (period_id)
    references public.rest_periods(id)
    on update cascade
    on delete set null;
  end if;
end $$;

create index if not exists idx_rest_periods_sort on public.rest_periods (sort_order, is_active);
create index if not exists idx_rest_weeks_active on public.rest_weeks (is_active, start_date desc);
create index if not exists idx_rest_day_limits_week_date on public.rest_day_limits (week_start, rest_date);
create index if not exists idx_employee_week_shifts_week_date on public.employee_week_shifts (week_start, work_date);
create index if not exists idx_employee_week_shifts_employee_week on public.employee_week_shifts (employee_name, week_start);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_rest_periods_updated_at on public.rest_periods;
create trigger trg_rest_periods_updated_at
before update on public.rest_periods
for each row
execute function public.set_updated_at();

drop trigger if exists trg_rest_weeks_updated_at on public.rest_weeks;
create trigger trg_rest_weeks_updated_at
before update on public.rest_weeks
for each row
execute function public.set_updated_at();

drop trigger if exists trg_rest_day_limits_updated_at on public.rest_day_limits;
create trigger trg_rest_day_limits_updated_at
before update on public.rest_day_limits
for each row
execute function public.set_updated_at();

drop trigger if exists trg_employee_week_shifts_updated_at on public.employee_week_shifts;
create trigger trg_employee_week_shifts_updated_at
before update on public.employee_week_shifts
for each row
execute function public.set_updated_at();

create or replace function public.ensure_default_day_limit(p_week_start date, p_rest_date date)
returns integer
language plpgsql
as $$
declare
  v_max_slots integer;
  v_day integer;
begin
  select max_slots
  into v_max_slots
  from public.rest_day_limits
  where week_start = p_week_start and rest_date = p_rest_date
  for update;

  if found then
    return v_max_slots;
  end if;

  v_day := extract(dow from p_rest_date);
  v_max_slots := case when v_day in (0, 6) then 2 else 5 end;

  insert into public.rest_day_limits (week_start, rest_date, max_slots)
  values (p_week_start, p_rest_date, v_max_slots)
  on conflict (week_start, rest_date) do update
  set max_slots = public.rest_day_limits.max_slots
  returning max_slots into v_max_slots;

  return v_max_slots;
end;
$$;

create or replace function public.get_default_period_id_for_week(p_week_start date)
returns uuid
language plpgsql
as $$
declare
  v_period_id uuid;
begin
  select default_period_id
  into v_period_id
  from public.rest_weeks
  where start_date = p_week_start;

  if v_period_id is not null then
    return v_period_id;
  end if;

  select id
  into v_period_id
  from public.rest_periods
  where is_active = true
  order by sort_order asc, created_at asc
  limit 1;

  return v_period_id;
end;
$$;

create or replace function public.init_employee_week_shifts(
  p_week_start date,
  p_employee_name text
)
returns jsonb
language plpgsql
as $$
declare
  v_trimmed_name text;
  v_end_date date;
  v_default_period_id uuid;
begin
  v_trimmed_name := trim(p_employee_name);

  if v_trimmed_name is null or char_length(v_trimmed_name) = 0 then
    return jsonb_build_object('success', false, 'message', '员工姓名不能为空');
  end if;

  select end_date
  into v_end_date
  from public.rest_weeks
  where start_date = p_week_start;

  if v_end_date is null then
    return jsonb_build_object('success', false, 'message', '当前排休周不存在');
  end if;

  v_default_period_id := public.get_default_period_id_for_week(p_week_start);

  insert into public.employee_week_shifts (week_start, work_date, employee_name, status, period_id)
  select p_week_start, dates.work_date, v_trimmed_name, 'work', v_default_period_id
  from generate_series(p_week_start, v_end_date, interval '1 day') as dates(work_date)
  on conflict (employee_name, work_date) do nothing;

  return jsonb_build_object('success', true, 'message', '已生成当前周班次');
end;
$$;

create or replace function public.update_employee_shift(
  p_week_start date,
  p_work_date date,
  p_employee_name text,
  p_status text,
  p_period_id uuid default null
)
returns jsonb
language plpgsql
as $$
declare
  v_trimmed_name text;
  v_limit integer;
  v_used integer;
  v_default_period_id uuid;
  v_current record;
begin
  v_trimmed_name := trim(p_employee_name);

  if v_trimmed_name is null or char_length(v_trimmed_name) = 0 then
    return jsonb_build_object('success', false, 'message', '员工姓名不能为空');
  end if;

  if p_status not in ('work', 'rest') then
    return jsonb_build_object('success', false, 'message', '状态无效');
  end if;

  perform public.init_employee_week_shifts(p_week_start, v_trimmed_name);

  select *
  into v_current
  from public.employee_week_shifts
  where week_start = p_week_start
    and work_date = p_work_date
    and employee_name = v_trimmed_name
  for update;

  if not found then
    return jsonb_build_object('success', false, 'message', '未找到对应班次记录');
  end if;

  if p_status = 'rest' then
    v_limit := public.ensure_default_day_limit(p_week_start, p_work_date);

    select count(*)
    into v_used
    from public.employee_week_shifts
    where week_start = p_week_start
      and work_date = p_work_date
      and status = 'rest'
      and id <> v_current.id;

    if v_used >= v_limit then
      return jsonb_build_object('success', false, 'message', '该日期排休名额已满');
    end if;

    update public.employee_week_shifts
    set status = 'rest',
        period_id = null
    where id = v_current.id;

    return jsonb_build_object('success', true, 'message', '已设为排休');
  end if;

  if p_period_id is null then
    v_default_period_id := public.get_default_period_id_for_week(p_week_start);
  else
    select id
    into v_default_period_id
    from public.rest_periods
    where id = p_period_id and is_active = true;
  end if;

  if v_default_period_id is null then
    return jsonb_build_object('success', false, 'message', '出勤时段无效');
  end if;

  update public.employee_week_shifts
  set status = 'work',
      period_id = v_default_period_id
  where id = v_current.id;

  return jsonb_build_object('success', true, 'message', '出勤时段已更新');
end;
$$;

alter table public.rest_periods enable row level security;
alter table public.rest_weeks enable row level security;
alter table public.rest_day_limits enable row level security;
alter table public.employee_week_shifts enable row level security;

drop policy if exists "public read periods" on public.rest_periods;
create policy "public read periods"
on public.rest_periods
for select
to anon, authenticated
using (true);

drop policy if exists "public write periods" on public.rest_periods;
create policy "public write periods"
on public.rest_periods
for all
to anon, authenticated
using (true)
with check (true);

drop policy if exists "public read weeks" on public.rest_weeks;
create policy "public read weeks"
on public.rest_weeks
for select
to anon, authenticated
using (true);

drop policy if exists "public write weeks" on public.rest_weeks;
create policy "public write weeks"
on public.rest_weeks
for all
to anon, authenticated
using (true)
with check (true);

drop policy if exists "public read day limits" on public.rest_day_limits;
create policy "public read day limits"
on public.rest_day_limits
for select
to anon, authenticated
using (true);

drop policy if exists "public write day limits" on public.rest_day_limits;
create policy "public write day limits"
on public.rest_day_limits
for all
to anon, authenticated
using (true)
with check (true);

drop policy if exists "public read employee shifts" on public.employee_week_shifts;
create policy "public read employee shifts"
on public.employee_week_shifts
for select
to anon, authenticated
using (true);

drop policy if exists "public write employee shifts" on public.employee_week_shifts;
create policy "public write employee shifts"
on public.employee_week_shifts
for all
to anon, authenticated
using (true)
with check (true);

grant usage on schema public to anon, authenticated;
grant all on public.rest_periods to anon, authenticated;
grant all on public.rest_weeks to anon, authenticated;
grant all on public.rest_day_limits to anon, authenticated;
grant all on public.employee_week_shifts to anon, authenticated;
grant execute on function public.ensure_default_day_limit(date, date) to anon, authenticated;
grant execute on function public.get_default_period_id_for_week(date) to anon, authenticated;
grant execute on function public.init_employee_week_shifts(date, text) to anon, authenticated;
grant execute on function public.update_employee_shift(date, date, text, text, uuid) to anon, authenticated;

-- 周名单表：绑定到 rest_weeks，删除周时级联删除
create table if not exists public.rest_week_members (
  id uuid primary key default gen_random_uuid(),
  week_id uuid not null references public.rest_weeks(id) on delete cascade,
  members text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (week_id)
);

drop trigger if exists trg_rest_week_members_updated_at on public.rest_week_members;
create trigger trg_rest_week_members_updated_at
before update on public.rest_week_members
for each row
execute function public.set_updated_at();

alter table public.rest_week_members enable row level security;

drop policy if exists "public read week members" on public.rest_week_members;
create policy "public read week members"
on public.rest_week_members
for select
to anon, authenticated
using (true);

drop policy if exists "public write week members" on public.rest_week_members;
create policy "public write week members"
on public.rest_week_members
for all
to anon, authenticated
using (true)
with check (true);

grant all on public.rest_week_members to anon, authenticated;

do $$
begin
  alter publication supabase_realtime add table public.rest_periods;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.rest_weeks;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.rest_day_limits;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.employee_week_shifts;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.rest_week_members;
exception
  when duplicate_object then null;
end $$;
