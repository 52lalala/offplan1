-- ==========================================================
-- 排班系统数据库结构（基于骑手意愿导入 + 协同排班）
-- 每次执行会清空所有表后重建
-- ==========================================================

-- ==================== 1. 扩展 ====================
create extension if not exists pgcrypto;

-- ==================== 2. 清空旧数据 ====================
drop table if exists public.rest_week_members cascade;
drop table if exists public.rest_periods cascade;
drop table if exists public.employee_week_shifts cascade;
drop table if exists public.rider_schedules cascade;
drop table if exists public.rider_week_rosters cascade;
drop table if exists public.time_slots cascade;
drop table if exists public.riders cascade;
drop table if exists public.rest_day_limits cascade;
drop table if exists public.rest_weeks cascade;
drop table if exists public.schedule_weeks cascade;

-- ==================== 3. 建表 ====================

-- 排班周
create table public.schedule_weeks (
  id uuid primary key default gen_random_uuid(),
  start_date date not null,
  end_date date not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);

-- 时段定义
create table public.time_slots (
  id uuid primary key default gen_random_uuid(),
  week_id uuid not null references public.schedule_weeks(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 30),
  start_time time not null,
  end_time time not null,
  sort_order integer not null default 0,
  is_selectable boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 骑手表
create table public.riders (
  rider_id text primary key,
  name text not null check (char_length(trim(name)) between 1 and 20),
  group_id text not null default '',
  group_name text not null default '',
  rider_type text not null default '',
  min_slots integer not null default 1 check (min_slots >= 0 and min_slots <= 10),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 每日排休名额
create table public.rest_day_limits (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  rest_date date not null,
  max_slots integer not null check (max_slots >= 0 and max_slots <= 50),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (week_start, rest_date)
);

-- 骑手排班明细
-- slot_id is null => 该骑手当天排休
-- slot_id is not null => is_selected 标记该时段是否出勤
create table public.rider_schedules (
  id uuid primary key default gen_random_uuid(),
  rider_id text not null references public.riders(rider_id) on delete cascade,
  week_id uuid not null references public.schedule_weeks(id) on delete cascade,
  work_date date not null,
  slot_id uuid references public.time_slots(id) on delete cascade,
  is_selected boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rider_id, work_date, slot_id)
);

-- ==================== 4. 索引 ====================

-- 每个骑手每天最多一条排休记录
create unique index idx_rs_rest on public.rider_schedules (rider_id, work_date) where slot_id is null;

-- 每个骑手每天每时段最多一条记录
create unique index idx_rs_slot on public.rider_schedules (rider_id, work_date, slot_id) where slot_id is not null;

create index idx_rs_week on public.rider_schedules (week_id);
create index idx_rs_rider_week on public.rider_schedules (rider_id, week_id);
create index idx_rs_work_date on public.rider_schedules (work_date);
create index idx_ts_week on public.time_slots (week_id, sort_order);
create index idx_rdl_week on public.rest_day_limits (week_start);
create index idx_sw_active on public.schedule_weeks (is_active, start_date desc);

-- ==================== 5. 函数 ====================

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 批量导入 XLS 数据（事务内完成）
-- p_data jsonb 格式：
-- {
--   "weekStart": "2026-06-01",
--   "weekEnd": "2026-06-07",
--   "group": {"id":"...","name":"..."},
--   "slots": [{"name":"午高峰","startTime":"10:30","endTime":"13:30","sortOrder":1}, ...],
--   "entries": [
--     {"riderId":"4598058","riderName":"龚传仓","date":"20260601","selections":[1,0,0,0,0,0]},
--     ...
--   ]
-- }
create or replace function public.import_xls_week(p_week_id uuid, p_data jsonb)
returns jsonb language plpgsql
as $$
declare
  v_week_start date;
  v_week_end date;
  v_group_id text;
  v_group_name text;
  v_slot jsonb;
  v_slot_ids uuid[];
  v_entry jsonb;
  v_selections jsonb;
  v_idx int;
  v_rider_id text;
  v_rider_name text;
  v_date text;
  v_all_zero boolean;
begin
  -- 解析基本信息
  v_week_start := (p_data->>'weekStart')::date;
  v_week_end := (p_data->>'weekEnd')::date;
  v_group_id := p_data->'group'->>'id';
  v_group_name := p_data->'group'->>'name';

  -- 清空该周旧数据
  delete from public.rider_schedules where week_id = p_week_id;
  delete from public.time_slots where week_id = p_week_id;

  -- 创建时段
  for v_slot in select * from jsonb_array_elements(p_data->'slots')
  loop
    insert into public.time_slots (week_id, name, start_time, end_time, sort_order, is_selectable)
    values (
      p_week_id,
      v_slot->>'name',
      (v_slot->>'startTime')::time,
      (v_slot->>'endTime')::time,
      (v_slot->>'sortOrder')::int,
      true
    );
  end loop;

  -- 导入排班条目
  for v_entry in select * from jsonb_array_elements(p_data->'entries')
  loop
    v_rider_id := v_entry->>'riderId';
    v_rider_name := v_entry->>'riderName';
    v_date := v_entry->>'date';
    v_selections := v_entry->'selections';

    -- 骑手 upsert
    insert into public.riders (rider_id, name, group_id, group_name)
    values (v_rider_id, v_rider_name, v_group_id, v_group_name)
    on conflict (rider_id) do update set
      name = v_rider_name,
      group_id = v_group_id,
      group_name = v_group_name;

    -- 逐时段插入
    v_all_zero := true;
    for v_idx in 0 .. jsonb_array_length(v_selections) - 1
    loop
      if (v_selections->>v_idx)::int = 1 then
        v_all_zero := false;
        insert into public.rider_schedules (rider_id, week_id, work_date, slot_id, is_selected)
        select v_rider_id, p_week_id, v_date::date, ts.id, true
        from public.time_slots ts
        where ts.week_id = p_week_id
        order by ts.sort_order
        limit 1 offset v_idx;
      end if;
    end loop;

    -- 全0 => 排休
    if v_all_zero then
      insert into public.rider_schedules (rider_id, week_id, work_date, slot_id, is_selected)
      values (v_rider_id, p_week_id, v_date::date, null, null)
      on conflict (rider_id, work_date) where slot_id is null do nothing;
    end if;
  end loop;

  return jsonb_build_object('success', true, 'message', '导入完成');
end;
$$;

-- 清空某周所有排班（保留时段和骑手）
create or replace function public.clear_week_schedules(p_week_id uuid)
returns jsonb language plpgsql
as $$
begin
  delete from public.rider_schedules where week_id = p_week_id;
  return jsonb_build_object('success', true, 'message', '已清空');
end;
$$;

-- 获取周的所有骑手（含排班统计）
create or replace function public.get_week_riders(p_week_id uuid)
returns jsonb language plpgsql
as $$
declare
  v_result jsonb;
begin
  select jsonb_agg(jsonb_build_object(
    'riderId', r.rider_id,
    'name', r.name,
    'groupId', r.group_id,
    'groupName', r.group_name,
    'minSlots', r.min_slots
  ) order by r.name)
  into v_result
  from public.riders r
  where exists (
    select 1 from public.rider_schedules rs
    where rs.rider_id = r.rider_id and rs.week_id = p_week_id
  );
  return coalesce(v_result, '[]'::jsonb);
end;
$$;

-- 获取周的所有时段
create or replace function public.get_week_slots(p_week_id uuid)
returns jsonb language plpgsql
as $$
declare
  v_result jsonb;
begin
  select jsonb_agg(jsonb_build_object(
    'id', ts.id,
    'name', ts.name,
    'startTime', ts.start_time,
    'endTime', ts.end_time,
    'sortOrder', ts.sort_order,
    'isSelectable', ts.is_selectable
  ) order by ts.sort_order)
  into v_result
  from public.time_slots ts
  where ts.week_id = p_week_id and ts.is_active = true;
  return coalesce(v_result, '[]'::jsonb);
end;
$$;

-- 管理员切换时段可选状态
create or replace function public.toggle_slot_selectable(p_slot_id uuid)
returns jsonb language plpgsql
as $$
declare
  v_new boolean;
begin
  update public.time_slots
  set is_selectable = not is_selectable
  where id = p_slot_id
  returning is_selectable into v_new;
  return jsonb_build_object('success', true, 'isSelectable', v_new);
end;
$$;

-- 管理员设置骑手最少时段数
create or replace function public.set_rider_min_slots(p_rider_id text, p_min_slots int)
returns jsonb language plpgsql
as $$
begin
  update public.riders set min_slots = p_min_slots where rider_id = p_rider_id;
  return jsonb_build_object('success', true);
end;
$$;

-- 骑手切换时段出勤状态
create or replace function public.toggle_rider_slot(
  p_rider_id text,
  p_week_id uuid,
  p_work_date date,
  p_slot_id uuid
)
returns jsonb language plpgsql
as $$
declare
  v_current boolean;
  v_slot_selectable boolean;
begin
  -- 检查时段是否可选
  select is_selectable into v_slot_selectable
  from public.time_slots where id = p_slot_id;

  if not v_slot_selectable then
    return jsonb_build_object('success', false, 'message', '该时段不可选');
  end if;

  -- 如果当天有排休记录，先删除
  delete from public.rider_schedules
  where rider_id = p_rider_id and work_date = p_work_date and slot_id is null;

  -- 获取当前状态
  select is_selected into v_current
  from public.rider_schedules
  where rider_id = p_rider_id and work_date = p_work_date and slot_id = p_slot_id;

  if v_current is true then
    -- 取消选择
    delete from public.rider_schedules
    where rider_id = p_rider_id and work_date = p_work_date and slot_id = p_slot_id;
    return jsonb_build_object('success', true, 'selected', false);
  else
    -- 选择
    insert into public.rider_schedules (rider_id, week_id, work_date, slot_id, is_selected)
    values (p_rider_id, p_week_id, p_work_date, p_slot_id, true)
    on conflict (rider_id, work_date, slot_id) where slot_id is not null
    do update set is_selected = true;
    return jsonb_build_object('success', true, 'selected', true);
  end if;
end;
$$;

-- 骑手设为排休
create or replace function public.set_rider_rest(
  p_rider_id text,
  p_week_id uuid,
  p_work_date date
)
returns jsonb language plpgsql
as $$
declare
  v_limit integer;
  v_used integer;
begin
  -- 检查排休名额
  select max_slots into v_limit
  from public.rest_day_limits
  where week_start = (select start_date from public.schedule_weeks where id = p_week_id)
    and rest_date = p_work_date;

  if v_limit is null then
    v_limit := 5;
  end if;

  select count(*) into v_used
  from public.rider_schedules
  where week_id = p_week_id and work_date = p_work_date and slot_id is null;

  if v_used >= v_limit then
    return jsonb_build_object('success', false, 'message', '该日期排休名额已满');
  end if;

  -- 删除该骑手当天的所有时段选择
  delete from public.rider_schedules
  where rider_id = p_rider_id and work_date = p_work_date and slot_id is not null;

  -- 插入排休记录
  insert into public.rider_schedules (rider_id, week_id, work_date, slot_id, is_selected)
  values (p_rider_id, p_week_id, p_work_date, null, null)
  on conflict (rider_id, work_date) where slot_id is null do nothing;

  return jsonb_build_object('success', true, 'message', '已设为排休');
end;
$$;

-- 取消排休
create or replace function public.cancel_rider_rest(
  p_rider_id text,
  p_week_id uuid,
  p_work_date date
)
returns jsonb language plpgsql
as $$
begin
  delete from public.rider_schedules
  where rider_id = p_rider_id and work_date = p_work_date and slot_id is null;
  return jsonb_build_object('success', true);
end;
$$;

-- 获取骑手某周数据
create or replace function public.get_rider_week(
  p_rider_id text,
  p_week_id uuid
)
returns jsonb language plpgsql
as $$
declare
  v_data jsonb;
begin
  select jsonb_agg(jsonb_build_object(
    'workDate', rs.work_date,
    'slotId', rs.slot_id,
    'isSelected', rs.is_selected
  ) order by rs.work_date, rs.slot_id)
  into v_data
  from public.rider_schedules rs
  where rs.rider_id = p_rider_id and rs.week_id = p_week_id;
  return coalesce(v_data, '[]'::jsonb);
end;
$$;

-- 获取某周每日排休人数
create or replace function public.get_week_rest_counts(p_week_id uuid)
returns jsonb language plpgsql
as $$
declare
  v_result jsonb;
begin
  select jsonb_object_agg(to_char(rs.work_date, 'YYYY-MM-DD'), cnt)
  into v_result
  from (
    select work_date, count(*) as cnt
    from public.rider_schedules
    where week_id = p_week_id and slot_id is null
    group by work_date
  ) rs;
  return coalesce(v_result, '{}'::jsonb);
end;
$$;

-- 获取某周每时段选中人数
create or replace function public.get_week_slot_counts(p_week_id uuid)
returns jsonb language plpgsql
as $$
declare
  v_result jsonb;
begin
  select jsonb_object_agg(to_char(rs.work_date, 'YYYY-MM-DD') || '-' || rs.slot_id::text, cnt)
  into v_result
  from (
    select work_date, slot_id, count(*) as cnt
    from public.rider_schedules
    where week_id = p_week_id and slot_id is not null and is_selected = true
    group by work_date, slot_id
  ) rs;
  return coalesce(v_result, '{}'::jsonb);
end;
$$;

-- 确保每日排休名额存在（返回上限）
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

-- 克隆周时段
create or replace function public.clone_week_slots(
  p_source_week_id uuid,
  p_target_week_id uuid
)
returns void language plpgsql
as $$
begin
  insert into public.time_slots (week_id, name, start_time, end_time, sort_order, is_selectable, is_active)
  select p_target_week_id, name, start_time, end_time, sort_order, is_selectable, is_active
  from public.time_slots
  where week_id = p_source_week_id;
end;
$$;

-- ==================== 6. 触发器 ====================

create trigger trg_sw_updated_at before update on public.schedule_weeks
  for each row execute function public.set_updated_at();
create trigger trg_ts_updated_at before update on public.time_slots
  for each row execute function public.set_updated_at();
create trigger trg_rdl_updated_at before update on public.rest_day_limits
  for each row execute function public.set_updated_at();
create trigger trg_rs_updated_at before update on public.rider_schedules
  for each row execute function public.set_updated_at();

-- ==================== 7. RLS ====================

alter table public.schedule_weeks enable row level security;
alter table public.time_slots enable row level security;
alter table public.riders enable row level security;
alter table public.rest_day_limits enable row level security;
alter table public.rider_schedules enable row level security;

create policy "public read" on public.schedule_weeks for select to anon, authenticated using (true);
create policy "public write" on public.schedule_weeks for all to anon, authenticated using (true) with check (true);
create policy "public read" on public.time_slots for select to anon, authenticated using (true);
create policy "public write" on public.time_slots for all to anon, authenticated using (true) with check (true);
create policy "public read" on public.riders for select to anon, authenticated using (true);
create policy "public write" on public.riders for all to anon, authenticated using (true) with check (true);
create policy "public read" on public.rest_day_limits for select to anon, authenticated using (true);
create policy "public write" on public.rest_day_limits for all to anon, authenticated using (true) with check (true);
create policy "public read" on public.rider_schedules for select to anon, authenticated using (true);
create policy "public write" on public.rider_schedules for all to anon, authenticated using (true) with check (true);

-- ==================== 8. 权限 ====================

grant usage on schema public to anon, authenticated;
grant all on public.schedule_weeks to anon, authenticated;
grant all on public.time_slots to anon, authenticated;
grant all on public.riders to anon, authenticated;
grant all on public.rest_day_limits to anon, authenticated;
grant all on public.rider_schedules to anon, authenticated;

grant execute on function public.import_xls_week to anon, authenticated;
grant execute on function public.clear_week_schedules to anon, authenticated;
grant execute on function public.get_week_riders to anon, authenticated;
grant execute on function public.get_week_slots to anon, authenticated;
grant execute on function public.toggle_slot_selectable to anon, authenticated;
grant execute on function public.set_rider_min_slots to anon, authenticated;
grant execute on function public.toggle_rider_slot to anon, authenticated;
grant execute on function public.set_rider_rest to anon, authenticated;
grant execute on function public.cancel_rider_rest to anon, authenticated;
grant execute on function public.get_rider_week to anon, authenticated;
grant execute on function public.get_week_rest_counts to anon, authenticated;
grant execute on function public.get_week_slot_counts to anon, authenticated;
grant execute on function public.ensure_default_day_limit to anon, authenticated;
grant execute on function public.clone_week_slots to anon, authenticated;

-- ==================== 9. Realtime ====================

alter publication supabase_realtime add table public.schedule_weeks;
alter publication supabase_realtime add table public.time_slots;
alter publication supabase_realtime add table public.riders;
alter publication supabase_realtime add table public.rest_day_limits;
alter publication supabase_realtime add table public.rider_schedules;
