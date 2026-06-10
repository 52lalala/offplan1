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
drop table if exists public.week_import_snapshots cascade;
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
  name text not null default '',
  start_date date not null,
  end_date date not null,
  is_active boolean not null default false,
  required_slots int not null default 3 check (required_slots >= 0 and required_slots <= 10),
  default_slot_ids uuid[] default null,
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
  rider_id text not null,
  week_id uuid not null references public.schedule_weeks(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 20),
  group_id text not null default '',
  group_name text not null default '',
  rider_type text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (rider_id, week_id)
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
  rider_id text not null,
  week_id uuid not null references public.schedule_weeks(id) on delete cascade,
  work_date date not null,
  slot_id uuid references public.time_slots(id) on delete cascade,
  is_selected boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rider_id, work_date, slot_id),
  foreign key (rider_id, week_id) references public.riders(rider_id, week_id) on delete cascade
);

-- XLS 导入快照（用于导出原始模板）
create table public.week_import_snapshots (
  week_id uuid primary key references public.schedule_weeks(id) on delete cascade,
  header jsonb not null,
  rows jsonb not null,
  base_columns integer not null,
  slot_labels jsonb not null,
  slot_indexes jsonb not null,
  created_at timestamptz not null default now()
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
create index idx_riders_week on public.riders (week_id);
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
-- 会重置该周的时段、排班记录，并保存原始导入快照
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
  v_group_id text;
  v_group_name text;
  v_slot jsonb;
  v_entry jsonb;
  v_rider_id text;
  v_rider_name text;
  v_slot_ids uuid[];
  v_slot_idx integer;
  v_selection integer;
  v_work_date date;
begin
  v_group_id := p_data->'group'->>'id';
  v_group_name := p_data->'group'->>'name';

  delete from public.week_import_snapshots where week_id = p_week_id;
  delete from public.rider_schedules where week_id = p_week_id;
  delete from public.time_slots where week_id = p_week_id;

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

  select array_agg(id order by sort_order) into v_slot_ids
  from public.time_slots where week_id = p_week_id;

  -- 导入骑手名单，并根据原始 0/1 填充初始排班
  for v_entry in select * from jsonb_array_elements(p_data->'entries')
  loop
    v_rider_id := v_entry->>'riderId';
    v_rider_name := v_entry->>'riderName';

    if v_rider_id is not null and v_rider_name is not null then
      insert into public.riders (rider_id, week_id, name, group_id, group_name)
      values (v_rider_id, p_week_id, v_rider_name, v_group_id, v_group_name)
      on conflict (rider_id, week_id) do update set
        name = v_rider_name,
        group_id = v_group_id,
        group_name = v_group_name;

      if v_slot_ids is not null then
        v_work_date := to_date(v_entry->>'date', 'YYYYMMDD');
        if v_work_date is not null then
          for v_slot_idx in 1..coalesce(array_length(v_slot_ids, 1), 0)
          loop
            v_selection := coalesce((v_entry->'selections'->>(v_slot_idx - 1)), '0')::int;
            if v_selection = 1 then
              insert into public.rider_schedules (rider_id, week_id, work_date, slot_id, is_selected)
              values (v_rider_id, p_week_id, v_work_date, v_slot_ids[v_slot_idx], true)
              on conflict (rider_id, work_date, slot_id) where slot_id is not null
              do update set is_selected = true;
            end if;
          end loop;
        end if;
      end if;
    end if;
  end loop;

  if coalesce(jsonb_array_length(p_data->'snapshot'->'header'), 0) > 0 then
    insert into public.week_import_snapshots (week_id, header, rows, base_columns, slot_labels, slot_indexes)
    values (
      p_week_id,
      coalesce(p_data->'snapshot'->'header', '[]'::jsonb),
      coalesce(p_data->'snapshot'->'rows', '[]'::jsonb),
      coalesce((p_data->>'baseColumnCount')::int, 6),
      coalesce(p_data->'slotLabels', '[]'::jsonb),
      coalesce(p_data->'slotColumnIndexes', '[]'::jsonb)
    )
    on conflict (week_id) do update set
      header = excluded.header,
      rows = excluded.rows,
      base_columns = excluded.base_columns,
      slot_labels = excluded.slot_labels,
      slot_indexes = excluded.slot_indexes,
      created_at = now();
  end if;

  return jsonb_build_object('success', true, 'message', '导入完成（已更新骑手名单、时段与初始选择）');
end;
$$;

create or replace function public.export_xls_week(p_week_id uuid)
returns jsonb language plpgsql
as $$
declare
  v_snapshot record;
  header_text text[];
  slot_labels text[];
  slot_col_positions int[];
  base_columns integer;
  header_len integer;
  slot_count integer;
  result_rows jsonb := '[]'::jsonb;
  row_json jsonb;
  cell record;
  arr text[];
  rider_col integer;
  date_col integer;
  rider_id text;
  date_key text;
  slot_json jsonb;
  selection_map jsonb := '{}'::jsonb;
  map_key text;
  idx integer;
  col_index integer;
  v_slot_ids uuid[];
  fallback boolean := false;
  start_date date;
  end_date date;
  cur_date date;
  rider_rec record;
begin
  select array_agg(ts.id order by ts.sort_order) into v_slot_ids
  from public.time_slots ts where ts.week_id = p_week_id;

  select jsonb_object_agg(key, value) into selection_map
  from (
    select rs.rider_id || '_' || to_char(rs.work_date, 'YYYYMMDD') as key,
           jsonb_object_agg(array_idx::text, to_jsonb((rs.is_selected is true)::int)) as value
    from (
      select rs.rider_id, rs.work_date, rs.is_selected, rs.slot_id,
             array_position(v_slot_ids, rs.slot_id) as array_idx
      from public.rider_schedules rs
      join public.time_slots ts on ts.id = rs.slot_id
      where rs.week_id = p_week_id and rs.slot_id is not null
    ) rs
    group by rs.rider_id, rs.work_date
  ) s;
  if selection_map is null then
    selection_map := '{}'::jsonb;
  end if;

  select * into v_snapshot from public.week_import_snapshots where week_id = p_week_id;

  if v_snapshot is null then
    fallback := true;
    select start_date, end_date into start_date, end_date
    from public.schedule_weeks where id = p_week_id;

    header_text := ARRAY['管理组ID', '管理组名称', '骑手ID', '骑手姓名', '日期', '骑手类型'];
    base_columns := array_length(header_text, 1);

    slot_labels := ARRAY[]::text[];
    if v_slot_ids is not null then
      select array_agg(ts.name || '|' || to_char(ts.start_time, 'HH24:MI') || '-' || to_char(ts.end_time, 'HH24:MI')
             order by ts.sort_order)
      into slot_labels
      from public.time_slots ts
      where ts.week_id = p_week_id;
    end if;

    slot_count := coalesce(array_length(slot_labels, 1), 0);
    slot_col_positions := ARRAY(SELECT base_columns + i - 1 FROM generate_series(1, slot_count) g(i));
    header_text := header_text || slot_labels;
    header_len := array_length(header_text, 1);
    rider_col := 3;
    date_col := 5;

    if start_date is null or end_date is null then
      return jsonb_build_object(
        'header', to_jsonb(header_text),
        'rows', '[]'::jsonb,
        'slotLabels', to_jsonb(slot_labels),
        'slotColumnIndexes', to_jsonb(slot_col_positions),
        'baseColumns', base_columns,
        'generated', true
      );
    end if;

    for rider_rec in
      select rider_id, name, group_id, group_name, rider_type
      from public.riders where week_id = p_week_id
      order by name
    loop
      cur_date := start_date;

      while cur_date <= end_date loop
        arr := array_fill(''::text, ARRAY[header_len]);
        arr[1] := coalesce(rider_rec.group_id, '');
        arr[2] := coalesce(rider_rec.group_name, '');
        arr[3] := coalesce(rider_rec.rider_id, '');
        arr[4] := coalesce(rider_rec.name, '');
        arr[5] := to_char(cur_date, 'YYYYMMDD');
        arr[6] := coalesce(rider_rec.rider_type, '');
        map_key := coalesce(rider_rec.rider_id, '') || '_' || to_char(cur_date, 'YYYYMMDD');
        slot_json := coalesce(selection_map -> map_key, '{}'::jsonb);
        for idx in 1..slot_count loop
          arr[base_columns + idx] := coalesce(slot_json->>(idx::text), '0');
        end loop;
        result_rows := result_rows || jsonb_build_array(to_jsonb(arr));
        cur_date := cur_date + interval '1 day';
      end loop;
    end loop;

    return jsonb_build_object(
      'header', to_jsonb(header_text),
      'rows', result_rows,
      'slotLabels', to_jsonb(slot_labels),
      'slotColumnIndexes', to_jsonb(slot_col_positions),
      'baseColumns', base_columns,
      'generated', true
    );
  end if;

  select array_agg(value order by ord) into header_text
  from jsonb_array_elements_text(v_snapshot.header) with ordinality as t(value, ord);
  select array_agg((value)::int order by ord) into slot_col_positions
  from jsonb_array_elements_text(v_snapshot.slot_indexes) with ordinality as t(value, ord);
  select array_agg(value order by ord) into slot_labels
  from jsonb_array_elements_text(v_snapshot.slot_labels) with ordinality as t(value, ord);

  base_columns := coalesce(v_snapshot.base_columns, 6);
  header_len := coalesce(array_length(header_text, 1), 0);
  slot_count := coalesce(array_length(slot_col_positions, 1), 0);
  rider_col := coalesce(array_position(header_text, '骑手ID'), 3);
  date_col := coalesce(array_position(header_text, '日期'), 5);

  for row_json in select value from jsonb_array_elements(v_snapshot.rows)
  loop
    arr := array_fill(''::text, ARRAY[header_len]);
    for cell in select value, ord from jsonb_array_elements_text(row_json) with ordinality as t(value, ord)
    loop
      if cell.ord <= header_len then
        arr[cell.ord] = cell.value;
      end if;
    end loop;

    rider_id := coalesce(arr[rider_col], '');
    date_key := coalesce(arr[date_col], '');
    map_key := rider_id || '_' || date_key;
    slot_json := coalesce(selection_map -> map_key, '{}'::jsonb);

    for idx in 1..slot_count loop
      col_index := slot_col_positions[idx] + 1;
      if col_index between 1 and header_len then
        arr[col_index] := coalesce(slot_json->>(idx::text), '0');
      end if;
    end loop;

    result_rows := result_rows || jsonb_build_array(to_jsonb(arr));
  end loop;

  return jsonb_build_object(
    'header', to_jsonb(header_text),
    'rows', result_rows,
    'slotLabels', to_jsonb(slot_labels),
    'slotColumnIndexes', to_jsonb(slot_col_positions),
    'baseColumns', base_columns,
    'generated', false
  );
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
  v_required_slots int;
begin
  select required_slots into v_required_slots from public.schedule_weeks where id = p_week_id;

  select jsonb_agg(jsonb_build_object(
    'riderId', r.rider_id,
    'name', r.name,
    'groupId', r.group_id,
    'groupName', r.group_name,
    'requiredSlots', v_required_slots
  ) order by r.name)
  into v_result
  from public.riders r
  where r.week_id = p_week_id;
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

-- 管理员设置每周必须选时段数
create or replace function public.set_week_required_slots(p_week_id uuid, p_required_slots int)
returns jsonb language plpgsql
as $$
begin
  update public.schedule_weeks set required_slots = p_required_slots where id = p_week_id;
  return jsonb_build_object('success', true);
end;
$$;

-- 管理员设置默认时段
create or replace function public.set_week_default_slots(p_week_id uuid, p_default_slot_ids uuid[])
returns jsonb language plpgsql
as $$
begin
  update public.schedule_weeks set default_slot_ids = p_default_slot_ids where id = p_week_id;
  return jsonb_build_object('success', true);
end;
$$;

-- 骑手切换时段（单时段模式：原子性地取消旧的并选择新的）
create or replace function public.switch_rider_slot(
  p_rider_id text,
  p_week_id uuid,
  p_work_date date,
  p_old_slot_id uuid,
  p_new_slot_id uuid
)
returns jsonb language plpgsql
as $$
declare
  v_new_slot_selectable boolean;
begin
  -- 检查新时段是否可选
  select is_selectable into v_new_slot_selectable
  from public.time_slots where id = p_new_slot_id;

  if not v_new_slot_selectable then
    return jsonb_build_object('success', false, 'message', '该时段不可选');
  end if;

  -- 如果当天有排休记录，先删除
  delete from public.rider_schedules
  where rider_id = p_rider_id and work_date = p_work_date and slot_id is null;

  -- 删除旧时段
  delete from public.rider_schedules
  where rider_id = p_rider_id and work_date = p_work_date and slot_id = p_old_slot_id;

  -- 选择新时段
  insert into public.rider_schedules (rider_id, week_id, work_date, slot_id, is_selected)
  values (p_rider_id, p_week_id, p_work_date, p_new_slot_id, true)
  on conflict (rider_id, work_date, slot_id) where slot_id is not null
  do update set is_selected = true;

  return jsonb_build_object('success', true, 'selected', true);
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
  v_required_slots int;
  v_current_selected_count int;
begin
  -- 检查时段是否可选
  select is_selectable into v_slot_selectable
  from public.time_slots where id = p_slot_id;

  if not v_slot_selectable then
    return jsonb_build_object('success', false, 'message', '该时段不可选');
  end if;

  -- 获取该周必须选时段数
  select required_slots into v_required_slots
  from public.schedule_weeks where id = p_week_id;

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
    -- 选择前检查是否已达到上限
    if v_required_slots > 0 then
      select count(*) into v_current_selected_count
      from public.rider_schedules
      where rider_id = p_rider_id and work_date = p_work_date and slot_id is not null and is_selected = true;

      if v_current_selected_count >= v_required_slots then
        return jsonb_build_object('success', false, 'message', '每天只能选择 ' || v_required_slots || ' 个时段');
      end if;
    end if;

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
alter table public.week_import_snapshots enable row level security;

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
create policy "public read" on public.week_import_snapshots for select to anon, authenticated using (true);
create policy "public write" on public.week_import_snapshots for all to anon, authenticated using (true) with check (true);

-- ==================== 8. 权限 ====================

grant usage on schema public to anon, authenticated;
grant all on public.schedule_weeks to anon, authenticated;
grant all on public.time_slots to anon, authenticated;
grant all on public.riders to anon, authenticated;
grant all on public.rest_day_limits to anon, authenticated;
grant all on public.rider_schedules to anon, authenticated;
grant all on public.week_import_snapshots to anon, authenticated;

grant execute on function public.import_xls_week to anon, authenticated;
grant execute on function public.export_xls_week to anon, authenticated;
grant execute on function public.clear_week_schedules to anon, authenticated;
grant execute on function public.get_week_riders to anon, authenticated;
grant execute on function public.get_week_slots to anon, authenticated;
grant execute on function public.toggle_slot_selectable to anon, authenticated;
grant execute on function public.set_week_required_slots to anon, authenticated;
grant execute on function public.set_week_default_slots to anon, authenticated;
grant execute on function public.switch_rider_slot to anon, authenticated;
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
