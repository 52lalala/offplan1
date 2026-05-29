-- ==========================================================
-- 排班系统数据库结构
-- 每次执行会清空所有表后重建
-- ==========================================================

-- ==================== 1. 扩展 ====================
create extension if not exists pgcrypto;

-- ==================== 2. 清空旧数据 ====================
drop table if exists public.rest_week_members cascade;
drop table if exists public.employee_week_shifts cascade;
drop table if exists public.rest_periods cascade;
drop table if exists public.rest_day_limits cascade;
drop table if exists public.rest_weeks cascade;

-- ==================== 3. 建表 ====================

create table public.rest_weeks (
  id uuid primary key default gen_random_uuid(),
  start_date date not null,
  end_date date not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);

create table public.rest_periods (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 30),
  start_time time not null,
  end_time time not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  week_id uuid not null references public.rest_weeks(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.rest_day_limits (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  rest_date date not null,
  max_slots integer not null check (max_slots >= 0 and max_slots <= 20),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (week_start, rest_date)
);

create table public.employee_week_shifts (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  work_date date not null,
  employee_name text not null check (char_length(trim(employee_name)) between 1 and 20),
  period_id uuid references public.rest_periods(id) on update cascade on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.rest_week_members (
  id uuid primary key default gen_random_uuid(),
  week_id uuid not null references public.rest_weeks(id) on delete cascade,
  members text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (week_id)
);

-- ==================== 4. 索引 ====================

create unique index idx_employee_shift_period
  on public.employee_week_shifts (employee_name, work_date, period_id)
  where period_id is not null;

create unique index idx_employee_shift_rest
  on public.employee_week_shifts (employee_name, work_date)
  where period_id is null;

create index idx_rest_periods_sort on public.rest_periods (sort_order, is_active);
create index idx_rest_weeks_active on public.rest_weeks (is_active, start_date desc);
create index idx_rest_day_limits_week_date on public.rest_day_limits (week_start, rest_date);
create index idx_employee_week_shifts_week_date on public.employee_week_shifts (week_start, work_date);
create index idx_employee_week_shifts_employee_week on public.employee_week_shifts (employee_name, week_start);

-- ==================== 5. 函数 ====================

-- 更新时间触发器
create or replace function public.set_updated_at()
returns trigger language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 级联删除周数据
create or replace function public.delete_related_week_data()
returns trigger language plpgsql
as $$
begin
  delete from public.employee_week_shifts where week_start = old.start_date;
  delete from public.rest_day_limits where week_start = old.start_date;
  return old;
end;
$$;

-- 确保每日休息名额存在（返回上限）
create or replace function public.ensure_default_day_limit(p_week_start date, p_rest_date date)
returns integer language plpgsql
as $$
declare
  v_max_slots integer;
  v_day integer;
begin
  select max_slots into v_max_slots
  from public.rest_day_limits
  where week_start = p_week_start and rest_date = p_rest_date;

  if found then return v_max_slots; end if;

  v_day := extract(dow from p_rest_date);
  v_max_slots := case when v_day in (0, 6) then 2 else 5 end;

  insert into public.rest_day_limits (week_start, rest_date, max_slots)
  values (p_week_start, p_rest_date, v_max_slots)
  on conflict (week_start, rest_date) do nothing;

  return v_max_slots;
end;
$$;

-- 初始化员工本周排班（仅首次调用时生效）
create or replace function public.init_employee_week_shifts(
  p_week_start date,
  p_employee_name text
)
returns jsonb language plpgsql
as $$
declare
  v_trimmed_name text;
  v_end_date date;
  v_week_id uuid;
begin
  v_trimmed_name := trim(p_employee_name);
  if v_trimmed_name is null or char_length(v_trimmed_name) = 0 then
    return jsonb_build_object('success', false, 'message', '员工姓名不能为空');
  end if;

  select rw.end_date, rw.id into v_end_date, v_week_id
  from public.rest_weeks rw where rw.start_date = p_week_start;

  if v_end_date is null then
    return jsonb_build_object('success', false, 'message', '当前排休周不存在');
  end if;

  if not exists (
    select 1 from public.rest_week_members rm
    join public.rest_weeks rw on rw.id = rm.week_id
    where rw.start_date = p_week_start
      and v_trimmed_name = any(string_to_array(rm.members, ' '))
  ) then
    return jsonb_build_object('success', false, 'message', '"' || v_trimmed_name || '" 不在当前周的人员名单中');
  end if;

  if exists (
    select 1 from public.employee_week_shifts
    where week_start = p_week_start and employee_name = v_trimmed_name
  ) then
    return jsonb_build_object('success', true, 'message', '已初始化');
  end if;

  insert into public.employee_week_shifts (week_start, work_date, employee_name, period_id)
  select p_week_start, dates.work_date, v_trimmed_name, p.id
  from generate_series(p_week_start, v_end_date, interval '1 day') as dates(work_date)
  cross join (
    select id from public.rest_periods
    where week_id = v_week_id and is_active = true
    order by sort_order asc
  ) p;

  return jsonb_build_object('success', true, 'message', '已生成当前周班次');
end;
$$;

-- 切换时段选择（已选→取消，未选→新增，达上限→自动踢出最旧选择）
create or replace function public.toggle_employee_period(
  p_week_start date,
  p_work_date date,
  p_employee_name text,
  p_period_id uuid
)
returns jsonb language plpgsql
as $$
declare
  v_trimmed_name text;
  v_week_id uuid;
  v_enabled_count integer;
  v_selected_count integer;
  v_evicted_name text;
  v_new_name text;
begin
  v_trimmed_name := trim(p_employee_name);
  if v_trimmed_name is null or char_length(v_trimmed_name) = 0 then
    return jsonb_build_object('success', false, 'message', '员工姓名不能为空');
  end if;

  if not exists (
    select 1 from public.rest_week_members rm
    join public.rest_weeks rw on rw.id = rm.week_id
    where rw.start_date = p_week_start
      and v_trimmed_name = any(string_to_array(rm.members, ' '))
  ) then
    return jsonb_build_object('success', false, 'message', '"' || v_trimmed_name || '" 不在当前周的人员名单中');
  end if;

  select id into v_week_id from public.rest_weeks where start_date = p_week_start;

  select count(*) into v_enabled_count
  from public.rest_periods where week_id = v_week_id and is_active = true;

  if exists (
    select 1 from public.employee_week_shifts
    where week_start = p_week_start and work_date = p_work_date
      and employee_name = v_trimmed_name and period_id = p_period_id
  ) then
    return jsonb_build_object('success', true, 'message', '');
  end if;

  select count(*) into v_selected_count
  from public.employee_week_shifts
  where week_start = p_week_start and work_date = p_work_date
    and employee_name = v_trimmed_name and period_id is not null;

  if v_selected_count >= v_enabled_count then
    select p.name into v_evicted_name
    from public.employee_week_shifts ews
    join public.rest_periods p on p.id = ews.period_id
    where ews.week_start = p_week_start
      and ews.work_date = p_work_date
      and ews.employee_name = v_trimmed_name
      and ews.period_id is not null
    order by ews.created_at asc
    limit 1;

    delete from public.employee_week_shifts
    where id = (
      select id from public.employee_week_shifts
      where week_start = p_week_start
        and work_date = p_work_date
        and employee_name = v_trimmed_name
        and period_id is not null
      order by created_at asc
      limit 1
    );
  end if;

  select name into v_new_name from public.rest_periods where id = p_period_id;

  delete from public.employee_week_shifts
  where week_start = p_week_start and work_date = p_work_date
    and employee_name = v_trimmed_name and period_id is null;

  insert into public.employee_week_shifts (week_start, work_date, employee_name, period_id)
  values (p_week_start, p_work_date, v_trimmed_name, p_period_id);

  if v_evicted_name is not null then
    return jsonb_build_object('success', true, 'message', '已选择' || v_new_name || '（已自动取消' || v_evicted_name || '）');
  else
    return jsonb_build_object('success', true, 'message', '已选择' || v_new_name);
  end if;
end;
$$;

-- 设置休息
create or replace function public.set_employee_rest(
  p_week_start date,
  p_work_date date,
  p_employee_name text
)
returns jsonb language plpgsql
as $$
declare
  v_trimmed_name text;
  v_limit integer;
  v_used integer;
begin
  v_trimmed_name := trim(p_employee_name);
  if v_trimmed_name is null or char_length(v_trimmed_name) = 0 then
    return jsonb_build_object('success', false, 'message', '员工姓名不能为空');
  end if;

  if not exists (
    select 1 from public.rest_week_members rm
    join public.rest_weeks rw on rw.id = rm.week_id
    where rw.start_date = p_week_start
      and v_trimmed_name = any(string_to_array(rm.members, ' '))
  ) then
    return jsonb_build_object('success', false, 'message', '"' || v_trimmed_name || '" 不在当前周的人员名单中');
  end if;

  v_limit := public.ensure_default_day_limit(p_week_start, p_work_date);

  select count(*) into v_used
  from public.employee_week_shifts
  where week_start = p_week_start and work_date = p_work_date and period_id is null;

  if v_used >= v_limit then
    return jsonb_build_object('success', false, 'message', '该日期排休名额已满');
  end if;

  delete from public.employee_week_shifts
  where week_start = p_week_start and work_date = p_work_date
    and employee_name = v_trimmed_name and period_id is not null;

  insert into public.employee_week_shifts (week_start, work_date, employee_name, period_id)
  values (p_week_start, p_work_date, v_trimmed_name, null)
  on conflict (employee_name, work_date) where period_id is null do nothing;

  return jsonb_build_object('success', true, 'message', '已设为排休');
end;
$$;

-- 克隆周时段（管理员新建周时使用）
create or replace function public.clone_week_periods(
  p_source_week_id uuid,
  p_target_week_id uuid
)
returns void language plpgsql
as $$
begin
  insert into public.rest_periods (name, start_time, end_time, sort_order, is_active, week_id)
  select name, start_time, end_time, sort_order, is_active, p_target_week_id
  from public.rest_periods
  where week_id = p_source_week_id;
end;
$$;

-- ==================== 6. 触发器 ====================

create trigger trg_rest_periods_updated_at before update on public.rest_periods
  for each row execute function public.set_updated_at();
create trigger trg_rest_weeks_updated_at before update on public.rest_weeks
  for each row execute function public.set_updated_at();
create trigger trg_rest_day_limits_updated_at before update on public.rest_day_limits
  for each row execute function public.set_updated_at();
create trigger trg_employee_week_shifts_updated_at before update on public.employee_week_shifts
  for each row execute function public.set_updated_at();
create trigger trg_rest_week_members_updated_at before update on public.rest_week_members
  for each row execute function public.set_updated_at();
create trigger trg_rest_weeks_delete_related before delete on public.rest_weeks
  for each row execute function public.delete_related_week_data();

-- ==================== 7. RLS ====================

alter table public.rest_periods enable row level security;
alter table public.rest_weeks enable row level security;
alter table public.rest_day_limits enable row level security;
alter table public.employee_week_shifts enable row level security;
alter table public.rest_week_members enable row level security;

create policy "public read" on public.rest_periods for select to anon, authenticated using (true);
create policy "public write" on public.rest_periods for all to anon, authenticated using (true) with check (true);
create policy "public read" on public.rest_weeks for select to anon, authenticated using (true);
create policy "public write" on public.rest_weeks for all to anon, authenticated using (true) with check (true);
create policy "public read" on public.rest_day_limits for select to anon, authenticated using (true);
create policy "public write" on public.rest_day_limits for all to anon, authenticated using (true) with check (true);
create policy "public read" on public.employee_week_shifts for select to anon, authenticated using (true);
create policy "public write" on public.employee_week_shifts for all to anon, authenticated using (true) with check (true);
create policy "public read" on public.rest_week_members for select to anon, authenticated using (true);
create policy "public write" on public.rest_week_members for all to anon, authenticated using (true) with check (true);

-- ==================== 8. 权限 ====================

grant usage on schema public to anon, authenticated;
grant all on public.rest_periods to anon, authenticated;
grant all on public.rest_weeks to anon, authenticated;
grant all on public.rest_day_limits to anon, authenticated;
grant all on public.employee_week_shifts to anon, authenticated;
grant all on public.rest_week_members to anon, authenticated;
grant execute on function public.ensure_default_day_limit(date, date) to anon, authenticated;
grant execute on function public.init_employee_week_shifts(date, text) to anon, authenticated;
grant execute on function public.toggle_employee_period(date, date, text, uuid) to anon, authenticated;
grant execute on function public.set_employee_rest(date, date, text) to anon, authenticated;
grant execute on function public.clone_week_periods(uuid, uuid) to anon, authenticated;

-- ==================== 9. Realtime ====================

alter publication supabase_realtime add table public.rest_periods;
alter publication supabase_realtime add table public.rest_weeks;
alter publication supabase_realtime add table public.rest_day_limits;
alter publication supabase_realtime add table public.employee_week_shifts;
alter publication supabase_realtime add table public.rest_week_members;

-- ==================== 10. 种子数据 ====================

insert into public.rest_weeks (start_date, end_date, is_active)
values ('2026-05-25'::date, '2026-05-31'::date, true);

insert into public.rest_periods (name, start_time, end_time, sort_order, is_active, week_id)
select '午高峰', '10:30:00'::time, '13:30:00'::time, 1, true, w.id
from public.rest_weeks w where w.start_date = '2026-05-25'::date
union all
select '晚高峰', '18:00:00'::time, '20:00:00'::time, 2, true, w.id
from public.rest_weeks w where w.start_date = '2026-05-25'::date;
